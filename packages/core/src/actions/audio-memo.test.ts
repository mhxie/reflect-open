import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiProvidersState } from '../ai/provider-config.ts'
import type { GenerateAudioMemoTitleRequest } from '../ai/audio-memo-title.ts'
import type {
  FormatAudioMemoTranscriptRequest,
  FormattedAudioMemoTranscript,
} from '../ai/audio-memo-format.ts'
import {
  audioMemoFromPath,
  audioMemoIdentity,
  audioMemoPartFromPath,
  audioMemoPartPath,
  captureAudioMemoPart,
  isSilentStop,
  reconcileAudioMemos,
  type ReconcileAudioMemosInput,
  type ReconcileStop,
} from './audio-memo.ts'
import { APP_REVIEW_STUB_KEY } from '../ai/app-review-demo.ts'
import {
  createNoteIfAbsent,
  importAudioMemo,
  listDir,
  listFiles,
  readAsset,
  readNote,
  readTranscriptCache,
  writeAsset,
  writeNote,
  writeTranscriptCache,
} from '../graph/commands.ts'
import { transcribeAudio } from '../ai/transcribe.ts'
import { localModelStatus, transcribeLocally } from '../ai/local-transcription.ts'
import { TranscriptionRejectedError } from '../ai/transcribe-http.ts'
import { getSecret } from '../secrets/keychain.ts'
import { fakeNoteStore, type FakeNoteStore } from '../testing/fake-note-store.ts'

const generateAudioMemoTitleMock = vi.hoisted(() =>
  vi.fn<(request: GenerateAudioMemoTitleRequest) => Promise<string>>(),
)
const formatAudioMemoTranscriptMock = vi.hoisted(() =>
  vi.fn<(request: FormatAudioMemoTranscriptRequest) => Promise<FormattedAudioMemoTranscript>>(),
)
const ensureBacklinkTargetMock = vi.hoisted(() => vi.fn())

vi.mock('../graph/commands', () => ({
  createNoteIfAbsent: vi.fn(),
  importAudioMemo: vi.fn(),
  listDir: vi.fn(),
  listFiles: vi.fn(),
  readAsset: vi.fn(),
  readAssetBinary: vi.fn(),
  readNote: vi.fn(),
  readTranscriptCache: vi.fn(),
  writeAsset: vi.fn(),
  writeNote: vi.fn(),
  writeTranscriptCache: vi.fn(),
}))
vi.mock('../ai/transcribe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/transcribe.ts')>()),
  transcribeAudio: vi.fn(),
}))
vi.mock('../ai/local-transcription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/local-transcription.ts')>()),
  localModelStatus: vi.fn(),
  transcribeLocally: vi.fn(),
}))
vi.mock('../ai/audio-memo-title', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/audio-memo-title.ts')>()),
  generateAudioMemoTitle: generateAudioMemoTitleMock,
}))
vi.mock('../ai/audio-memo-format', () => ({
  formatAudioMemoTranscript: formatAudioMemoTranscriptMock,
}))
vi.mock('./backlink-target', () => ({
  ensureBacklinkTarget: ensureBacklinkTargetMock,
}))
vi.mock('../secrets/keychain', () => ({
  getSecret: vi.fn(),
}))

const listDirMock = vi.mocked(listDir)
const listFilesMock = vi.mocked(listFiles)
const readAssetMock = vi.mocked(readAsset)
const readNoteMock = vi.mocked(readNote)
const writeAssetMock = vi.mocked(writeAsset)
const importAudioMemoMock = vi.mocked(importAudioMemo)
const readTranscriptCacheMock = vi.mocked(readTranscriptCache)
const writeTranscriptCacheMock = vi.mocked(writeTranscriptCache)
const writeNoteMock = vi.mocked(writeNote)
const createNoteMock = vi.mocked(createNoteIfAbsent)
const transcribeMock = vi.mocked(transcribeAudio)
const localModelStatusMock = vi.mocked(localModelStatus)
const transcribeLocallyMock = vi.mocked(transcribeLocally)
const getSecretMock = vi.mocked(getSecret)

const PROVIDERS: AiProvidersState = {
  providers: [{ id: 'cfg-openai', provider: 'openai', model: 'gpt-5.1', keyHint: 'wxyz1' }],
  defaultProviderId: 'cfg-openai',
}

const ANTHROPIC_CONFIG = {
  id: 'cfg-anthropic',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  keyHint: 'wxyz1',
} as const

