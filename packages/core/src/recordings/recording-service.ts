import type { LocalTranscriptionModelId } from '../ai/local-transcription-models.ts'
import type { LocalTranscriptionService } from '../ai/local-transcription-service.ts'
import { AUDIO_MEMOS_NOTE_TITLE } from '../audio/audio-memo-transcription-service.ts'
import type { BacklinkTargetService } from '../capture/backlink-target-service.ts'
import type { CalendarEvent, CalendarService } from '../calendar/calendar-service.ts'
import { canReadCalendars } from '../calendar/commands.ts'
import { dayRange, defaultAttendees } from '../calendar/events.ts'
import type { ContactsService } from '../contacts/contacts-service.ts'
import {
  MEETINGS_HEADING,
  type MeetingAttendee,
  type MeetingService,
} from '../contacts/meeting-service.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import type { GraphRole } from '../graph/graph-session.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { patchNote } from '../graph/patch-note.ts'
import { dailyPath } from '../graph/paths.ts'
import { wikiLinkSafe } from '../markdown/edit.ts'
import { parseNote } from '../markdown/extract.ts'
import { sectionEnd, topLevelHeadings } from '../markdown/heading-blocks.ts'
import { appendListItem } from '../markdown/task-ast.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type {
  BackgroundReconciler,
  BackgroundReconcilerFactory,
} from '../reconcile/background-reconciler.ts'
import { isSilentStop, type ReconcileStop } from '../reconcile/reconcile.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { pickMeetingEvent } from './event-match.ts'
import type { FinishedRecording, RecorderService, RecordingChannels } from './recorder-service.ts'
import {
  dropEchoRepeats,
  mergeTurns,
  recordingIdentity,
  recordingTitle,
  renderRecordingTranscript,
  type RecordingIdentity,
  type RecordingSegment,
} from './transcript.ts'

/**
 * What each watchdog warning tells the user.
 */
const WARNING_MESSAGES: Readonly<Record<string, string>> = {
  noAudio:
    'No audio is arriving. Check Microphone and Screen & System Audio Recording for Reflect in System Settings → Privacy & Security.',
  microphoneSilent: 'The microphone has been silent for a while. Is it muted?',
  idle: 'Nothing has been heard for five minutes. The recording stops on its own after fifteen.',
  captureFailed: 'Recording stopped working after an audio device change. Retrying.',
  writeFailed: 'The recording could not be saved. Check the free disk space.',
  startFailed: 'The recording could not start.',
}

const NO_MODEL_MESSAGE =
  'The recording is saved. Download an on-device transcription model under Settings → Audio memos to transcribe it.'

export interface ReconcileRecordingsInput {
  /**
   * `GraphInfo.generation`: pins every note read and write.
   */
  generation: number
  /**
   * Absolute root of the open graph, to write the archive path relative to it.
   */
  graphRoot: string | null
  /**
   * The on-device model; recordings always transcribe on the device.
   */
  localModel: LocalTranscriptionModelId
  /**
   * Spoken languages as ISO 639 codes; empty detects any.
   */
  transcriptionLanguages: readonly string[]
  /**
   * The user's transcription helper text.
   */
  transcriptionPrompt: string
  /**
   * The calendar integration's switch.
   */
  calendarEnabled: boolean
  /**
   * The enabled calendars.
   */
  calendarIds: readonly string[]
  /**
   * The contacts gate, as the add-meeting dialog computes it.
   */
  lookupContacts: boolean
  /**
   * Absolute folder the archived `.m4a` files go to.
   */
  recordingsFolder: string
  /**
   * The event's start time as the daily line shows it (`9:00am`).
   */
  formatStartTime: (startsAt: Date) => string
  /**
   * Abort gate, checked between steps (graph switch / unmount).
   */
  isStale?: () => boolean
  /**
   * Observes how many recordings wait, before work starts.
   */
  onPending?: (count: number) => void
}

export interface ReconcileRecordingsOutcome {
  /**
   * Transcript notes written in this pass.
   */
  written: string[]
  stopped: ReconcileStop | null
}

/**
 * What the open {@link RecordingSession} shows of itself.
 */
