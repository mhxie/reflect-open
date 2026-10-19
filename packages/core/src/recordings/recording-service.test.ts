import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { CalendarEvent } from '../calendar/calendar-service.ts'
import { createMeetingService } from '../contacts/meeting-service.ts'
import { createPersonNoteService } from '../contacts/person-note-service.ts'
import { AppError } from '../errors.ts'
import type { GraphRole } from '../graph/graph-session.ts'
import { PATCH_NOTE_ATTEMPTS } from '../graph/patch-note.ts'
import { createSuggestionService } from '../indexing/suggestion-service.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { createBackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import {
  createTestActivityPort,
  createTestCalendarService,
  createTestContactsService,
  createTestDatabaseService,
  createTestGraphSessionService,
  createTestIpcBridgeService,
  createTestLocalTranscriptionService,
  createTestLoggerService,
  createTestNoteCreationService,
  createTestNoteFileService,
  createTestPlatformService,
  createTestProgressPort,
  createTestSettingsService,
} from '../testing/index.ts'
import type { LocalModelStatus } from '../ai/local-transcription.ts'
import {
  createRecorderService,
  type FinishedRecording,
  type RecordingChannels,
} from './recorder-service.ts'
import { createRecordingService, type ReconcileRecordingsInput } from './recording-service.ts'

const STARTED = new Date(2026, 9, 1, 14, 0, 0).getTime()
const BASE = 'recording-2026-10-01-140000'
const DAILY = 'daily/2026-10-01.md'

const MEETING: FinishedRecording = {
  id: `session-${STARTED}`,
  startedAtMs: STARTED,
  endedAtMs: STARTED + 30_000,
  transcribed: false,
  warnings: [],
}

const SYNC: CalendarEvent = {
  id: 'event-1',
  calendarId: 'work',
  title: 'Weekly sync',
  startsAt: STARTED - 60_000,
  endsAt: STARTED + 30 * 60_000,
  allDay: false,
  recurring: true,
  availability: 'busy',
  canceled: false,
  attendees: [
    {
      name: 'Me',
      email: 'me@example.com',
      isCurrentUser: true,
      isPerson: true,
      status: 'accepted',
    },
    {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      isCurrentUser: false,
      isPerson: true,
      status: 'accepted',
    },
  ],
}

const CHANNELS: RecordingChannels = {
  model: 'large-v3-turbo',
  durationMs: 30_000,
  me: [
    { startMs: 1_000, endMs: 3_000, text: 'Can you send the budget sheet?' },
    { startMs: 6_100, endMs: 8_000, text: 'we will ship the release on Friday afternoon' },
  ],
  them: [{ startMs: 6_000, endMs: 8_000, text: 'We will ship the release on Friday afternoon.' }],
  echoSuppressed: true,
  systemSilent: false,
}

const archiveRequestSchema = z.object({ sessionId: z.string(), destination: z.string() })

const MEETING_LINE = '## Meetings\n\n- 1:59pm met with [[Ada Lovelace]] for [[Weekly sync]]\n'

function input(overrides: Partial<ReconcileRecordingsInput> = {}): ReconcileRecordingsInput {
  return {
    generation: 4,
    graphRoot: '/Users/someone/Notes',
    localModel: 'large-v3-turbo',
    transcriptionLanguages: [],
    transcriptionPrompt: 'Reflect',
    calendarEnabled: true,
    calendarIds: ['work'],
    lookupContacts: false,
    recordingsFolder: '/Users/someone/Notes/cache/meetings/',
    formatStartTime: () => '1:59pm',
    ...overrides,
  }
}

/**
 * The recording service over the native recorder's commands on a test IPC
 * (staging holds `finished`, transcription answers `channels`), an in-memory
 * graph, the calendar listing `events`, and a meeting writer that lists the
 * meeting under the day's `## Meetings`, like the events panel does.
 */
