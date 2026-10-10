import {
  addMeetingToDaily,
  MEETINGS_HEADING,
  type MeetingAttendee,
} from '../actions/add-meeting.ts'
import { AUDIO_MEMOS_NOTE_TITLE, type ReconcileStop } from '../actions/audio-memo.ts'
import { ensureBacklinkTarget } from '../actions/backlink-target.ts'
import { localModelStatus } from '../ai/local-transcription.ts'
import type { LocalTranscriptionModelId } from '../ai/local-transcription-models.ts'
import {
  calendarAuthorizationStatus,
  canReadCalendars,
  listCalendarEvents,
  type CalendarEvent,
} from '../calendar/commands.ts'
import { dayRange, defaultAttendees } from '../calendar/events.ts'
import { errorMessage, isAppError, toAppError } from '../errors.ts'
import { createNoteIfAbsent, readNote } from '../graph/commands.ts'
import { patchNote } from '../graph/patch-note.ts'
import { dailyPath } from '../graph/paths.ts'
import { wikiLinkSafe } from '../markdown/edit.ts'
import { appendListItem } from '../markdown/task-ast.ts'
import { parseNote } from '../markdown/extract.ts'
import { sectionEnd, topLevelHeadings } from '../markdown/heading-blocks.ts'
import {
  archiveRecording,
  finishedRecordings,
  transcribeRecording,
  type FinishedRecording,
  type RecordingChannels,
} from './commands.ts'
import { pickMeetingEvent } from './event-match.ts'
import {
  dropEchoRepeats,
  recordingIdentity,
  recordingTitle,
  mergeTurns,
  renderRecordingTranscript,
  type RecordingIdentity,
  type RecordingSegment,
} from './transcript.ts'

/**
 * Finish stopped recordings: transcribe both channels on the device, write
 * the transcript note under `inbox/recordings/`, link it from the day's note,
 * then archive the audio and clear staging. A recording that overlaps a
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

export interface ReconcileRecordingsInput {
  /** `GraphInfo.generation`: pins every note read and write. */
  generation: number
  /** Absolute root of the open graph, to write the archive path relative to it. */
  graphRoot: string | null
  /** The on-device model; recordings always transcribe on the device. */
  localModel: LocalTranscriptionModelId
  /** Spoken language as an ISO 639 code; empty detects it. */
  transcriptionLanguage: string
  /** The user's transcription helper text. */
  transcriptionPrompt: string
  /** The calendar integration's switch and enabled calendars. */
  calendarEnabled: boolean
  calendarIds: readonly string[]
  /** The contacts gate, as the add-meeting dialog computes it. */
  lookupContacts: boolean
  /** Absolute folder the archived `.m4a` files go to. */
  recordingsFolder: string
  /** The event's start time as the daily line shows it (`9:00am`). */
  formatStartTime: (startsAt: Date) => string
  /** Abort gate, checked between steps (graph switch / unmount). */
  isStale?: () => boolean
  /** Observes how many recordings wait, before work starts. */
  onPending?: (count: number) => void
}

export interface ReconcileRecordingsOutcome {
  /** Transcript notes written in this pass. */
  written: string[]
  stopped: ReconcileStop | null
}

/** Where a recording's archive goes, and how its note refers to it. */
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

async function dailySource(date: string, generation: number): Promise<string> {
  try {
    return await readNote(dailyPath(date), generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return ''
    }
    throw cause
  }
}

/** The transcript link is the tombstone; see the module doc. */
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

/** The calendar event this recording belongs to, or null when the calendar
 * is off, unreadable, or has nothing then. Never fails the pass. */
async function meetingEvent(
  meeting: FinishedRecording,
  identity: RecordingIdentity,
  input: ReconcileRecordingsInput,
): Promise<CalendarEvent | null> {
  if (!input.calendarEnabled || input.calendarIds.length === 0) {
    return null
  }
  try {
    if (!canReadCalendars(await calendarAuthorizationStatus())) {
      return null
    }
    const { start, end } = dayRange(identity.date)
    const events = await listCalendarEvents(start, end, [...input.calendarIds])
    return pickMeetingEvent(events, meeting.startedAtMs, meeting.endedAtMs)
  } catch (cause) {
    console.error('recording calendar lookup failed:', cause)
    return null
  }
}