export interface RecordingState {
  /**
   * Stopped recordings are being transcribed and written.
   */
  readonly transcribing: boolean
  /**
   * The transcript note written most recently, until dismissed.
   */
  readonly lastTranscript: string | null
}

export interface RecordingSessionOptions {
  /**
   * The open graph's generation: transcripts land in this graph.
   */
  generation: number
  /**
   * The open graph's absolute root.
   */
  root: string
  /**
   * The event's start time as the daily line shows it, in the user's time format.
   */
  formatStartTime: (startsAt: Date) => string
}

/**
 * The background lifecycle that turns stopped recordings into transcript
 * notes, for one graph session: a pass runs at launch for recordings left by
 * an earlier session, whenever a recording stops, and on window focus, which
 * retries an archive folder that was unavailable. It also pushes the menu
 * bar and shortcut settings to the native recorder and reports its watchdog
 * warnings. In a note window it does nothing: two would write every
 * transcript twice.
 */
export interface RecordingSession {
  /**
   * Attach the triggers and run the launch pass. Its progress shows in
   * {@link RecordingService.getState} until it is disposed.
   */
  start(): void
  /**
   * Request a pass; coalesces while one runs.
   */
  schedule(): void
  /**
   * Tear down triggers and abort an in-flight pass at its next gate.
   */
  dispose(): void
}

export interface RecordingServiceDeps {
  readonly recorder: RecorderService
  readonly noteFile: NoteFileService
  readonly backlinkTarget: BacklinkTargetService
  readonly calendar: CalendarService
  readonly meetings: MeetingService
  readonly contacts: ContactsService
  readonly localTranscription: LocalTranscriptionService
  readonly settings: SettingsService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly progress: ProgressPort
  readonly role: GraphRole
  readonly logger: LoggerService
}

/**
 * Meeting recordings on the Mac (docs/recording.md): finish stopped
 * recordings by transcribing both channels on the device, writing the
 * transcript note under `inbox/recordings/`, linking it from the day's note,
 * then archiving the audio and clearing staging. A recording that overlaps a
 * calendar event is a meeting: it goes under `## Meetings` with the event's
 * attendees (the same line the events panel writes) and a transcript link.
 * Any other recording is a memo and joins `## [[Audio memos]]`, titled from
 * its first words, as audio memos always have been.
 *
 * Raw-first like audio memos: the recording sits in local staging until every
 * step has succeeded, and each step is idempotent, so a failed recording (model
 * not downloaded, a write conflict, an offline archive folder) simply retries
 * on the next trigger, while the recordings after it still go ahead. The
 * transcript link in the daily note is the tombstone: a recording whose link
 * exists is only archived, never written again, so deleting the transcript
 * note doesn't bring it back.
 *
 * Privacy: recording, transcription, and archiving are all local. Calendar
 * and contacts are read through the OS, as the events panel reads them.
 */
export interface RecordingService {
  /**
   * One pass over every stopped recording, oldest first. Never throws: the
   * first failure is reported as `stopped` after the later recordings had
   * their turn.
   */
  reconcile(input: ReconcileRecordingsInput): Promise<ReconcileRecordingsOutcome>
  /**
   * Build the recording lifecycle for one graph session. `dispose()` is terminal.
   */
  openSession(options: RecordingSessionOptions): RecordingSession
  /**
   * What the started session shows: idle while none runs. The same object
   * until something changes.
   */
  getState: () => RecordingState
  subscribe: (listener: () => void) => Unlisten
  /**
   * Clear {@link RecordingState.lastTranscript}.
   */
  dismissTranscript(): void
}

/**
 * Where a recording's archive goes, and how its note refers to it.
 */
function archiveLocation(
  identity: RecordingIdentity,
  folder: string,
  graphRoot: string | null,
): { destination: string; reference: string } {
  const destination = `${folder.replace(/\/+$/, '')}/${identity.base}.m4a`
  const root = graphRoot?.replace(/\/+$/, '')
  const reference =
    root !== undefined && destination.startsWith(`${root}/`)
      ? destination.slice(root.length + 1)
      : destination
  return { destination, reference }
}

