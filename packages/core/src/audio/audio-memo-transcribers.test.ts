import { describe, expect, it, vi } from 'vitest'
import { TRANSCRIPTION_MAX_SEGMENT_BYTES } from '../ai/provider-config.ts'
import { isTranscriptionRejected } from '../ai/transcribe-http.ts'
import { AppError, errorMessage } from '../errors.ts'
import {
  createTestAssetStoreService,
  createTestLocalTranscriptionService,
  createTestTranscriptionService,
} from '../testing/index.ts'
import { audioMemoIdentity } from './audio-memo.ts'
import type { AudioMemoPart } from './audio-memo-session.ts'
import {
  cloudSegmentTranscriber,
  LOCAL_TRANSCRIPTION_MAX_SEGMENT_BYTES,
  localSegmentTranscriber,
} from './audio-memo-transcribers.ts'

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

describe('cloudSegmentTranscriber', () => {
  it('uploads the generation-pinned bytes with the hint and languages', async () => {
    const assetStore = createTestAssetStoreService({ assets: { [MEMO.audioPath]: 'audio-bytes' } })
    const readBytes = vi.spyOn(assetStore, 'readBytes')
    const transcription = createTestTranscriptionService('cloud text')
    const isStale = (): boolean => false
    const transcriber = cloudSegmentTranscriber(
      { assetStore, transcription },
      {
        provider: 'google',
        apiKey: 'key',
        prompt: 'Names: Ocavue',
        languages: ['en', 'zh'],
        generation: 7,
        isStale,
      },
    )

    expect(transcriber.maxSegmentBytes).toBe(TRANSCRIPTION_MAX_SEGMENT_BYTES)
    expect(await transcriber.transcribe(PART)).toEqual({ text: 'cloud text' })
    expect(readBytes).toHaveBeenCalledWith(MEMO.audioPath, 7)
    expect(transcription.calls()).toEqual([
      expect.objectContaining({
        provider: 'google',
        apiKey: 'key',
        prompt: 'Names: Ocavue',
        languages: ['en', 'zh'],
        mimeType: 'audio/mp4',
        isStale,
      }),
    ])
  })
})

describe('localSegmentTranscriber', () => {
  it('hands the path to the device engine and keeps its timing', async () => {
    const localTranscription = createTestLocalTranscriptionService({
      transcripts: {
        [MEMO.audioPath]: {
          outcome: 'transcribed',
          text: 'local text',
          segments: [{ startMs: 0, endMs: 800, text: 'local text' }],
        },
      },
    })
    const transcriber = localSegmentTranscriber(localTranscription, {
      model: 'large-v3-turbo-q8_0',
      prompt: '',
      languages: ['en', 'zh'],
      generation: 7,
    })

    expect(transcriber.maxSegmentBytes).toBe(LOCAL_TRANSCRIPTION_MAX_SEGMENT_BYTES)
    expect(await transcriber.transcribe(PART)).toEqual({
      text: 'local text',
      segments: [{ startMs: 0, endMs: 800, text: 'local text' }],
    })
    expect(localTranscription.transcribeCalls()).toEqual([
      {
        path: MEMO.audioPath,
        generation: 7,
        model: 'large-v3-turbo-q8_0',
        languages: ['en', 'zh'],
        prompt: '',
      },
    ])
  })

  it('turns an undecodable recording into a final rejection', async () => {
    const localTranscription = createTestLocalTranscriptionService({
      transcripts: { [MEMO.audioPath]: { outcome: 'undecodable', reason: 'not audio' } },
    })
    const transcriber = localSegmentTranscriber(localTranscription, {
      model: 'large-v3-turbo',
      prompt: '',
      languages: [],
      generation: 7,
    })

    const error = await transcriber.transcribe(PART).catch((caught: unknown) => caught)
    expect(isTranscriptionRejected(error)).toBe(true)
    expect(errorMessage(error)).toBe('not audio')
  })

  it('leaves any other failure retryable', async () => {
    const failure = new AppError('io', 'the recording couldn’t be read')
    const localTranscription = createTestLocalTranscriptionService()
    vi.spyOn(localTranscription, 'transcribe').mockRejectedValue(failure)
    const transcriber = localSegmentTranscriber(localTranscription, {
      model: 'large-v3-turbo',
      prompt: '',
      languages: [],
      generation: 7,
    })

    const error = await transcriber.transcribe(PART).catch((caught: unknown) => caught)
    expect(error).toBe(failure)
    expect(isTranscriptionRejected(error)).toBe(false)
  })
})