/** The vocabulary hint: the user's text, then the meeting's own names, which
 * are exactly the words a speech model tends to misspell. */
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

/** Write the transcript note and its daily-note lines for one recording. */
async function writeRecording(
  meeting: FinishedRecording,
  identity: RecordingIdentity,
  input: ReconcileRecordingsInput,
  stale: () => boolean,
): Promise<'written' | 'stale'> {
  const event = await meetingEvent(meeting, identity, input)
  const eventTitle = event === null ? null : wikiLinkSafe(event.title) || null
  const attendees = event === null ? [] : defaultAttendees(event)
  const channels = await transcribeRecording({
    sessionId: meeting.id,
    model: input.localModel,
    language: input.transcriptionLanguage,
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
  const warnings = [...meeting.warnings, ...(systemSilent ? ['systemSilent'] : [])]
  const { reference } = archiveLocation(identity, input.recordingsFolder, input.graphRoot)
  await createNoteIfAbsent(
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
    await linkMemo(identity, title, input.generation)
    return 'written'
  }
  const mentioned = meetingsSectionMentions(
    await dailySource(identity.date, input.generation),
    eventTitle,
  )
  if (!mentioned) {
    await addMeetingToDaily({
      date: identity.date,
      title: eventTitle,
      attendees,
      backlinkMeeting: event.recurring,
      lookupContacts: input.lookupContacts,
      startTime: input.formatStartTime(new Date(event.startsAt)),
      generation: input.generation,
    })
  }
  await patchNote(
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

/** Link a memo under the day's `## [[Audio memos]]`, as audio memos are. */
async function linkMemo(
  identity: RecordingIdentity,
  title: string,
  generation: number,
): Promise<void> {
  const memosNoteTitle = await ensureBacklinkTarget(AUDIO_MEMOS_NOTE_TITLE, generation)
  const entry = `[[${identity.base}|${wikiLinkSafe(title) || identity.base}]]`
  await patchNote(
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

/** One pass over every stopped recording, oldest first. */
export async function reconcileRecordings(
  input: ReconcileRecordingsInput,
): Promise<ReconcileRecordingsOutcome> {
  const written: string[] = []
  const stale = (): boolean => input.isStale?.() === true
  const stalled = (): ReconcileRecordingsOutcome => ({
    written,
    stopped: { reason: 'stale', message: 'the graph session ended mid-pass' },
  })
  let recordings: FinishedRecording[]
  try {
    recordings = await finishedRecordings()
  } catch (cause) {
    return { written, stopped: { reason: toAppError(cause).kind, message: errorMessage(cause) } }
  }
  input.onPending?.(recordings.length)
  if (recordings.length === 0) {
    return { written, stopped: null }
  }

  let modelReady: boolean | null = null
  let waitingForModel = false
  /** The first failure; later recordings still get their turn. */
  let failed: ReconcileStop | null = null
  for (const meeting of recordings) {
    if (stale()) {
      return stalled()
    }
    const identity = recordingIdentity(new Date(meeting.startedAtMs))
    try {
      const linked = hasTranscriptLink(await dailySource(identity.date, input.generation), identity)
      if (!linked) {
        if (!meeting.transcribed) {
          modelReady ??= (await localModelStatus(input.localModel)).status === 'ready'
          if (!modelReady) {
            // Later recordings may already be transcribed and only need linking.
            waitingForModel = true
            continue
          }
        }
        if ((await writeRecording(meeting, identity, input, stale)) === 'stale') {
          return stalled()
        }
        written.push(identity.notePath)
      }
      if (stale()) {
        return stalled()
      }
      await archiveRecording(
        meeting.id,
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
