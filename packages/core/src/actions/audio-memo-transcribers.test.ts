import { beforeEach, describe, expect, it, vi } from 'vitest'
import { transcribeLocally } from '../ai/local-transcription.ts'
import { TRANSCRIPTION_MAX_SEGMENT_BYTES } from '../ai/provider-config.ts'
import { transcribeAudio } from '../ai/transcribe.ts'
import { isTranscriptionRejected } from '../ai/transcribe-http.ts'
import { errorMessage } from '../errors.ts'
import { readAsset } from '../graph/commands.ts'
import { audioMemoIdentity } from './audio-memo.ts'
import type { AudioMemoPart } from './audio-memo-session.ts'
import {
  cloudSegmentTranscriber,
  LOCAL_TRANSCRIPTION_MAX_SEGMENT_BYTES,
  localSegmentTranscriber,
} from './audio-memo-transcribers.ts'

vi.mock('../graph/commands', () => ({ readAsset: vi.fn(), readAssetBinary: vi.fn() }))
vi.mock('../ai/transcribe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/transcribe.ts')>()),
  transcribeAudio: vi.fn(),
}))
vi.mock('../ai/local-transcription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ai/local-transcription.ts')>()),
  transcribeLocally: vi.fn(),
}))

const readAssetMock = vi.mocked(readAsset)
const transcribeAudioMock = vi.mocked(transcribeAudio)
const transcribeLocallyMock = vi.mocked(transcribeLocally)

const MEMO = audioMemoIdentity(new Date(2026, 5, 11, 15, 30, 22, 845), 'audio/mp4')
const PART: AudioMemoPart = {
  memo: MEMO,
  path: MEMO.audioPath,
  part: 1,
  end: true,
  placeholder: false,
  sizeBytes: 1024,
  modifiedMs: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  readAssetMock.mockResolvedValue(btoa('audio-bytes'))
  transcribeAudioMock.mockResolvedValue('cloud text')
  transcribeLocallyMock.mockResolvedValue({
    outcome: 'transcribed',
    text: 'local text',
    segments: [{ startMs: 0, endMs: 800, text: 'local text' }],
  })
})

describe('cloudSegmentTranscriber', () => {
  it('uploads the generation-pinned bytes with the hint and language', async () => {
    const isStale = (): boolean => false
    const transcriber = cloudSegmentTranscriber({
      provider: 'google',
      apiKey: 'key',
      prompt: 'Names: Ocavue',
      language: 'zh',
      generation: 7,
      isStale,
    })

    expect(transcriber.maxSegmentBytes).toBe(TRANSCRIPTION_MAX_SEGMENT_BYTES)
    expect(await transcriber.transcribe(PART)).toEqual({ text: 'cloud text' })
    expect(readAssetMock).toHaveBeenCalledWith(MEMO.audioPath, 7)
    expect(transcribeAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'google',
        apiKey: 'key',
        prompt: 'Names: Ocavue',
        language: 'zh',
        mimeType: 'audio/mp4',
        isStale,
      }),
    )
  })
})

describe('localSegmentTranscriber', () => {
  it('hands the path to the device engine and keeps its timing', async () => {
    const transcriber = localSegmentTranscriber({
      model: 'large-v3-turbo-q8_0',
      prompt: '',
      language: '',
      generation: 7,
    })

    expect(transcriber.maxSegmentBytes).toBe(LOCAL_TRANSCRIPTION_MAX_SEGMENT_BYTES)
    expect(await transcriber.transcribe(PART)).toEqual({
      text: 'local text',
      segments: [{ startMs: 0, endMs: 800, text: 'local text' }],
    })
    expect(transcribeLocallyMock).toHaveBeenCalledWith({
      path: MEMO.audioPath,
      generation: 7,
      model: 'large-v3-turbo-q8_0',
      language: '',
      prompt: '',
    })
    expect(readAssetMock).not.toHaveBeenCalled()
  })

  it('turns an undecodable recording into a final rejection', async () => {
    transcribeLocallyMock.mockResolvedValue({ outcome: 'undecodable', reason: 'not audio' })
    const transcriber = localSegmentTranscriber({
      model: 'large-v3-turbo',
      prompt: '',
      language: '',
      generation: 7,
    })

    const error = await transcriber.transcribe(PART).catch((caught: unknown) => caught)
    expect(isTranscriptionRejected(error)).toBe(true)
    expect(errorMessage(error)).toBe('not audio')
  })

  it('leaves any other failure retryable', async () => {
    const failure = { kind: 'io', message: 'the recording couldn’t be read' }
    transcribeLocallyMock.mockRejectedValue(failure)
    const transcriber = localSegmentTranscriber({
      model: 'large-v3-turbo',
      prompt: '',
      language: '',
      generation: 7,
    })

    const error = await transcriber.transcribe(PART).catch((caught: unknown) => caught)
    expect(error).toBe(failure)
    expect(isTranscriptionRejected(error)).toBe(false)
  })
})