function setup(
  options: {
    finished?: FinishedRecording[]
    channels?: RecordingChannels
    events?: CalendarEvent[]
    model?: LocalModelStatus
    role?: GraphRole
  } = {},
) {
  const archives: Array<{ sessionId: string; destination: string }> = []
  const transcribed: unknown[] = []
  let archiveFailure: AppError | null = null
  let transcribeFailure: AppError | null = null
  const ipc = createTestIpcBridgeService({
    commands: {
      recorder_status: () => ({
        supported: true,
        defaultRecordingsFolder: '/Users/someone/Library/Recordings',
        recording: null,
      }),
      recorder_configure: () => null,
      recorder_sessions: () => options.finished ?? [MEETING],
      recorder_transcribe: (args) => {
        transcribed.push(args['request'])
        if (transcribeFailure !== null) {
          throw transcribeFailure
        }
        return options.channels ?? CHANNELS
      },
      recorder_archive: (args) => {
        if (archiveFailure !== null) {
          const failure = archiveFailure
          archiveFailure = null
          throw failure
        }
        archives.push(archiveRequestSchema.parse(args['request']))
        return null
      },
    },
  })
  const logger = createTestLoggerService()
  const recorder = createRecorderService({
    ipc,
    platform: createTestPlatformService(),
    progress: createTestProgressPort(),
    logger,
  })
  const noteFile = createTestNoteFileService()
  const calendar = createTestCalendarService({ events: options.events ?? [SYNC] })
  const contacts = createTestContactsService()
  const settings = createTestSettingsService()
  const database = createTestDatabaseService()
  const noteCreation = createTestNoteCreationService({ noteFile })
  const wikiResolver = createWikiResolverService({ database })
  const meetings = createMeetingService({
    noteFile,
    noteCreation,
    wikiResolver,
    suggestions: createSuggestionService({ database }),
    personNotes: createPersonNoteService({ database, wikiResolver, noteCreation }),
    contacts,
    settings,
    logger,
    graphSession: createTestGraphSessionService({ graph: { generation: 4 } }),
  })
  const meetingCalls: unknown[] = []
  // The events panel's own writer, reduced to the line it lists the meeting with.
  vi.spyOn(meetings, 'addMeetingToDailyAt').mockImplementation(async (meeting, generation) => {
    meetingCalls.push({ ...meeting, generation })
    const current = noteFile.files().get(DAILY)
    await noteFile.write(DAILY, MEETING_LINE, generation, current ?? null)
    return { appended: true, createdNotes: [] }
  })
  const localTranscription = createTestLocalTranscriptionService({
    status: options.model ?? { status: 'ready' },
  })
  const service = createRecordingService({
    recorder,
    noteFile,
    backlinkTarget: { ensure: (title) => title },
    calendar,
    meetings,
    contacts,
    localTranscription,
    settings,
    reconcilers: createBackgroundReconcilerFactory({ activity: createTestActivityPort() }),
    progress: createTestProgressPort(),
    role: options.role ?? 'main',
    logger,
  })
  return {
    service,
    ipc,
    noteFile,
    calendar,
    archives,
    transcribed,
    meetingCalls,
    daily: () => noteFile.files().get(DAILY) ?? '',
    failArchiveOnce: (message: string): void => {
      archiveFailure = new AppError('io', message)
    },
    failTranscription: (message: string): void => {
      transcribeFailure = new AppError('io', message)
    },
  }
}

