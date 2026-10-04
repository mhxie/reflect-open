import type { LocalTranscriptionModelId } from '../ai/local-transcription-models.ts'
import { transcribeLocally } from '../ai/local-transcription.ts'
import {
  TRANSCRIPTION_MAX_SEGMENT_BYTES,
  type TranscriptionProvider,
} from '../ai/provider-config.ts'
import { transcribeAudio } from '../ai/transcribe.ts'
import { TranscriptionRejectedError } from '../ai/transcribe-http.ts'
import { readAsset, readAssetBinary } from '../graph/commands.ts'
import { hasBinaryIpc } from '../ipc/bridge.ts'
import { base64ToBytes } from '../lib/base64.ts'
import type { SegmentTranscriber } from './audio-memo-session.ts'

/**
 * The two engines behind {@link SegmentTranscriber}. Both read the stored
 * segment from the issuing graph session only (`generation`), so a graph
 * switch mid-pass can never transcribe the new graph's same-named file.
 */

/**
 * The on-device engine has no request ceiling; this only fences off a file
 * no recorder could have produced.
 */
export const LOCAL_TRANSCRIPTION_MAX_SEGMENT_BYTES = 2 * 1024 * 1024 * 1024

export interface CloudSegmentTranscriberInput {
  provider: TranscriptionProvider
  apiKey: string
  /** User transcription hint, if any. */
  prompt: string
  /** ISO 639 code, or empty to let the provider detect it. */
  language: string
  generation: number
  fetchFn?: typeof fetch | undefined
  /** Consulted by the provider call before it bills anything. */
  isStale: () => boolean
}

/** Upload each segment's bytes to the configured BYOK provider. */
export function cloudSegmentTranscriber(input: CloudSegmentTranscriberInput): SegmentTranscriber {
  return {
    maxSegmentBytes: TRANSCRIPTION_MAX_SEGMENT_BYTES,
    transcribe: async (part) => {
      const bytes = hasBinaryIpc()
        ? await readAssetBinary(part.path, input.generation)
        : base64ToBytes(await readAsset(part.path, input.generation))
      const text = await transcribeAudio({
        provider: input.provider,
        apiKey: input.apiKey,
        prompt: input.prompt,
        language: input.language,
        audio: new Blob([bytes], { type: part.memo.mimeType }),
        mimeType: part.memo.mimeType,
        fetchFn: input.fetchFn,
        isStale: input.isStale,
      })
      return { text }
    },
  }
}

export interface LocalSegmentTranscriberInput {
  model: LocalTranscriptionModelId
  prompt: string
  language: string
  generation: number
}

/** Transcribe each segment in place with the on-device model. */
export function localSegmentTranscriber(input: LocalSegmentTranscriberInput): SegmentTranscriber {
  return {
    maxSegmentBytes: LOCAL_TRANSCRIPTION_MAX_SEGMENT_BYTES,
    transcribe: async (part) => {
      const transcript = await transcribeLocally({
        path: part.path,
        generation: input.generation,
        model: input.model,
        language: input.language,
        prompt: input.prompt,
      })
      if (transcript.outcome === 'undecodable') {
        // Final for these bytes: the session records one failure line
        // instead of retrying the file on every pass.
        throw new TranscriptionRejectedError(transcript.reason)
      }
      return { text: transcript.text, segments: transcript.segments }
    },
  }
}