/** 2026-06-11 15:30:22.845 local — every derived name is asserted from it. */
const RECORDED_AT = new Date(2026, 5, 11, 15, 30, 22, 845)
const MEMO = audioMemoIdentity(RECORDED_AT, 'audio/webm;codecs=opus')

function fileMeta(path: string): { path: string; size: number; modifiedMs: number } {
  return { path, size: 1, modifiedMs: 0 }
}

function reconcile(overrides: Partial<ReconcileAudioMemosInput> = {}) {
  return reconcileAudioMemos({
    providers: PROVIDERS,
    generation: 3,
    formatTranscript: false,
    transcriptionPrompt: '',
    engine: 'cloud',
    localModel: 'large-v3-turbo',
    transcriptionLanguage: '',
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  listDirMock.mockResolvedValue([])
  listFilesMock.mockResolvedValue([])
  readAssetMock.mockResolvedValue(btoa('audio-bytes'))
  readNoteMock.mockResolvedValue('morning thoughts\n')
  writeAssetMock.mockResolvedValue(undefined)
  readTranscriptCacheMock.mockRejectedValue({ kind: 'notFound', message: 'no cached transcript' })
  writeTranscriptCacheMock.mockResolvedValue(undefined)
  writeNoteMock.mockResolvedValue(undefined)
  createNoteMock.mockResolvedValue({ kind: 'created', modifiedMs: null })
  getSecretMock.mockResolvedValue('sk-live-key')
  transcribeMock.mockResolvedValue('memo transcript')
  localModelStatusMock.mockResolvedValue({ status: 'ready' })
  transcribeLocallyMock.mockResolvedValue({
    outcome: 'transcribed',
    text: 'local transcript',
    segments: [{ startMs: 0, endMs: 1500, text: 'local transcript' }],
  })
  generateAudioMemoTitleMock.mockResolvedValue('Memo Transcript')
  formatAudioMemoTranscriptMock.mockResolvedValue({
    title: 'Planning the launch',
    body: 'We reviewed the launch.\n\n## Next steps\n\n- Invite beta users',
  })
  ensureBacklinkTargetMock.mockResolvedValue('Audio memos')
})

describe('audioMemoIdentity', () => {
  it('derives every name from the recording moment, in local time', () => {
    expect(MEMO).toEqual({
      base: 'audio-memo-2026-06-11-153022-845',
      date: '2026-06-11',
      title: 'Audio memo 2026-06-11 15:30:22',
      alias: 'Audio memo 15:30',
      audioPath: 'audio-memos/audio-memo-2026-06-11-153022-845.webm',
      notePath: 'notes/audio-memo-2026-06-11-153022-845.md',
      mimeType: 'audio/webm',
    })
  })

  it('stores an audio-only MP4 as .m4a — whisper sniffs by extension', () => {
    const memo = audioMemoIdentity(RECORDED_AT, 'audio/mp4')
    expect(memo.audioPath).toBe('audio-memos/audio-memo-2026-06-11-153022-845.m4a')
    expect(memo.mimeType).toBe('audio/mp4')
  })
})

describe('audioMemoFromPath', () => {
  it('round-trips the identity from the recording path', () => {
    expect(audioMemoFromPath(MEMO.audioPath)).toEqual(MEMO)
  })

  it('parses a part number that outgrew three digits', () => {
    const path = 'audio-memos/audio-memo-2026-06-11-153022-845.part-1000.webm'
    expect(audioMemoPartFromPath(path)).toEqual({ memo: MEMO, part: 1000, end: false })
    expect(audioMemoPartPath(MEMO, 1000, false)).toBe(path)
  })

  it('rejects everything that is not a well-formed memo recording', () => {
    expect(audioMemoFromPath('audio-memos/voice-note.mp3')).toBeNull()
    expect(audioMemoFromPath('audio-memos/audio-memo-2026-13-40-153022-845.webm')).toBeNull()
    expect(audioMemoFromPath('audio-memos/audio-memo-2026-06-11-993022-845.webm')).toBeNull()
    expect(audioMemoFromPath('assets/audio-memo-2026-06-11-153022-845.webm')).toBeNull()
    expect(audioMemoFromPath('notes/audio-memo-2026-06-11-153022-845.md')).toBeNull()
  })
})

describe('captureAudioMemoPart', () => {
  it('writes the segment base64-encoded under audio-memos/, pinned to the generation', async () => {
    const outcome = await captureAudioMemoPart({
      audio: { blob: new Blob(['audio'], { type: 'audio/webm' }) },
      mimeType: 'audio/webm;codecs=opus',
      recordedAt: RECORDED_AT,
      part: 1,
      end: false,
      generation: 3,
    })

    expect(outcome).toEqual({ ok: true, memo: MEMO })
    expect(writeAssetMock).toHaveBeenCalledWith(audioMemoPartPath(MEMO, 1, false), btoa('audio'), 3)
  })

  it('imports a segment the recorder already wrote to disk, bytes never crossing the IPC', async () => {
    const outcome = await captureAudioMemoPart({
      audio: { sourcePath: '/staging/recording-1.part-002-end.m4a' },
      mimeType: 'audio/mp4',
      recordedAt: RECORDED_AT,
      part: 2,
      end: true,
      generation: 3,
    })

    expect(outcome.ok).toBe(true)
    expect(importAudioMemoMock).toHaveBeenCalledWith(
      '/staging/recording-1.part-002-end.m4a',
      'audio-memos/audio-memo-2026-06-11-153022-845.part-002-end.m4a',
      3,
    )
    expect(writeAssetMock).not.toHaveBeenCalled()
  })

  it('reports a write failure as data — the caller retries with the same recording', async () => {
    writeAssetMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await captureAudioMemoPart({
      audio: { blob: new Blob(['audio'], { type: 'audio/webm' }) },
      mimeType: 'audio/webm',
      recordedAt: RECORDED_AT,
      part: 1,
      end: true,
      generation: 3,
    })

    expect(outcome).toEqual({ ok: false, message: 'disk full' })
  })
})

describe('reconcileAudioMemos', () => {
  it('does nothing when every memo already has its transcription note', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    listFilesMock.mockResolvedValue([fileMeta(MEMO.notePath)])

    const onPending = vi.fn()
    const outcome = await reconcile({ onPending })

    expect(outcome).toEqual({ pending: 0, transcribed: 0, rejected: 0, stopped: null })
    expect(onPending).toHaveBeenCalledWith(0)
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(getSecretMock).not.toHaveBeenCalled()
  })

  it('ignores stray files in audio-memos/ that are not memo recordings', async () => {
    listDirMock.mockResolvedValue([fileMeta('audio-memos/voice-note.mp3')])

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 0, transcribed: 0, rejected: 0, stopped: null })
    expect(transcribeMock).not.toHaveBeenCalled()
  })

  it('transcribes a pending memo, writes the note, then backlinks the daily note', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(getSecretMock).toHaveBeenCalledWith('ai-api-key:cfg-openai')
    expect(readAssetMock).toHaveBeenCalledWith(MEMO.audioPath, 3)
    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        apiKey: 'sk-live-key',
        mimeType: 'audio/webm',
      }),
    )
    const sent = transcribeMock.mock.calls[0]?.[0].audio
    expect(new TextDecoder().decode(await sent?.arrayBuffer())).toBe('audio-bytes')
    // The note lands first — it carries the transcript; the backlink follows.
    // The link targets the base (unique per recording), resolved through the
    // note's frontmatter alias; the title alone repeats within a second.
    // The note is only ever created, and the daily write names the bytes it
    // read.
    expect(createNoteMock.mock.calls).toEqual([
      [
        MEMO.notePath,
        '---\naliases: [audio-memo-2026-06-11-153022-845]\n---\n\n# Memo Transcript\n\nmemo transcript\n\n[Recording](audio-memos/audio-memo-2026-06-11-153022-845.webm)\n',
        3,
      ],
    ])
    expect(writeNoteMock.mock.calls).toEqual([
      [
        'daily/2026-06-11.md',
        'morning thoughts\n\n## [[Audio memos]]\n\n- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]\n',
        3,
        'morning thoughts\n',
      ],
    ])
    expect(createNoteMock.mock.invocationCallOrder[0]).toBeLessThan(
      writeNoteMock.mock.invocationCallOrder[0]!,
    )
    expect(ensureBacklinkTargetMock).toHaveBeenCalledWith('Audio memos', 3)
    expect(generateAudioMemoTitleMock).toHaveBeenCalledWith({
      credentials: {
        config: { ...PROVIDERS.providers[0], model: 'gpt-5.4-nano' },
        apiKey: 'sk-live-key',
      },
      fetchFn: undefined,
      transcript: 'memo transcript',
      fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
    })
    expect(formatAudioMemoTranscriptMock).not.toHaveBeenCalled()
  })

  it('transcribes on-device in place: no asset read, no provider call, timed segments cached', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])

    const outcome = await reconcile({
      engine: 'local',
      transcriptionLanguage: 'zh',
      transcriptionPrompt: 'Names: Ocavue',
      formatTranscript: true,
    })

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(transcribeLocallyMock).toHaveBeenCalledWith({
      path: MEMO.audioPath,
      generation: 3,
      model: 'large-v3-turbo',
      language: 'zh',
      prompt: 'Names: Ocavue',
    })
    expect(readAssetMock).not.toHaveBeenCalled()
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(writeTranscriptCacheMock).toHaveBeenCalledWith(
      'audio-memo-2026-06-11-153022-845.webm.json',
      JSON.stringify({
        text: 'local transcript',
        segments: [{ startMs: 0, endMs: 1500, text: 'local transcript' }],
      }),
      3,
    )
    expect(createNoteMock.mock.calls[0]?.[1]).toContain('\n\nlocal transcript\n')
    // Nothing leaves the device: no formatting pass, and the title is derived
    // locally (no credentials) even with a provider and auto-format configured.
    expect(formatAudioMemoTranscriptMock).not.toHaveBeenCalled()
    expect(generateAudioMemoTitleMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ credentials: expect.anything() }),
    )
    expect(getSecretMock).not.toHaveBeenCalled()
  })

  it('leaves memos pending while the on-device model is not downloaded', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    localModelStatusMock.mockResolvedValue({ status: 'missing' })

    const outcome = await reconcile({ engine: 'local' })

    expect(outcome).toEqual({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: {
        reason: 'config',
        message: 'The on-device transcription model is not downloaded.',
      },
    })
    expect(transcribeLocallyMock).not.toHaveBeenCalled()
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('sends the spoken-language choice to the cloud provider', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])

    await reconcile({ transcriptionLanguage: 'ja' })

    expect(transcribeMock).toHaveBeenCalledWith(expect.objectContaining({ language: 'ja' }))
    expect(localModelStatusMock).not.toHaveBeenCalled()
  })

  it('passes the transcription hint to every segment call', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])

    await reconcile({ transcriptionPrompt: 'Names: Ocavue' })

    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Names: Ocavue' }),
    )
  })

  it('formats and names a fresh transcript in one best-effort AI pass when enabled', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])

    const outcome = await reconcile({ formatTranscript: true })

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(formatAudioMemoTranscriptMock).toHaveBeenCalledWith({
      credentials: {
        config: { ...PROVIDERS.providers[0], model: 'gpt-5.4-nano' },
        apiKey: 'sk-live-key',
      },
      fetchFn: undefined,
      transcript: 'memo transcript',
      fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
    })
    expect(generateAudioMemoTitleMock).not.toHaveBeenCalled()
    expect(createNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining(
        '# Planning the launch\n\nWe reviewed the launch.\n\n## Next steps\n\n- Invite beta users\n\n[Recording](audio-memos/audio-memo-2026-06-11-153022-845.webm)\n',
      ),
      3,
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      expect.stringContaining('- [[audio-memo-2026-06-11-153022-845|Planning the launch]]'),
      3,
      'morning thoughts\n',
    )
  })

  it('uses the default Anthropic Haiku entry to name a memo when configured', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    getSecretMock.mockImplementation(async (name) =>
      name === 'ai-api-key:cfg-anthropic' ? 'sk-ant-live-key' : 'sk-live-key',
    )

    await reconcile({
      providers: {
        providers: [...PROVIDERS.providers, ANTHROPIC_CONFIG],
        defaultProviderId: ANTHROPIC_CONFIG.id,
      },
    })

    expect(getSecretMock).toHaveBeenCalledWith('ai-api-key:cfg-openai')
    expect(getSecretMock).toHaveBeenCalledWith('ai-api-key:cfg-anthropic')
    expect(generateAudioMemoTitleMock).toHaveBeenCalledWith({
      credentials: {
        config: { ...ANTHROPIC_CONFIG, model: 'claude-haiku-4-5' },
        apiKey: 'sk-ant-live-key',
      },
      fetchFn: undefined,
      transcript: 'memo transcript',
      fallbackTitle: 'Audio memo 2026-06-11 15:30:22',
    })
  })

  it('uses the working transcription key when the preferred enrichment key is missing', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    getSecretMock.mockImplementation(async (name) =>
      name === 'ai-api-key:cfg-anthropic' ? null : 'sk-live-key',
    )

    await reconcile({
      providers: {
        providers: [...PROVIDERS.providers, ANTHROPIC_CONFIG],
        defaultProviderId: ANTHROPIC_CONFIG.id,
      },
      formatTranscript: true,
    })

    expect(formatAudioMemoTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          config: { ...PROVIDERS.providers[0], model: 'gpt-5.4-nano' },
          apiKey: 'sk-live-key',
        },
      }),
    )
  })

  it('a provider-refused recording is tombstoned with a failure note; the pass continues', async () => {
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath), fileMeta(earlier.audioPath)])
    transcribeMock
      .mockRejectedValueOnce(
        new TranscriptionRejectedError('openai rejected the recording (413): too large'),
      )
      .mockResolvedValueOnce('second transcript')

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 2, transcribed: 1, rejected: 1, stopped: null })
    expect(createNoteMock).toHaveBeenCalledWith(
      earlier.notePath,
      expect.stringContaining(
        'Transcription failed: openai rejected the recording (413): too large',
      ),
      3,
    )
    expect(createNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('second transcript'),
      3,
    )
    expect(ensureBacklinkTargetMock).toHaveBeenCalledTimes(1)
  })

  it.each(['cloud', 'local'] as const)(
    'skips a recording the graph refuses to read (%s) and continues, writing nothing about it',
    async (engine) => {
      const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
      const earlierName = earlier.audioPath.slice(earlier.audioPath.lastIndexOf('/') + 1)
      listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath), fileMeta(earlier.audioPath)])
      const refused = {
        kind: 'traversal',
        message: `local-only notes and files never leave this machine: ${earlier.audioPath}`,
      }
      if (engine === 'cloud') {
        readAssetMock.mockRejectedValueOnce(refused)
      } else {
        transcribeLocallyMock.mockRejectedValueOnce(refused)
      }

      const outcome = await reconcile({ engine })

      expect(outcome).toEqual({ pending: 2, transcribed: 1, rejected: 0, stopped: null })
      expect(createNoteMock).toHaveBeenCalledWith(MEMO.notePath, expect.any(String), 3)
      for (const [path, content] of [...createNoteMock.mock.calls, ...writeNoteMock.mock.calls]) {
        expect(path).not.toBe(earlier.notePath)
        expect(content).not.toContain(earlierName)
      }
      for (const [name] of writeTranscriptCacheMock.mock.calls) {
        expect(name).not.toContain(earlierName)
      }
    },
  )

  it('a pause in sharing still stops the pass instead of skipping the recording', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readAssetMock.mockRejectedValueOnce({ kind: 'io', message: 'Sharing is paused' })

    const outcome = await reconcile()

    expect(outcome).toEqual({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'io', message: 'Sharing is paused' },
    })
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('a failed note write stops before the backlink — the transcript is never tombstoned away', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    createNoteMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await reconcile()

    expect(outcome).toEqual({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'io', message: 'disk full' },
    })
    // Only the note write was attempted: no backlink means no tombstone, so
    // the next pass retries this memo instead of dropping its transcript.
    expect(createNoteMock).toHaveBeenCalledTimes(1)
    expect(createNoteMock.mock.calls[0]?.[0]).toBe(MEMO.notePath)
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('creates the daily note when the day has none yet', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readNoteMock.mockRejectedValue({ kind: 'notFound', message: 'no such note' })

    await reconcile()

    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      '## [[Audio memos]]\n\n- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]\n',
      3,
      null,
    )
  })

  it('upgrades the legacy plain memo heading without creating a second section', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readNoteMock.mockResolvedValue(
      '## Audio memos\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n',
    )

    await reconcile()

    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      '## [[Audio memos]]\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]\n',
      3,
      '## Audio memos\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n',
    )
  })

  it('extends only the leading memo list, before later daily-note prose', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readNoteMock.mockResolvedValue(
      '## [[Audio memos]]\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n\nScratchpad for later.\n',
    )

    await reconcile()

    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      '## [[Audio memos]]\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]\n\nScratchpad for later.\n',
      3,
      '## [[Audio memos]]\n\n- [[audio-memo-2026-06-10-090000-000|Yesterday]]\n\nScratchpad for later.\n',
    )
  })

  it('uses the current title when the Audio memos note was renamed', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    ensureBacklinkTargetMock.mockResolvedValue('Voice notes')

    await reconcile()

    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      expect.stringContaining('## [[Voice notes]]'),
      3,
      'morning thoughts\n',
    )
  })

  it('stops before writing the transcript when the category note cannot be ensured', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    ensureBacklinkTargetMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await reconcile()

    expect(outcome).toEqual({
      pending: 1,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'io', message: 'disk full' },
    })
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
    expect(transcribeMock).toHaveBeenCalledTimes(1)
  })

  it('a daily-note backlink without the note is a tombstone — deletion stays deleted', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readNoteMock.mockResolvedValue(
      'notes\n\n[[audio-memo-2026-06-11-153022-845|Audio memo 15:30]]\n',
    )

    const onPending = vi.fn()
    const outcome = await reconcile({ onPending })

    expect(outcome).toEqual({ pending: 0, transcribed: 0, rejected: 0, stopped: null })
    expect(onPending).toHaveBeenCalledWith(0)
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it("a same-second sibling backlink is not this memo's tombstone", async () => {
    // Same second, different milliseconds: identical display titles, distinct
    // bases. The earlier sibling is fully done; the later one must still run.
    const sibling = audioMemoIdentity(new Date(2026, 5, 11, 15, 30, 22, 100), 'audio/webm')
    listDirMock.mockResolvedValue([fileMeta(sibling.audioPath), fileMeta(MEMO.audioPath)])
    listFilesMock.mockResolvedValue([fileMeta(sibling.notePath)])
    readNoteMock.mockResolvedValue(`notes\n\n[[${sibling.base}|Audio memo 15:30]]\n`)

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(formatAudioMemoTranscriptMock).not.toHaveBeenCalled()
    expect(createNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('memo transcript'),
      3,
    )
  })

  it('an empty transcript writes a placeholder note — silence must not retry forever', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    transcribeMock.mockResolvedValue('')

    const outcome = await reconcile({ formatTranscript: true })

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(formatAudioMemoTranscriptMock).not.toHaveBeenCalled()
    expect(createNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('No speech detected.'),
      3,
    )
  })

  it('transcribes oldest first, regardless of listing order', async () => {
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath), fileMeta(earlier.audioPath)])

    await reconcile()

    expect(readAssetMock.mock.calls.map(([path]) => path)).toEqual([
      earlier.audioPath,
      MEMO.audioPath,
    ])
    expect(readTranscriptCacheMock.mock.calls.map(([name]) => name)).toEqual([
      'audio-memo-2026-06-10-090000-000.m4a.json',
      'audio-memo-2026-06-11-153022-845.webm.json',
    ])
  })

  it('stops the pass on the first failure — the rest would fail the same way', async () => {
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    listDirMock.mockResolvedValue([fileMeta(earlier.audioPath), fileMeta(MEMO.audioPath)])
    transcribeMock.mockRejectedValue({ kind: 'network', message: 'provider down' })

    const outcome = await reconcile({ formatTranscript: true })

    expect(outcome).toEqual({
      pending: 2,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'network', message: 'provider down' },
    })
    expect(transcribeMock).toHaveBeenCalledTimes(1)
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('a memo that failed to transcribe drains on the next pass — e.g. the next app launch', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    transcribeMock.mockRejectedValueOnce({ kind: 'network', message: 'offline' })

    const offline = await reconcile()

    expect(offline).toMatchObject({ pending: 1, transcribed: 0, stopped: { reason: 'network' } })
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()

    // Nothing about the pending memo lives in memory: a later pass — the next
    // trigger, or the mount pass after an app restart — recomputes it from
    // the same on-disk state and drains it.
    const relaunched = await reconcile()

    expect(relaunched).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(createNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('memo transcript'),
      3,
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      expect.stringContaining('- [[audio-memo-2026-06-11-153022-845|Memo Transcript]]'),
      3,
      'morning thoughts\n',
    )
  })

  it('uses the timestamp fallback name for silence', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    transcribeMock.mockResolvedValue('')

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(generateAudioMemoTitleMock).not.toHaveBeenCalled()
    expect(createNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('# Audio memo 2026-06-11 15:30:22'),
      3,
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      expect.stringContaining(
        '- [[audio-memo-2026-06-11-153022-845|Audio memo 2026-06-11 15:30:22]]',
      ),
      3,
      'morning thoughts\n',
    )
  })

  it('the App Review demo key writes a canned transcript without any provider call', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    getSecretMock.mockResolvedValue(APP_REVIEW_STUB_KEY)

    const outcome = await reconcile({ formatTranscript: true })

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(transcribeMock).not.toHaveBeenCalled()
    expect(generateAudioMemoTitleMock).not.toHaveBeenCalled()
    expect(formatAudioMemoTranscriptMock).not.toHaveBeenCalled()
    expect(createNoteMock).toHaveBeenCalledWith(
      MEMO.notePath,
      expect.stringContaining('demo transcription'),
      3,
    )
    expect(writeNoteMock).toHaveBeenCalledWith(
      'daily/2026-06-11.md',
      expect.stringContaining(
        '- [[audio-memo-2026-06-11-153022-845|Audio memo 2026-06-11 15:30:22]]',
      ),
      3,
      'morning thoughts\n',
    )
  })

  it('reports a missing provider as config — the pass retries after settings change', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])

    const outcome = await reconcile({ providers: { providers: [], defaultProviderId: null } })

    expect(outcome).toMatchObject({
      pending: 1,
      transcribed: 0,
      stopped: { reason: 'config' },
    })
    expect(getSecretMock).not.toHaveBeenCalled()
  })

  it('reports a missing keychain entry as config', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    getSecretMock.mockResolvedValue(null)

    const outcome = await reconcile()

    expect(outcome).toMatchObject({ pending: 1, stopped: { reason: 'config' } })
    expect(outcome.stopped?.message).toMatch(/keychain/)
    expect(transcribeMock).not.toHaveBeenCalled()
  })

  it('the abort gate stops between memos', async () => {
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    listDirMock.mockResolvedValue([fileMeta(earlier.audioPath), fileMeta(MEMO.audioPath)])
    // The first memo checks at loop start, at its segment loop, after the
    // asset read, after the provider call, after category resolution, and
    // before the note write; stop at the next loop start.
    const isStale = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true)

    const outcome = await reconcile({ isStale })

    expect(outcome).toMatchObject({
      pending: 2,
      transcribed: 1,
      stopped: { reason: 'stale' },
    })
    expect(transcribeMock).toHaveBeenCalledTimes(1)
  })

  it('a graph switch during transcription stops before any write', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    let closed = false
    transcribeMock.mockImplementation(async () => {
      closed = true // the switch lands while the provider call is in flight
      return 'memo transcript'
    })

    const outcome = await reconcile({ isStale: () => closed })

    expect(outcome).toMatchObject({
      pending: 1,
      transcribed: 0,
      stopped: { reason: 'stale' },
    })
    expect(formatAudioMemoTranscriptMock).not.toHaveBeenCalled()
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('a graph switch during formatting stops before any write', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    let closed = false
    formatAudioMemoTranscriptMock.mockImplementation(async () => {
      closed = true
      return { title: 'Formatted title', body: 'Formatted transcript' }
    })

    const outcome = await reconcile({
      formatTranscript: true,
      isStale: () => closed,
    })

    expect(outcome).toMatchObject({
      pending: 1,
      transcribed: 0,
      stopped: { reason: 'stale' },
    })
    expect(formatAudioMemoTranscriptMock).toHaveBeenCalledTimes(1)
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('a graph switch during category resolution stops before any note write', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    let closed = false
    ensureBacklinkTargetMock.mockImplementation(async () => {
      closed = true
      return 'Audio memos'
    })

    const outcome = await reconcile({ isStale: () => closed })

    expect(outcome).toMatchObject({
      pending: 1,
      transcribed: 0,
      stopped: { reason: 'stale' },
    })
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })

  it('a listing failure is reported, never thrown — reconcile runs unattended', async () => {
    listDirMock.mockRejectedValue({ kind: 'noGraph', message: 'no graph open' })

    const outcome = await reconcile()

    expect(outcome).toEqual({
      pending: 0,
      transcribed: 0,
      rejected: 0,
      stopped: { reason: 'noGraph', message: 'no graph open' },
    })
  })
})

