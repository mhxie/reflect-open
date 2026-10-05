import { beforeEach, describe, expect, it, vi } from 'vitest'
import { addMeetingToDaily } from '../actions/add-meeting.ts'
import { localModelStatus } from '../ai/local-transcription.ts'
import {
  calendarAuthorizationStatus,
  listCalendarEvents,
  type CalendarEvent,
} from '../calendar/commands.ts'
import { createNoteIfAbsent, readNote, writeNote } from '../graph/commands.ts'
import { PATCH_NOTE_ATTEMPTS } from '../graph/patch-note.ts'
import {
  archiveRecording,
  finishedRecordings,
  transcribeRecording,
  type FinishedRecording,
  type RecordingChannels,
} from './commands.ts'
import { reconcileRecordings, type ReconcileRecordingsInput } from './reconcile.ts'

vi.mock('../actions/backlink-target', () => ({
  ensureBacklinkTarget: vi.fn(async (title: string) => title),
}))
vi.mock('../actions/add-meeting', () => ({
  MEETINGS_HEADING: 'Meetings',
  addMeetingToDaily: vi.fn(),
}))
vi.mock('../ai/local-transcription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/local-transcription.ts')>()),
  localModelStatus: vi.fn(),
}))
vi.mock('../calendar/commands', () => ({
  calendarAuthorizationStatus: vi.fn(),
  canReadCalendars: (status: string) => status === 'fullAccess',
  listCalendarEvents: vi.fn(),
}))
vi.mock('../graph/commands', () => ({
  createNoteIfAbsent: vi.fn(),
  readNote: vi.fn(),
  writeNote: vi.fn(),
}))
vi.mock('./commands', () => ({
  archiveRecording: vi.fn(),
  finishedRecordings: vi.fn(),
  transcribeRecording: vi.fn(),
}))

const addMeetingMock = vi.mocked(addMeetingToDaily)
const modelStatusMock = vi.mocked(localModelStatus)
const authorizationMock = vi.mocked(calendarAuthorizationStatus)
const eventsMock = vi.mocked(listCalendarEvents)
const createNoteMock = vi.mocked(createNoteIfAbsent)
const readNoteMock = vi.mocked(readNote)
const writeNoteMock = vi.mocked(writeNote)
const archiveMock = vi.mocked(archiveRecording)
const finishedMock = vi.mocked(finishedRecordings)
const transcribeMock = vi.mocked(transcribeRecording)

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

function input(overrides: Partial<ReconcileRecordingsInput> = {}): ReconcileRecordingsInput {
  return {
    generation: 4,
    graphRoot: '/Users/someone/Notes',
    localModel: 'large-v3-turbo',
    transcriptionLanguage: '',
    transcriptionPrompt: 'Reflect',
    calendarEnabled: true,
    calendarIds: ['work'],
    lookupContacts: false,
    recordingsFolder: '/Users/someone/Notes/cache/meetings/',
    formatStartTime: () => '1:59pm',
    ...overrides,
  }
}

let daily = ''

beforeEach(() => {
  vi.clearAllMocks()
  daily = ''
  finishedMock.mockResolvedValue([MEETING])
  modelStatusMock.mockResolvedValue({ status: 'ready' })
  authorizationMock.mockResolvedValue('fullAccess')
  eventsMock.mockResolvedValue([SYNC])
  transcribeMock.mockResolvedValue(CHANNELS)
  createNoteMock.mockResolvedValue({ kind: 'created', modifiedMs: 1 })
  readNoteMock.mockImplementation(async () => {
    if (daily === '') {
      throw { kind: 'notFound', message: 'missing' }
    }
    return daily
  })
  // Rust's write rule: a write lands only over the contents it names.
  writeNoteMock.mockImplementation(async (_path, contents, _generation, expectedContents) => {
    if ((daily === '' ? null : daily) !== expectedContents) {
      throw { kind: 'io', message: 'Note changed on disk; reload before retrying' }
    }
    daily = contents
  })
  addMeetingMock.mockImplementation(async () => {
    daily = '## Meetings\n\n- 1:59pm met with [[Ada Lovelace]] for [[Weekly sync]]\n'
    return { appended: true, createdNotes: [] }
  })
})