/**
 * The transcript link is the tombstone; see the service doc.
 */
function hasTranscriptLink(source: string, identity: RecordingIdentity): boolean {
  return source.includes(`[[${identity.base}`)
}

/**
 * Does the day's `## Meetings` section already mention `title`? A one-off
 * meeting added from the events panel is plain text (no link to match), and
 * writing it again would duplicate the line the user already has.
 */
function meetingsSectionMentions(source: string, title: string): boolean {
  const { headings } = parseNote({ path: '', source })
  const sectionHeadings = topLevelHeadings(headings)
  const heading = sectionHeadings.find(
    (candidate) => candidate.text.toLowerCase() === MEETINGS_HEADING.toLowerCase(),
  )
  if (heading === undefined) {
    return false
  }
  const section = source.slice(heading.to, sectionEnd(sectionHeadings, heading, source.length))
  return section.toLowerCase().includes(title.toLowerCase())
}

/**
 * The vocabulary hint: the user's text, then the meeting's own names, which
 * are exactly the words a speech model tends to misspell.
 */
function transcriptionHint(
  prompt: string,
  event: CalendarEvent | null,
  attendees: readonly MeetingAttendee[],
): string {
  const names = [event?.title.trim() ?? '', ...attendees.map((attendee) => attendee.name)]
  return [prompt.trim(), names.filter((name) => name !== '').join(', ')]
    .filter((part) => part !== '')
    .join('\n')
}

function speakerSegments(channels: RecordingChannels): {
  me: RecordingSegment[]
  them: RecordingSegment[]
} {
  const timed =
    (speaker: RecordingSegment['speaker']) =>
    (segment: { startMs: number; endMs: number; text: string }): RecordingSegment => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      speaker,
      text: segment.text,
    })
  return { me: channels.me.map(timed('me')), them: channels.them.map(timed('them')) }
}

const IDLE_STATE: RecordingState = { transcribing: false, lastTranscript: null }

interface RecordingSessionDeps {
  readonly recorder: RecorderService
  readonly contacts: ContactsService
  readonly localTranscription: LocalTranscriptionService
  readonly settings: SettingsService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly progress: ProgressPort
  readonly logger: LoggerService
  readonly mainWindow: boolean
  readonly reconcile: (input: ReconcileRecordingsInput) => Promise<ReconcileRecordingsOutcome>
  /**
   * Publish this session's progress as the service state.
   */
  readonly update: (session: RecordingSession, patch: Partial<RecordingState>) => void
  /**
   * This session ended: the service state returns to idle.
   */
  readonly release: (session: RecordingSession) => void
}

class RecordingSessionImpl implements RecordingSession {
  readonly #deps: RecordingSessionDeps
  readonly #options: RecordingSessionOptions
  readonly #loop: BackgroundReconciler
  #started = false
  /**
   * Last surfaced stop: focus retries must not repeat the same failure.
   */
  #surfacedStop: string | null = null
  /**
   * The configuration last pushed to the native recorder, as a key.
   */
  #pushedConfig: string | null = null