describe('reconcileAudioMemos daily-note handling', () => {
  it('rethrows daily-note read failures other than notFound — never writes blind', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    readNoteMock.mockRejectedValue({ kind: 'io', message: 'disk gone' })

    const outcome = await reconcile()

    expect(outcome).toMatchObject({ stopped: { reason: 'io', message: 'disk gone' } })
    expect(createNoteMock).not.toHaveBeenCalled()
    expect(writeNoteMock).not.toHaveBeenCalled()
  })
})

describe('reconcileAudioMemos never writes over a concurrent writer', () => {
  const DAILY = 'daily/2026-06-11.md'
  let store: FakeNoteStore

  beforeEach(() => {
    store = fakeNoteStore()
    readNoteMock.mockImplementation(store.readNote)
    writeNoteMock.mockImplementation(store.writeNote)
    createNoteMock.mockImplementation(store.createNoteIfAbsent)
  })

  it('keeps another device’s transcript byte-identical, adds no backlink, and moves on', async () => {
    const earlier = audioMemoIdentity(new Date(2026, 5, 10, 9, 0, 0, 0), 'audio/mp4')
    listDirMock.mockResolvedValue([fileMeta(earlier.audioPath), fileMeta(MEMO.audioPath)])
    const theirs = `---\naliases: [${earlier.base}]\n---\n\n# Transcribed on the phone\n`
    // The other device's note lands while this pass waits on the enrichment call.
    generateAudioMemoTitleMock.mockImplementationOnce(async () => {
      store.files.set(earlier.notePath, theirs)
      return 'Memo Transcript'
    })

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 2, transcribed: 1, rejected: 0, stopped: null })
    expect(store.files.get(earlier.notePath)).toBe(theirs)
    expect(store.files.has('daily/2026-06-10.md')).toBe(false)
    expect(store.files.get(MEMO.notePath)).toContain('memo transcript')
    expect(store.files.get(DAILY)).toContain(`[[${MEMO.base}|Memo Transcript]]`)
  })

  it('a stub-key pass that collides also leaves the existing file intact', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    getSecretMock.mockResolvedValue(APP_REVIEW_STUB_KEY)
    const theirs = '# Transcribed on the phone\n'
    ensureBacklinkTargetMock.mockImplementation(async () => {
      store.files.set(MEMO.notePath, theirs)
      return 'Audio memos'
    })

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 0, rejected: 0, stopped: null })
    expect(store.files.get(MEMO.notePath)).toBe(theirs)
    expect(store.files.has(DAILY)).toBe(false)
  })

  it('keeps a daily edit made between read and write, with exactly one backlink', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    store.files.set(DAILY, 'morning thoughts\n')
    let raced = false
    store.beforeWrite = (path) => {
      if (path === DAILY && !raced) {
        raced = true
        store.files.set(path, 'morning thoughts\nlunch with Ada\n')
      }
    }

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    const daily = store.files.get(DAILY) ?? ''
    expect(daily).toContain('lunch with Ada')
    expect(daily.split(`[[${MEMO.base}|`)).toHaveLength(2) // exactly one backlink
  })

  it('stops when the backlink arrived in the race instead of adding a second', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    const synced = `## [[Audio memos]]\n\n- [[${MEMO.base}|From the phone]]\n`
    store.beforeWrite = (path) => {
      if (path === DAILY) {
        store.files.set(path, synced)
      }
    }

    await reconcile()

    expect(store.files.get(DAILY)).toBe(synced)
    expect(store.refused).toBe(1)
  })

  it('skips the backlink after losing the race twice, keeping the transcript', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    let version = 0
    store.beforeWrite = (path) => {
      if (path === DAILY) {
        version += 1
        store.files.set(path, `edit ${version}\n`)
      }
    }

    const outcome = await reconcile()

    expect(outcome).toEqual({ pending: 1, transcribed: 1, rejected: 0, stopped: null })
    expect(store.files.get(MEMO.notePath)).toContain('memo transcript')
    expect(store.files.get(DAILY)).toBe('edit 2\n')
    expect(store.refused).toBe(2)
  })

  it('a real write failure on the daily note still stops the pass', async () => {
    listDirMock.mockResolvedValue([fileMeta(MEMO.audioPath)])
    writeNoteMock.mockRejectedValue({ kind: 'io', message: 'disk full' })

    const outcome = await reconcile()

    expect(outcome.stopped).toEqual({ reason: 'io', message: 'disk full' })
  })
})

describe('isSilentStop', () => {
  const stop = (reason: ReconcileStop['reason']): ReconcileStop => ({ reason, message: reason })

  it('treats the self-healing reasons as silent', () => {
    expect(isSilentStop(stop('network'))).toBe(true)
    expect(isSilentStop(stop('config'))).toBe(true)
    expect(isSilentStop(stop('stale'))).toBe(true)
  })

  it('treats unexpected reasons as worth surfacing', () => {
    expect(isSilentStop(stop('auth'))).toBe(false)
    expect(isSilentStop(stop('io'))).toBe(false)
    expect(isSilentStop(stop('unknown'))).toBe(false)
  })
})
