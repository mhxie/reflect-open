import { z } from 'zod'
import type { LocalTranscriptionModelId } from './local-transcription-models.ts'

/**
 * On-device transcription (the Rust `local_transcription` module, macOS
 * only): Whisper and Qwen3-ASR models downloaded on demand into app data.
 * Recordings are read in place from the graph and never leave the device.
 */

/**
 * Byte counts for an active model download; absent until it is sized.
 */
const localModelProgressSchema = z.object({
  downloaded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})

export const localModelStatusSchema = z.discriminatedUnion('status', [
  /**
   * Not macOS: on-device transcription does not exist here.
   */
  z.object({ status: z.literal('unsupported') }),
  z.object({ status: z.literal('missing') }),
  z.object({
    status: z.literal('downloading'),
    progress: localModelProgressSchema.optional(),
  }),
  z.object({ status: z.literal('ready') }),
  /**
   * The first download failed; nothing usable is on disk.
   */
  z.object({ status: z.literal('failed'), message: z.string() }),
])
export type LocalModelStatus = z.infer<typeof localModelStatusSchema>

/**
 * One timed stretch of a recording, in milliseconds from its start.
 */
export const transcriptSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
})
export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>

/**
 * What the device concluded about one recording. `undecodable` is an answer
 * about the bytes, not a failed call: retrying the same file can't change it.
 */
export const localTranscriptSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('transcribed'),
    text: z.string(),
    segments: z.array(transcriptSegmentSchema),
  }),
  z.object({ outcome: z.literal('undecodable'), reason: z.string() }),
])
export type LocalTranscript = z.infer<typeof localTranscriptSchema>

/**
 * What an upstream check found; empty when nothing is new or it was throttled.
 */
export const localModelUpdateReportSchema = z.object({
  /**
   * A newer revision of the selected model's own file.
   */
  revision: z.object({ etag: z.string(), sizeBytes: z.number().int().nonnegative() }).nullable(),
  /**
   * Newer model generations upstream, each reported once.
   */
  generations: z.array(z.string()),
})
export type LocalModelUpdateReport = z.infer<typeof localModelUpdateReportSchema>

export interface TranscribeLocallyInput {
  /**
   * Graph-relative path under `audio-memos/`.
   */
  path: string
  /**
   * Pins the read to the issuing graph session.
   */
  generation: number
  model: LocalTranscriptionModelId
  /**
   * Spoken languages as ISO 639 codes; empty detects any.
   */
  languages: readonly string[]
  /**
   * User transcription hint, used as the model's initial prompt.
   */
  prompt: string
}