  constructor(deps: RecordingSessionDeps, options: RecordingSessionOptions) {
    this.#deps = deps
    this.#options = options
    this.#loop = deps.reconcilers.create({
      pass: (isStale) => this.#pass(isStale),
      onSettled: () => {
        deps.update(this, { transcribing: false })
      },
    })
  }

  start(): void {
    const { recorder, settings, progress, mainWindow } = this.#deps
    if (!mainWindow || this.#started || this.#loop.isStale()) {
      return
    }
    this.#started = true
    // Native settings are app-wide, pushed whenever they or the recorder's
    // support change; the recorder store is followed for as long as this runs.
    const pushConfig = (): void => {
      this.#pushConfig()
    }
    this.#loop.onDispose(recorder.subscribe(pushConfig))
    this.#loop.onDispose(settings.subscribe(pushConfig))
    pushConfig()
    this.#loop.onDispose(
      recorder.onWarning((code) => {
        progress.start('Recording').warn(WARNING_MESSAGES[code] ?? code)
      }),
    )
    this.#loop.onDispose(
      recorder.onFinished(() => {
        this.#warnWithoutModel()
        this.#loop.schedule()
      }),
    )
    this.#loop.onDispose(() => {
      this.#deps.release(this)
    })
    this.#loop.schedule()
    this.#loop.retryOnWake()
  }

  schedule(): void {
    if (this.#started) {
      this.#loop.schedule()
    }
  }

  dispose(): void {
    this.#loop.dispose()
  }

  /**
   * The recordings folder the archive goes to: the chosen one, else the
   * recorder's default.
   */
  #recordingsFolder(): string {
    return (
      this.#deps.settings.get().recordingsFolder ||
      this.#deps.recorder.getState().defaultRecordingsFolder
    )
  }

  #pushConfig(): void {
    const { recorder, settings, progress } = this.#deps
    if (!recorder.getState().supported) {
      return
    }
    const current = settings.get()
    const config = {
      menuBar: current.recordingMenuBar,
      shortcut: current.recordingShortcut,
      recordingsFolder: this.#recordingsFolder(),
    }
    const key = JSON.stringify(config)
    if (key === this.#pushedConfig) {
      return
    }
    this.#pushedConfig = key
    recorder.configure(config).catch((cause: unknown) => {
      progress.fail('Recording shortcut', errorMessage(cause))
    })
  }

  /**
   * A recording stopped without a model to transcribe it: say it is saved.
   */
  #warnWithoutModel(): void {
    const { localTranscription, settings, progress, logger } = this.#deps
    localTranscription.status(settings.get().localTranscriptionModel).then(
      (model) => {
        if (model.status !== 'ready') {
          progress.start('Recording').warn(NO_MODEL_MESSAGE)
        }
      },
      (cause: unknown) => {
        logger.error('recording model status failed:', cause)
      },
    )
  }

  #surfaceStop(stopped: ReconcileStop | null): void {
    if (stopped === null) {
      this.#surfacedStop = null
      return
    }
    if (isSilentStop(stopped) || this.#surfacedStop === stopped.message) {
      return
    }
    this.#surfacedStop = stopped.message
    this.#deps.progress.fail('Transcribing recording', stopped.message)
  }

  async #pass(isStale: () => boolean): Promise<void> {
    const { contacts, settings, reconcile } = this.#deps
    const { generation, root, formatStartTime } = this.#options
    // The contacts permission is re-read when the integration is on; an
    // unanswerable check reads as no, so it never fails the pass.
    if (settings.get().contactsEnabled) {
      await contacts.refresh()
      if (isStale()) {
        return
      }
    }
    // Read per pass, so a settings change applies to the next one.
    const current = settings.get()
    const outcome = await reconcile({
      generation,
      graphRoot: root,
      localModel: current.localTranscriptionModel,
      transcriptionLanguages: current.transcriptionLanguages,
      transcriptionPrompt: current.transcriptionPrompt,
      calendarEnabled: current.calendarEnabled,
      calendarIds: current.calendarIds,
      lookupContacts: contacts.canLookup(current),
      recordingsFolder: this.#recordingsFolder(),
      formatStartTime,
      isStale,
      onPending: (count) => {
        this.#deps.update(this, { transcribing: count > 0 })
      },
    })
    if (outcome.written.length > 0) {
      this.#deps.update(this, { lastTranscript: outcome.written.at(-1) ?? null })
    }
    this.#surfaceStop(outcome.stopped)
  }
}

class RecordingServiceImpl implements RecordingService {
  readonly #deps: RecordingServiceDeps
  readonly #listeners = new Set<() => void>()
  #state: RecordingState = IDLE_STATE
  /**
   * The started session whose progress {@link getState} shows.
   */
  #active: RecordingSession | null = null

  constructor(deps: RecordingServiceDeps) {
    this.#deps = deps
  }