describe('RecordingService.reconcile', () => {
  it('writes the transcript, links the meeting and its attendees, then archives', async () => {
    const { service, noteFile, transcribed, meetingCalls, archives, daily } = setup()

    const outcome = await service.reconcile(input({ transcriptionLanguages: ['en', 'zh'] }))

    expect(outcome).toEqual({ written: [`inbox/recordings/${BASE}.md`], stopped: null })
    expect(transcribed).toEqual([
      {
        sessionId: MEETING.id,
        model: 'large-v3-turbo',
        languages: ['en', 'zh'],
        prompt: 'Reflect\nWeekly sync, Ada Lovelace',
      },
    ])
    const created = noteFile.writes().find((write) => write.path.startsWith('inbox/'))
    expect(created?.path).toBe(`inbox/recordings/${BASE}.md`)
    expect(created?.generation).toBe(4)
    const note = created?.contents ?? ''
    expect(note).toContain('\n# Weekly sync transcript 2026-10-01\n')
    expect(note).toContain(`audio: cache/meetings/${BASE}.m4a`)
    expect(note).toContain('**[00:00:01] Me:** Can you send the budget sheet?')
    expect(note).toContain('**[00:00:06] Them:** We will ship the release on Friday afternoon.')
    expect(note).not.toContain('we will ship')

    expect(meetingCalls).toEqual([
      {
        date: '2026-10-01',
        title: 'Weekly sync',
        attendees: [{ name: 'Ada Lovelace', emails: ['ada@example.com'] }],
        backlinkMeeting: true,
        lookupContacts: false,
        startTime: '1:59pm',
        generation: 4,
      },
    ])
    expect(daily()).toBe(`${MEETING_LINE}- [[${BASE}|Weekly sync transcript]]\n`)
    expect(archives).toEqual([
      { sessionId: MEETING.id, destination: `/Users/someone/Notes/cache/meetings/${BASE}.m4a` },
    ])
  })

  it('keeps a daily edit that lands before the link write, linking it once', async () => {
    const { service, noteFile, daily } = setup({ events: [] })
    const write = noteFile.write.bind(noteFile)
    vi.spyOn(noteFile, 'write').mockImplementationOnce(async (...args) => {
      noteFile.set(DAILY, `${daily()}Typed while the recording finished.\n`)
      return await write(...args)
    })

    await service.reconcile(input())

    expect(daily()).toContain('Typed while the recording finished.')
    expect(daily().split(`[[${BASE}|`)).toHaveLength(2) // exactly one link
  })

  it('a daily that keeps appearing and vanishing stops the pass; the next links the kept transcript', async () => {
    const { service, noteFile, archives, daily } = setup({ events: [] })
    const write = noteFile.write.bind(noteFile)
    let edits = 0
    // A sync tug-of-war: each link write finds the day's note created or removed
    // meanwhile, which Rust refuses (a moved-on note would merge instead).
    vi.spyOn(noteFile, 'write').mockImplementation(async (path, contents, generation, expected) => {
      if (path === DAILY && edits < PATCH_NOTE_ATTEMPTS) {
        edits += 1
        if (noteFile.files().has(DAILY)) {
          await noteFile.delete(DAILY, generation)
        } else {
          noteFile.set(DAILY, `edit ${edits}\n`)
        }
      }
      return await write(path, contents, generation, expected)
    })
    const create = vi.spyOn(noteFile, 'create')

    const stopped = await service.reconcile(input())

    expect(stopped).toEqual({
      written: [],
      stopped: { reason: 'io', message: 'Note changed on disk; reload before retrying' },
    })
    expect(daily()).toBe('edit 3\n')
    expect(archives).toEqual([]) // still staged for the next pass

    const resumed = await service.reconcile(input())

    expect(resumed).toEqual({ written: [`inbox/recordings/${BASE}.md`], stopped: null })
    expect(await create.mock.results.at(-1)?.value).toEqual({ kind: 'collision' })
    expect(daily()).toContain('edit 3')
    expect(daily().split(`[[${BASE}|`)).toHaveLength(2)
    expect(archives).toHaveLength(1)
  })

  it('only archives a recording whose transcript link already exists', async () => {
    const { service, noteFile, transcribed, archives } = setup()
    noteFile.set(DAILY, `## Meetings\n\n- [[${BASE}|Weekly sync transcript]]\n`)

    const outcome = await service.reconcile(input())

    expect(outcome).toEqual({ written: [], stopped: null })
    expect(transcribed).toEqual([])
    expect(noteFile.writes()).toEqual([])
    expect(archives).toHaveLength(1)
  })

  it('waits for a model before transcribing anything', async () => {
    const { service, transcribed, archives } = setup({ model: { status: 'missing' } })

    const outcome = await service.reconcile(input())

    expect(outcome.stopped?.reason).toBe('config')
    expect(transcribed).toEqual([])
    expect(archives).toEqual([])
  })

  it('still finishes a transcribed recording while another waits for the model', async () => {
    const later = new Date(2026, 9, 1, 16, 0, 0).getTime()
    const { service, transcribed, archives } = setup({
      model: { status: 'missing' },
      finished: [
        MEETING,
        {
          ...MEETING,
          id: `session-${later}`,
          startedAtMs: later,
          endedAtMs: later + 30_000,
          transcribed: true,
        },
      ],
    })

    const outcome = await service.reconcile(input())

    expect(outcome.stopped?.reason).toBe('config')
    expect(outcome.written).toEqual(['inbox/recordings/recording-2026-10-01-160000.md'])
    expect(transcribed).toHaveLength(1)
    expect(archives).toEqual([{ sessionId: `session-${later}`, destination: expect.any(String) }])
  })

  it('links a recording with no calendar event as a memo', async () => {
    const { service, noteFile, meetingCalls, daily } = setup({
      events: [],
      channels: {
        ...CHANNELS,
        me: [{ startMs: 1_000, endMs: 3_000, text: 'remember to call the bank. then lunch' }],
        them: [],
        systemSilent: true,
      },
    })

    await service.reconcile(input({ recordingsFolder: '/Volumes/Archive/recordings' }))

    expect(meetingCalls).toEqual([])
    expect(daily()).toBe(`## [[Audio memos]]\n\n- [[${BASE}|Remember to call the bank]]\n`)
    const note = noteFile.files().get(`inbox/recordings/${BASE}.md`) ?? ''
    expect(note).toContain('\n# Remember to call the bank\n')
    expect(note).toContain('## Transcript\n\nremember to call the bank. then lunch\n')
    expect(note).toContain(`audio: /Volumes/Archive/recordings/${BASE}.m4a`)
    expect(note).not.toContain('event:')
    expect(note).not.toContain('speakers:')
    expect(note).not.toContain('systemSilent')
  })

  it('does not repeat a one-off meeting the day already lists', async () => {
    const { service, noteFile, meetingCalls, daily } = setup({
      events: [{ ...SYNC, recurring: false }],
    })
    noteFile.set(DAILY, '## Meetings\n\n- 1:59pm met with [[Ada Lovelace]] for Weekly sync\n')

    await service.reconcile(input())

    expect(meetingCalls).toEqual([])
    expect(daily()).toContain(`for Weekly sync\n- [[${BASE}|Weekly sync transcript]]`)
  })

  it('skips the calendar when the integration is off', async () => {
    const { service, calendar, transcribed } = setup()
    const listEvents = vi.spyOn(calendar, 'listEvents')

    await service.reconcile(input({ calendarEnabled: false }))

    expect(listEvents).not.toHaveBeenCalled()
    expect(transcribed).toEqual([expect.objectContaining({ prompt: 'Reflect' })])
  })

  it('stops at a failed step and leaves the recording in staging', async () => {
    const { service, archives, failTranscription } = setup()
    failTranscription('the model failed to load')

    const outcome = await service.reconcile(input())

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'the model failed to load' })
    expect(archives).toEqual([])
  })

  it('a recording that keeps failing never holds back the ones after it', async () => {
    const later = new Date(2026, 9, 1, 16, 0, 0).getTime()
    const { service, archives, failArchiveOnce } = setup({
      finished: [
        MEETING,
        { ...MEETING, id: `session-${later}`, startedAtMs: later, endedAtMs: later + 30_000 },
      ],
    })
    // The archive folder is offline: the first archive fails, the second lands.
    failArchiveOnce('the archive folder is offline')

    const outcome = await service.reconcile(input())

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'the archive folder is offline' })
    expect(outcome.written).toEqual([
      `inbox/recordings/${BASE}.md`,
      'inbox/recordings/recording-2026-10-01-160000.md',
    ])
    expect(archives).toEqual([{ sessionId: `session-${later}`, destination: expect.any(String) }])
  })
})

