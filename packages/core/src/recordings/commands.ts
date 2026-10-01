import { z } from 'zod'
import { transcriptSegmentSchema } from '../ai/local-transcription.ts'
import { getBridge, type Unlisten } from '../ipc/bridge.ts'
import { call } from '../ipc/invoke.ts'

/**
 * Typed bindings for the Rust recorder (`apps/desktop/src-tauri/src/recorder/`,
 * macOS 14.2+), which every recording on the Mac goes through: two channels
 * (microphone = Me, system audio = Them), per-channel on-device
 * transcription, and archiving the audio. Recordings wait in a local staging
 * area outside any graph until `reconcileRecordings` has written their
 * transcript; nothing here touches the network.
 */

export const recorderStatusSchema = z.object({
  /** False below macOS 14.2 and off macOS: there are no process taps. */
  supported: z.boolean(),
  /** Where recordings are archived when the user hasn't chosen a folder. */
  defaultRecordingsFolder: z.string(),
  recording: z
    .object({
      sessionId: z.string(),
      startedAtMs: z.number(),
      /** Watchdog codes raised so far, e.g. `noAudio`, `microphoneSilent`. */
      warnings: z.array(z.string()),
    })
    .nullable(),
})
export type RecorderStatus = z.infer<typeof recorderStatusSchema>

/** A stopped recording still in staging. */
export const finishedRecordingSchema = z.object({
  id: z.string(),
  startedAtMs: z.number(),
  endedAtMs: z.number(),
  /** A transcript is cached, so finishing it needs no model run. */
  transcribed: z.boolean(),
  warnings: z.array(z.string()),
})
export type FinishedRecording = z.infer<typeof finishedRecordingSchema>

/** Both channels of one recording, timed from its start. */
export const recordingChannelsSchema = z.object({
  model: z.string(),
  durationMs: z.number(),
  me: z.array(transcriptSegmentSchema),
  them: z.array(transcriptSegmentSchema),
  /** The microphone was gated against the speakers (no headphones). */
  echoSuppressed: z.boolean(),
  /** Nothing played through the Mac: the far end was silent, or system
   * audio recording isn't allowed. */
  systemSilent: z.boolean(),
})
export type RecordingChannels = z.infer<typeof recordingChannelsSchema>

const warningEventSchema = z.object({ sessionId: z.string(), code: z.string() })
const recordedEventSchema = z.object({ sessionId: z.string() })

export function recorderStatus(): Promise<RecorderStatus> {
  return call('recorder_status', {}, recorderStatusSchema)
}

/** Start recording; a no-op while one runs. */
export function startRecorder(): Promise<RecorderStatus> {
  return call('recorder_start', {}, recorderStatusSchema)
}

/** Stop recording; the recording waits in staging for `reconcileRecordings`. */
export function stopRecorder(): Promise<RecorderStatus> {
  return call('recorder_stop', {}, recorderStatusSchema)
}

/** Stop and discard the recording: nothing is transcribed or kept. */
export function cancelRecorder(): Promise<RecorderStatus> {
  return call('recorder_cancel', {}, recorderStatusSchema)
}

/** Stopped recordings still in staging, oldest first. */
export function finishedRecordings(): Promise<FinishedRecording[]> {
  return call('recorder_sessions', {}, z.array(finishedRecordingSchema))
}

export interface TranscribeRecordingInput {
  sessionId: string
  /** An on-device model id (`LocalTranscriptionModelId`). */
  model: string
  /** ISO 639 code; empty detects the language per stretch of speech. */
  language: string
  /** Vocabulary hint: the user's helper text plus a meeting's names. */
  prompt: string
}

/** Transcribe both channels on this device; cached per model in staging. */
export function transcribeRecording(input: TranscribeRecordingInput): Promise<RecordingChannels> {
  return call(
    'recorder_transcribe',
    {
      request: {
        sessionId: input.sessionId,
        model: input.model,
        language: input.language === '' ? null : input.language,
        prompt: input.prompt === '' ? null : input.prompt,
      },
    },
    recordingChannelsSchema,
  )
}

/** Encode the recording into `destination` (an absolute `.m4a` path) and
 * remove it from staging. */
export async function archiveRecording(sessionId: string, destination: string): Promise<void> {
  await call('recorder_archive', { request: { sessionId, destination } }, z.null())
}

export interface RecorderConfig {
  menuBar: boolean
  /** An accelerator such as `Control+Option+Command+M`; empty turns it off. */
  shortcut: string
  /** The archive folder the menu bar's "Open Recordings Folder" opens. */
  recordingsFolder: string
}

/** Apply the menu bar and shortcut settings. Rejects with a `parse` error
 * for a shortcut the OS can't register. */
export async function configureRecorder(config: RecorderConfig): Promise<void> {
  await call(
    'recorder_configure',
    {
      config: {
        menuBar: config.menuBar,
        shortcut: config.shortcut === '' ? null : config.shortcut,
        recordingsFolder: config.recordingsFolder === '' ? null : config.recordingsFolder,
      },
    },
    z.null(),
  )
}

/** Live recording state: started, stopped, or a new watchdog warning. */
export function subscribeRecorderStatus(
  handler: (status: RecorderStatus) => void,
): Promise<Unlisten> {
  return getBridge().listen('recorder:status', (payload) => {
    const parsed = recorderStatusSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      console.error('invalid recorder:status payload:', parsed.error)
    }
  })
}

/** Watchdog warnings (`noAudio`, `microphoneSilent`, `idle`) and a failed
 * start from the menu bar or shortcut (`startFailed`). */
export function subscribeRecorderWarnings(
  handler: (code: string, sessionId: string) => void,
): Promise<Unlisten> {
  return getBridge().listen('recorder:warning', (payload) => {
    const parsed = warningEventSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data.code, parsed.data.sessionId)
    } else {
      console.error('invalid recorder:warning payload:', parsed.error)
    }
  })
}

/** A recording stopped and is ready to transcribe. */
export function subscribeRecorderFinished(handler: (sessionId: string) => void): Promise<Unlisten> {
  return getBridge().listen('recorder:recorded', (payload) => {
    const parsed = recordedEventSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data.sessionId)
    } else {
      console.error('invalid recorder:recorded payload:', parsed.error)
    }
  })
}

/** The live input level (0 to 1, the louder side) for the recording waveform,
 * about sixteen times a second while recording. */
export function subscribeRecorderLevel(handler: (level: number) => void): Promise<Unlisten> {
  return getBridge().listen('recorder:level', (payload) => {
    const parsed = z.number().safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    }
  })
}