  async reconcile(input: ReconcileRecordingsInput): Promise<ReconcileRecordingsOutcome> {
    const { recorder, localTranscription } = this.#deps
    const written: string[] = []
    const stale = (): boolean => input.isStale?.() === true
    const stalled = (): ReconcileRecordingsOutcome => ({
      written,
      stopped: { reason: 'stale', message: 'the graph session ended mid-pass' },
    })
    let recordings: FinishedRecording[]
    try {
      recordings = await recorder.finishedRecordings()
    } catch (cause) {
      return { written, stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) } }
    }
    input.onPending?.(recordings.length)
    if (recordings.length === 0) {
      return { written, stopped: null }
    }

    let modelReady: boolean | null = null
    let waitingForModel = false
    /**
     * The first failure; later recordings still get their turn.
     */
    let failed: ReconcileStop | null = null
    for (const recording of recordings) {
      if (stale()) {
        return stalled()
      }
      const identity = recordingIdentity(new Date(recording.startedAtMs))
      try {
        const linked = hasTranscriptLink(
          await this.#dailySource(identity.date, input.generation),
          identity,
        )
        if (!linked) {
          if (!recording.transcribed) {
            modelReady ??= (await localTranscription.status(input.localModel)).status === 'ready'
            if (!modelReady) {
              // Later recordings may already be transcribed and only need linking.
              waitingForModel = true
              continue
            }
          }
          if ((await this.#writeRecording(recording, identity, input, stale)) === 'stale') {
            return stalled()
          }
          written.push(identity.notePath)
        }
        if (stale()) {
          return stalled()
        }
        await recorder.archive(
          recording.id,
          archiveLocation(identity, input.recordingsFolder, input.graphRoot).destination,
        )
      } catch (cause) {
        if (stale()) {
          return stalled()
        }
        // One recording that keeps failing (an offline archive folder, audio
        // the model can't read) must not hold back every recording after it.
        failed ??= { reason: toAppError(cause).kind, message: errorMessage(cause) }
      }
    }
    if (failed !== null) {
      return { written, stopped: failed }
    }
    return {
      written,
      stopped: waitingForModel
        ? {
            reason: 'config',
            message:
              'Download an on-device transcription model in Settings to transcribe recordings.',
          }
        : null,
    }
  }

  openSession(options: RecordingSessionOptions): RecordingSession {
    const {
      recorder,
      contacts,
      localTranscription,
      settings,
      reconcilers,
      progress,
      role,
      logger,
    } = this.#deps
    return new RecordingSessionImpl(
      {
        recorder,
        contacts,
        localTranscription,
        settings,
        reconcilers,
        progress,
        logger,
        mainWindow: role === 'main',
        reconcile: (input) => this.reconcile(input),
        update: (session, patch) => {
          this.#active ??= session
          if (this.#active === session) {
            this.#setState({ ...this.#state, ...patch })
          }
        },
        release: (session) => {
          if (this.#active === session) {
            this.#active = null
            this.#setState(IDLE_STATE)
          }
        },
      },
      options,
    )
  }

  readonly getState = (): RecordingState => this.#state

  readonly subscribe = (listener: () => void): Unlisten => {
    const entry = (): void => {
      listener()
    }
    this.#listeners.add(entry)
    return () => {
      this.#listeners.delete(entry)
    }
  }

  dismissTranscript(): void {
    this.#setState({ ...this.#state, lastTranscript: null })
  }

  #setState(next: RecordingState): void {
    if (
      next.transcribing === this.#state.transcribing &&
      next.lastTranscript === this.#state.lastTranscript
    ) {
      return
    }
    this.#state = next
    for (const listener of this.#listeners) {
      listener()
    }
  }

  async #dailySource(date: string, generation: number): Promise<string> {
    try {
      return await this.#deps.noteFile.read(dailyPath(date), generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return ''
      }
      throw cause
    }
  }

  /**
   * The calendar event this recording belongs to, or null when the calendar
   * is off, unreadable, or has nothing then. Never fails the pass.
   */
  async #meetingEvent(
    recording: FinishedRecording,
    identity: RecordingIdentity,
    input: ReconcileRecordingsInput,
  ): Promise<CalendarEvent | null> {
    const { calendar, logger } = this.#deps
    if (!input.calendarEnabled || input.calendarIds.length === 0) {
      return null
    }
    try {
      if (!canReadCalendars(await calendar.authorizationStatus())) {
        return null
      }
      const events = await calendar.listEvents(dayRange(identity.date), input.calendarIds)
      return pickMeetingEvent(events, recording.startedAtMs, recording.endedAtMs)
    } catch (cause) {
      logger.error('recording calendar lookup failed:', cause)
      return null
    }
  }

  /**
   * Write the transcript note and its daily-note lines for one recording.
   */
  async #writeRecording(
    recording: FinishedRecording,
    identity: RecordingIdentity,
    input: ReconcileRecordingsInput,
    stale: () => boolean,
  ): Promise<'written' | 'stale'> {
    const { recorder, noteFile, meetings } = this.#deps
    const event = await this.#meetingEvent(recording, identity, input)
    const eventTitle = event === null ? null : wikiLinkSafe(event.title) || null
    const attendees = event === null ? [] : defaultAttendees(event)
    const channels = await recorder.transcribe({
      sessionId: recording.id,
      model: input.localModel,
      languages: input.transcriptionLanguages,
      prompt: transcriptionHint(input.transcriptionPrompt, event, attendees),
    })
    if (stale()) {
      return 'stale'
    }
    const { me, them } = speakerSegments(channels)
    const turns = mergeTurns([...dropEchoRepeats(me, them), ...them])
    const spoken = turns.map((turn) => turn.text).join(' ')
    const title = recordingTitle(identity, eventTitle, spoken)
    // A silent system side only matters on a call: the other voices are missing.
    const systemSilent = channels.systemSilent && event !== null
    const warnings = [...recording.warnings, ...(systemSilent ? ['systemSilent'] : [])]
    const { reference } = archiveLocation(identity, input.recordingsFolder, input.graphRoot)
    // Only ever created: a transcript note already at the path (an earlier
    // pass that stopped before linking) is kept as it is.
    await noteFile.create(
      identity.notePath,
      renderRecordingTranscript({
        identity,
        title,
        durationMs: channels.durationMs,
        model: channels.model,
        audioPath: reference,
        eventTitle,
        attendees: attendees.map((attendee) => attendee.name),
        warnings,
        turns,
      }),
      input.generation,
    )
    if (stale()) {
      return 'stale'
    }
    if (event === null || eventTitle === null) {
      await this.#linkMemo(identity, title, input.generation)
      return 'written'
    }
    const mentioned = meetingsSectionMentions(
      await this.#dailySource(identity.date, input.generation),
      eventTitle,
    )
    if (!mentioned) {
      await meetings.addMeetingToDailyAt(
        {
          date: identity.date,
          title: eventTitle,
          attendees,
          backlinkMeeting: event.recurring,
          lookupContacts: input.lookupContacts,
          startTime: input.formatStartTime(new Date(event.startsAt)),
        },
        input.generation,
      )
    }
    await patchNote(
      noteFile,
      dailyPath(identity.date),
      (source) =>
        source !== null && hasTranscriptLink(source, identity)
          ? null
          : appendListItem(source ?? '', {
              kind: 'bullet',
              markdown: `[[${identity.base}|${eventTitle} transcript]]`,
              section: { titles: [MEETINGS_HEADING], linked: false },
            }),
      input.generation,
    )
    return 'written'
  }

  /**
   * Link a memo under the day's `## [[Audio memos]]`, as audio memos are.
   */
  async #linkMemo(identity: RecordingIdentity, title: string, generation: number): Promise<void> {
    const { noteFile, backlinkTarget } = this.#deps
    const memosNoteTitle = await backlinkTarget.ensure(AUDIO_MEMOS_NOTE_TITLE, generation)
    const entry = `[[${identity.base}|${wikiLinkSafe(title) || identity.base}]]`
    await patchNote(
      noteFile,
      dailyPath(identity.date),
      (source) =>
        source !== null && hasTranscriptLink(source, identity)
          ? null
          : appendListItem(source ?? '', {
              kind: 'bullet',
              markdown: entry,
              section: { titles: [memosNoteTitle, AUDIO_MEMOS_NOTE_TITLE], linked: true },
            }),
      generation,
    )
  }
}

export function createRecordingService(deps: RecordingServiceDeps): RecordingService {
  return new RecordingServiceImpl(deps)
}