describe('RecordingService.openSession', () => {
  it('shows the transcript notes a pass wrote until they are dismissed', async () => {
    const { service } = setup({ events: [] })
    const session = service.openSession({
      generation: 4,
      root: '/Users/someone/Notes',
      formatStartTime: () => '1:59pm',
    })

    session.start()

    await vi.waitFor(() =>
      expect(service.getState().lastTranscript).toBe(`inbox/recordings/${BASE}.md`),
    )
    service.dismissTranscript()
    expect(service.getState().lastTranscript).toBeNull()
    session.dispose()
  })

  it('stays quiet when a pass wrote nothing', async () => {
    const { service, ipc, transcribed } = setup({ finished: [] })
    const session = service.openSession({
      generation: 4,
      root: '/Users/someone/Notes',
      formatStartTime: () => '1:59pm',
    })
    const changes = vi.fn()
    service.subscribe(changes)

    session.start()
    await vi.waitFor(() =>
      expect(ipc.calls().some((call) => call.command === 'recorder_sessions')).toBe(true),
    )

    expect(changes).not.toHaveBeenCalled()
    expect(service.getState()).toEqual({ transcribing: false, lastTranscript: null })
    expect(transcribed).toEqual([])
    session.dispose()
  })

  it('does nothing in a note window: two loops would write every transcript twice', () => {
    const { service, ipc, transcribed } = setup({ role: 'note-window' })
    const session = service.openSession({
      generation: 4,
      root: '/Users/someone/Notes',
      formatStartTime: () => '1:59pm',
    })

    session.start()
    session.schedule()

    expect(ipc.calls().filter((call) => call.command === 'recorder_sessions')).toEqual([])
    expect(transcribed).toEqual([])
    expect(service.getState().lastTranscript).toBeNull()
    session.dispose()
  })
})