describe('reconcileRecordings', () => {
  it('writes the transcript, links the meeting and its attendees, then archives', async () => {
    const outcome = await reconcileRecordings(input())

    expect(outcome).toEqual({ written: [`inbox/recordings/${BASE}.md`], stopped: null })
    expect(transcribeMock).toHaveBeenCalledWith({
      sessionId: MEETING.id,
      model: 'large-v3-turbo',
      language: '',
      prompt: 'Reflect\nWeekly sync, Ada Lovelace',
    })
    const [notePath, note, generation] = createNoteMock.mock.calls[0]!
    expect(notePath).toBe(`inbox/recordings/${BASE}.md`)
    expect(generation).toBe(4)
    expect(note).toContain('\n# Weekly sync transcript 2026-10-01\n')
    expect(note).toContain(`audio: cache/meetings/${BASE}.m4a`)
    expect(note).toContain('**[00:00:01] Me:** Can you send the budget sheet?')
    expect(note).toContain('**[00:00:06] Them:** We will ship the release on Friday afternoon.')
    expect(note).not.toContain('we will ship')

    expect(addMeetingMock).toHaveBeenCalledWith({
      date: '2026-10-01',
      title: 'Weekly sync',
      attendees: [{ name: 'Ada Lovelace', emails: ['ada@example.com'] }],
      backlinkMeeting: true,
      lookupContacts: false,
      startTime: '1:59pm',
      generation: 4,
    })
    expect(writeNoteMock).toHaveBeenLastCalledWith(
      DAILY,
      expect.stringContaining(`- [[${BASE}|Weekly sync transcript]]`),
      4,
      '## Meetings\n\n- 1:59pm met with [[Ada Lovelace]] for [[Weekly sync]]\n',
    )
    expect(daily).toContain('for [[Weekly sync]]')
    expect(archiveMock).toHaveBeenCalledWith(
      MEETING.id,
      `/Users/someone/Notes/cache/meetings/${BASE}.m4a`,
    )
  })

  it('keeps a daily edit that lands before the link write, linking it once', async () => {
    eventsMock.mockResolvedValue([])
    const write = writeNoteMock.getMockImplementation()!
    writeNoteMock.mockImplementationOnce(async (...args) => {
      daily = `${daily}Typed while the recording finished.\n`
      await write(...args)
    })

    await reconcileRecordings(input())

    expect(daily).toContain('Typed while the recording finished.')
    expect(daily.split(`[[${BASE}|`)).toHaveLength(2) // exactly one link
  })

  it('a daily that keeps changing stops the pass; the next links the kept transcript', async () => {
    eventsMock.mockResolvedValue([])
    const created = new Set<string>()
    createNoteMock.mockImplementation(async (path) => {
      if (created.has(path)) {
        return { kind: 'collision' }
      }
      created.add(path)
      return { kind: 'created', modifiedMs: 1 }
    })
    const write = writeNoteMock.getMockImplementation()!
    let edits = 0
    writeNoteMock.mockImplementation(async (...args) => {
      if (edits < PATCH_NOTE_ATTEMPTS) {
        edits += 1
        daily = `${daily}edit ${edits}\n`
      }
      await write(...args)
    })

    const stopped = await reconcileRecordings(input())

    expect(stopped).toEqual({
      written: [],
      stopped: { reason: 'io', message: 'Note changed on disk; reload before retrying' },
    })
    expect(daily).toBe('edit 1\nedit 2\nedit 3\n')
    expect(archiveMock).not.toHaveBeenCalled() // still staged for the next pass

    const resumed = await reconcileRecordings(input())

    expect(resumed).toEqual({ written: [`inbox/recordings/${BASE}.md`], stopped: null })
    expect(await createNoteMock.mock.results.at(-1)?.value).toEqual({ kind: 'collision' })
    expect(daily).toContain('edit 3')
    expect(daily.split(`[[${BASE}|`)).toHaveLength(2)
    expect(archiveMock).toHaveBeenCalledTimes(1)
  })

  it('only archives a recording whose transcript link already exists', async () => {
    daily = `## Meetings\n\n- [[${BASE}|Weekly sync transcript]]\n`

    const outcome = await reconcileRecordings(input())

    expect(outcome).toEqual({ written: [], stopped: null })
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
    expect(archiveMock).toHaveBeenCalledTimes(1)
  })

  it('waits for a model before transcribing anything', async () => {
    modelStatusMock.mockResolvedValue({ status: 'missing' })

    const outcome = await reconcileRecordings(input())

    expect(outcome.stopped?.reason).toBe('config')
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(archiveMock).not.toHaveBeenCalled()
  })

  it('still finishes a transcribed recording while another waits for the model', async () => {
    modelStatusMock.mockResolvedValue({ status: 'missing' })
    const later = new Date(2026, 9, 1, 16, 0, 0).getTime()
    finishedMock.mockResolvedValue([
      MEETING,
      {
        ...MEETING,
        id: `session-${later}`,
        startedAtMs: later,
        endedAtMs: later + 30_000,
        transcribed: true,
      },
    ])

    const outcome = await reconcileRecordings(input())

    expect(outcome.stopped?.reason).toBe('config')
    expect(outcome.written).toEqual(['inbox/recordings/recording-2026-10-01-160000.md'])
    expect(transcribeMock).toHaveBeenCalledTimes(1)
    expect(archiveMock).toHaveBeenCalledWith(`session-${later}`, expect.any(String))
  })

  it('links a recording with no calendar event as a memo', async () => {
    eventsMock.mockResolvedValue([])
    transcribeMock.mockResolvedValue({
      ...CHANNELS,
      me: [{ startMs: 1_000, endMs: 3_000, text: 'remember to call the bank. then lunch' }],
      them: [],
      systemSilent: true,
    })

    await reconcileRecordings(input({ recordingsFolder: '/Volumes/Archive/recordings' }))

    expect(addMeetingMock).not.toHaveBeenCalled()
    expect(daily).toBe(`## [[Audio memos]]\n\n- [[${BASE}|Remember to call the bank]]\n`)
    const note = createNoteMock.mock.calls[0]![1]
    expect(note).toContain('\n# Remember to call the bank\n')
    expect(note).toContain('## Transcript\n\nremember to call the bank. then lunch\n')
    expect(note).toContain(`audio: /Volumes/Archive/recordings/${BASE}.m4a`)
    expect(note).not.toContain('event:')
    expect(note).not.toContain('speakers:')
    expect(note).not.toContain('systemSilent')
  })

  it('does not repeat a one-off meeting the day already lists', async () => {
    eventsMock.mockResolvedValue([{ ...SYNC, recurring: false }])
    daily = '## Meetings\n\n- 1:59pm met with [[Ada Lovelace]] for Weekly sync\n'

    await reconcileRecordings(input())

    expect(addMeetingMock).not.toHaveBeenCalled()
    expect(daily).toContain(`for Weekly sync\n- [[${BASE}|Weekly sync transcript]]`)
  })

  it('skips the calendar when the integration is off', async () => {
    await reconcileRecordings(input({ calendarEnabled: false }))

    expect(eventsMock).not.toHaveBeenCalled()
    expect(transcribeMock).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Reflect' }))
  })

  it('stops at a failed step and leaves the recording in staging', async () => {
    transcribeMock.mockRejectedValue({ kind: 'io', message: 'the model failed to load' })

    const outcome = await reconcileRecordings(input())

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'the model failed to load' })
    expect(archiveMock).not.toHaveBeenCalled()
  })

  it('a recording that keeps failing never holds back the ones after it', async () => {
    const later = new Date(2026, 9, 1, 16, 0, 0).getTime()
    finishedMock.mockResolvedValue([
      MEETING,
      { ...MEETING, id: `session-${later}`, startedAtMs: later, endedAtMs: later + 30_000 },
    ])
    // The archive folder is offline: the first archive fails, the second lands.
    archiveMock
      .mockRejectedValueOnce({ kind: 'io', message: 'the archive folder is offline' })
      .mockResolvedValueOnce(undefined)

    const outcome = await reconcileRecordings(input())

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'the archive folder is offline' })
    expect(outcome.written).toEqual([
      `inbox/recordings/${BASE}.md`,
      'inbox/recordings/recording-2026-10-01-160000.md',
    ])
    expect(archiveMock).toHaveBeenCalledTimes(2)
    expect(archiveMock).toHaveBeenLastCalledWith(`session-${later}`, expect.any(String))
  })
})
