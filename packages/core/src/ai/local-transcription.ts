import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge.ts'
import { call } from '../ipc/invoke.ts'
import type { LocalTranscriptionModelId } from './local-transcription-models.ts'

/**
 * Typed bindings for on-device transcription (the Rust `local_transcription`
 * module, macOS only): whisper.cpp models downloaded on demand into app data.
 * Recordings are read in place from the graph and never leave the device.
 */

/** Byte counts for an active model download; absent until it is sized. */
export const localModelProgressSchema = z.object({
  downloaded: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
})

export const localModelStatusSchema = z.discriminatedUnion('status', [
  /** Not macOS: on-device transcription does not exist here. */
  z.object({ status: z.literal('unsupported') }),
  z.object({ status: z.literal('missing') }),
  z.object({
    status: z.literal('downloading'),
    progress: localModelProgressSchema.optional(),
  }),
  z.object({ status: z.literal('ready') }),
  /** The first download failed; nothing usable is on disk. */
  z.object({ status: z.literal('failed'), message: z.string() }),
])
export type LocalModelStatus = z.infer<typeof localModelStatusSchema>

const statusEventSchema = z.object({ model: z.string(), status: localModelStatusSchema })

/** One timed stretch of a recording, in milliseconds from its start. */
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
const localTranscriptSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('transcribed'),
    text: z.string(),
    segments: z.array(transcriptSegmentSchema),
  }),
  z.object({ outcome: z.literal('undecodable'), reason: z.string() }),
])
export type LocalTranscript = z.infer<typeof localTranscriptSchema>

/** What an upstream check found; empty when nothing is new or it was throttled. */
export const localModelUpdateReportSchema = z.object({
  /** A newer revision of the selected model's own file. */
  revision: z.object({ etag: z.string(), sizeBytes: z.number().int().nonnegative() }).nullable(),
  /** Newer model generations upstream, each reported once. */
  generations: z.array(z.string()),
})
export type LocalModelUpdateReport = z.infer<typeof localModelUpdateReportSchema>

/** The model's status (poll on mount; changes arrive via {@link subscribeLocalModelStatus}). */
export function localModelStatus(model: LocalTranscriptionModelId): Promise<LocalModelStatus> {
  return call('local_transcription_status', { model }, localModelStatusSchema)
}

/**
 * Download the model — or its newer upstream revision when one is on disk.
 * Rejects with the download's error; progress streams as status events.
 */
export function downloadLocalModel(model: LocalTranscriptionModelId): Promise<LocalModelStatus> {
  return call('local_transcription_download', { model }, localModelStatusSchema)
}

export function deleteLocalModel(model: LocalTranscriptionModelId): Promise<LocalModelStatus> {
  return call('local_transcription_delete', { model }, localModelStatusSchema)
}

export interface TranscribeLocallyInput {
  /** Graph-relative path under `audio-memos/`. */
  path: string
  /** Pins the read to the issuing graph session. */
  generation: number
  model: LocalTranscriptionModelId
  /** ISO 639-1 code; empty detects the language per recording. */
  language: string
  /** User transcription hint, used as the model's initial prompt. */
  prompt: string
}

/** Transcribe one stored recording on this device. */
export function transcribeLocally(input: TranscribeLocallyInput): Promise<LocalTranscript> {
  return call(
    'local_transcription_transcribe',
    {
      request: {
        path: input.path,
        generation: input.generation,
        model: input.model,
        language: input.language === '' ? null : input.language,
        prompt: input.prompt === '' ? null : input.prompt,
      },
    },
    localTranscriptSchema,
  )
}

/** Ask upstream for newer weights; throttled daily in Rust unless `force`. */
export function checkLocalModelUpdates(
  model: LocalTranscriptionModelId,
  force: boolean,
): Promise<LocalModelUpdateReport> {
  return call('local_transcription_check_updates', { model, force }, localModelUpdateReportSchema)
}

/** Stop offering the upstream revision `etag`. */
export async function skipLocalModelUpdate(etag: string): Promise<void> {
  await call('local_transcription_skip_update', { etag }, z.null())
}

/** Live status changes for every model (download progress, completion, failure). */
export function subscribeLocalModelStatus(
  handler: (model: string, status: LocalModelStatus) => void,
): Promise<Unlisten> {
  return getBridge().listen('local-transcription:status', (payload) => {
    const parsed = statusEventSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data.model, parsed.data.status)
    } else {
      console.error('invalid local-transcription:status payload:', parsed.error)
    }
  })
}
