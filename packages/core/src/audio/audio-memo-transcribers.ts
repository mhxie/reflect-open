import type { LocalTranscriptionModelId } from '../ai/local-transcription-models.ts'
import type { LocalTranscriptionService } from '../ai/local-transcription-service.ts'
import {
  TRANSCRIPTION_MAX_SEGMENT_BYTES,
  type TranscriptionProvider,
} from '../ai/provider-config.ts'
import { TranscriptionRejectedError } from '../ai/transcribe-http.ts'
import type { TranscriptionService } from '../ai/transcription-service.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
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
  /**
   * User transcription hint, if any.
   */
  prompt: string
  /**
   * Spoken languages as ISO 639 codes; empty lets the provider detect any.
   */
  languages: readonly string[]
  generation: number
  /**
   * Consulted by the provider call before it bills anything.
   */
  isStale: () => boolean
}

/**
 * Upload each segment's bytes to the configured BYOK provider.
 */
export function cloudSegmentTranscriber(
  services: {
    readonly assetStore: AssetStoreService
    readonly transcription: TranscriptionService
  },
  input: CloudSegmentTranscriberInput,
): SegmentTranscriber {
  return {
    maxSegmentBytes: TRANSCRIPTION_MAX_SEGMENT_BYTES,
    transcribe: async (part) => {
      const bytes = await services.assetStore.readBytes(part.path, input.generation)
      const text = await services.transcription.transcribe({
        provider: input.provider,
        apiKey: input.apiKey,
        prompt: input.prompt,
        languages: input.languages,
        audio: new Blob([bytes], { type: part.memo.mimeType }),
        mimeType: part.memo.mimeType,
        isStale: input.isStale,
      })
      return { text }
    },
  }
}

export interface LocalSegmentTranscriberInput {
  model: LocalTranscriptionModelId
  prompt: string
  /**
   * Spoken languages as ISO 639 codes; empty detects any.
   */
  languages: readonly string[]
  generation: number
}

/**
 * Transcribe each segment in place with the on-device model.
 */
export function localSegmentTranscriber(
  localTranscription: LocalTranscriptionService,
  input: LocalSegmentTranscriberInput,
): SegmentTranscriber {
  return {
    maxSegmentBytes: LOCAL_TRANSCRIPTION_MAX_SEGMENT_BYTES,
    transcribe: async (part) => {
      const transcript = await localTranscription.transcribe({
        path: part.path,
        generation: input.generation,
        model: input.model,
        languages: input.languages,
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
