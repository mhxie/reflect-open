import { z } from 'zod'
import { transcriptSegmentSchema } from '../ai/local-transcription.ts'
import { errorMessage } from '../errors.ts'
import { createFanOut, listenNow, type FanOut, type IpcBridgeService } from '../ipc/ipc-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { PlatformFacts } from '../ports/platform-facts.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * The Rust recorder (`apps/desktop/src-tauri/src/recorder/`, macOS 14.2+),
 * which every recording on the Mac goes through: two channels (microphone =
 * Me, system audio = Them), per-channel on-device transcription, and
 * archiving the audio. Recordings wait in a local staging area outside any
 * graph until `RecordingService.reconcile` has written their transcript;
 * nothing here touches the network.
 */

export const recorderStatusSchema = z.object({
  /**
   * False below macOS 14.2 and off macOS: there are no process taps.
   */
  supported: z.boolean(),
  /**
   * Where recordings are archived when the user hasn't chosen a folder.
   */
  defaultRecordingsFolder: z.string(),
  recording: z
    .object({
      sessionId: z.string(),
      startedAtMs: z.number(),
      /**
       * Watchdog codes raised so far, e.g. `noAudio`, `microphoneSilent`.
       */
      warnings: z.array(z.string()),
    })
    .nullable(),
})

/**
 * Whether the native recorder exists here, and what it is recording.
 */
export type RecorderStatus = z.infer<typeof recorderStatusSchema>

/**
 * A stopped recording still in staging.
 */
export const finishedRecordingSchema = z.object({
  id: z.string(),
  startedAtMs: z.number(),
  endedAtMs: z.number(),
  /**
   * A transcript is cached, so finishing it needs no model run.
   */
  transcribed: z.boolean(),
  warnings: z.array(z.string()),
})

export type FinishedRecording = z.infer<typeof finishedRecordingSchema>

/**
 * Both channels of one recording, timed from its start.
 */
export const recordingChannelsSchema = z.object({
  model: z.string(),
  durationMs: z.number(),
  me: z.array(transcriptSegmentSchema),
  them: z.array(transcriptSegmentSchema),
  /**
   * The microphone was gated against the speakers (no headphones).
   */
  echoSuppressed: z.boolean(),
  /**
   * Nothing played through the Mac: the far end was silent, or system audio
   * recording isn't allowed.
   */
  systemSilent: z.boolean(),
})

export type RecordingChannels = z.infer<typeof recordingChannelsSchema>

const warningEventSchema = z.object({ sessionId: z.string(), code: z.string() })
const recordedEventSchema = z.object({ sessionId: z.string() })

export interface TranscribeRecordingInput {
  sessionId: string
  /**
   * An on-device model id (`LocalTranscriptionModelId`).
   */
  model: string
  /**
   * Spoken languages as ISO 639 codes; empty detects any per stretch of speech.
   */
  languages: readonly string[]
  /**
   * Vocabulary hint: the user's helper text plus a meeting's names.
   */
  prompt: string
}

export interface RecorderConfig {
  menuBar: boolean
  /**
   * An accelerator such as `Control+Option+Command+M`; empty turns it off.
   */
  shortcut: string
  /**
   * The archive folder the menu bar's "Open Recordings Folder" opens.
   */
  recordingsFolder: string
}

/**
 * The recorder's status before the native side answers, and wherever there is none.
 */
export const IDLE_RECORDER_STATUS: RecorderStatus = {
  supported: false,
  defaultRecordingsFolder: '',
  recording: null,
}

export interface RecorderServiceDeps {
  readonly ipc: IpcBridgeService
  readonly platform: PlatformFacts
  readonly progress: ProgressPort
  readonly logger: LoggerService
}

/**
 * The native recorder of the Mac as a service: its live status as a store,
 * the start/stop/cancel controls the audio-memo surface, the palette and the
 * menu bar share, the menu bar and shortcut configuration, and the staged
 * recordings the recording pass finishes. Capture keeps going with every
 * window hidden; the menu bar item and the global shortcut reach it from any
 * app. Outside the native shell the recorder is never asked and reads as
 * unsupported.
 */
export interface RecorderService {
  /**
   * The recorder's live status. Followed from the native side while anything
   * is subscribed; {@link IDLE_RECORDER_STATUS} until it answers.
   */
  getState: () => RecorderStatus
  /**
   * Listen for status changes; the first subscriber starts following the
   * native status, the last one to leave stops it.
   */
  subscribe: (listener: () => void) => Unlisten
  /**
   * Start recording, or stop and stage the recording that runs. A failure is
   * reported as a failed `Recording` operation, never a rejection.
   */
  toggleRecording(): Promise<void>
  /**
   * Stop and discard the live recording: nothing is transcribed or kept.
   * A failure is reported as a failed `Recording` operation.
   */
  cancelRecording(): Promise<void>
  /**
   * Apply the menu bar and shortcut settings. Rejects with a `parse` error
   * for a shortcut the OS can't register.
   */
  configure(config: RecorderConfig): Promise<void>
  /**
   * Stopped recordings still in staging, oldest first.
   */
  finishedRecordings(): Promise<FinishedRecording[]>
  /**
   * Transcribe both channels of a staged recording on this device; cached per
   * model in staging.
   */
  transcribe(input: TranscribeRecordingInput): Promise<RecordingChannels>
  /**
   * Encode the recording into `destination` (an absolute `.m4a` path) and
   * remove it from staging.
   */
  archive(sessionId: string, destination: string): Promise<void>
  /**
   * Watchdog warnings (`noAudio`, `microphoneSilent`, `idle`, ...) and a
   * failed start from the menu bar or shortcut (`startFailed`).
   */
  onWarning(listener: (code: string, sessionId: string) => void): Unlisten
  /**
   * A recording stopped and is ready to transcribe.
   */
  onFinished(listener: (sessionId: string) => void): Unlisten
  /**
   * The live input level (0 to 1, the louder side) for the recording
   * waveform, about sixteen times a second while recording. All listeners
   * share one native subscription.
   */
  subscribeLevel(listener: (level: number) => void): Unlisten
}

class RecorderServiceImpl implements RecorderService {
  readonly #deps: RecorderServiceDeps
  readonly #listeners = new Set<() => void>()
  readonly #levels: FanOut<number>
  #status: RecorderStatus = IDLE_RECORDER_STATUS
  #stopFollowing: Unlisten | null = null

  constructor(deps: RecorderServiceDeps) {
    this.#deps = deps
    this.#levels = createFanOut<number>((emit) =>
      this.#listen('recorder:level', (payload) => {
        const parsed = z.number().safeParse(payload)
        if (parsed.success) {
          emit(parsed.data)
        }
      }),
    )
  }

  readonly getState = (): RecorderStatus => this.#status

  readonly subscribe = (listener: () => void): Unlisten => {
    const entry = (): void => {
      listener()
    }
    this.#listeners.add(entry)
    if (this.#stopFollowing === null) {
      this.#follow()
    }
    return () => {
      this.#listeners.delete(entry)
      if (this.#listeners.size === 0 && this.#stopFollowing !== null) {
        this.#stopFollowing()
        this.#stopFollowing = null
      }
    }
  }

  async toggleRecording(): Promise<void> {
    const command = this.#status.recording === null ? 'recorder_start' : 'recorder_stop'
    await this.#control(command)
  }

  async cancelRecording(): Promise<void> {
    await this.#control('recorder_cancel')
  }

  async configure(config: RecorderConfig): Promise<void> {
    await this.#deps.ipc.call(
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

  finishedRecordings(): Promise<FinishedRecording[]> {
    return this.#deps.ipc.call('recorder_sessions', {}, z.array(finishedRecordingSchema))
  }

  transcribe(input: TranscribeRecordingInput): Promise<RecordingChannels> {
    return this.#deps.ipc.call(
      'recorder_transcribe',
      {
        request: {
          sessionId: input.sessionId,
          model: input.model,
          languages: input.languages,
          prompt: input.prompt === '' ? null : input.prompt,
        },
      },
      recordingChannelsSchema,
    )
  }

  async archive(sessionId: string, destination: string): Promise<void> {
    await this.#deps.ipc.call('recorder_archive', { request: { sessionId, destination } }, z.null())
  }

  onWarning(listener: (code: string, sessionId: string) => void): Unlisten {
    const { logger } = this.#deps
    return this.#listen('recorder:warning', (payload) => {
      const parsed = warningEventSchema.safeParse(payload)
      if (parsed.success) {
        listener(parsed.data.code, parsed.data.sessionId)
      } else {
        logger.error('invalid recorder:warning payload:', parsed.error)
      }
    })
  }

  onFinished(listener: (sessionId: string) => void): Unlisten {
    const { logger } = this.#deps
    return this.#listen('recorder:recorded', (payload) => {
      const parsed = recordedEventSchema.safeParse(payload)
      if (parsed.success) {
        listener(parsed.data.sessionId)
      } else {
        logger.error('invalid recorder:recorded payload:', parsed.error)
      }
    })
  }

  subscribeLevel(listener: (level: number) => void): Unlisten {
    return this.#levels.subscribe(listener)
  }

  /**
   * Read the status once and follow its change events.
   */
  #follow(): void {
    const { ipc, logger } = this.#deps
    this.#stopFollowing = this.#listen('recorder:status', (payload) => {
      const parsed = recorderStatusSchema.safeParse(payload)
      if (parsed.success) {
        this.#setStatus(parsed.data)
      } else {
        logger.error('invalid recorder:status payload:', parsed.error)
      }
    })
    if (!this.#deps.platform.isNativeShell) {
      return
    }
    ipc.call('recorder_status', {}, recorderStatusSchema).then(
      (status) => {
        if (this.#stopFollowing !== null) {
          this.#setStatus(status)
        }
      },
      (cause: unknown) => {
        logger.error('recorder status failed:', cause)
      },
    )
  }

  /**
   * Subscribe to a native recorder event; nothing outside the native shell.
   */
  #listen(event: string, handler: (payload: unknown) => void): Unlisten {
    const { ipc, platform, logger } = this.#deps
    if (!platform.isNativeShell) {
      return () => {}
    }
    return listenNow(
      () => ipc.listen(event, handler),
      (cause) => {
        logger.error(`${event} subscription failed:`, cause)
      },
    )
  }

  async #control(command: 'recorder_start' | 'recorder_stop' | 'recorder_cancel'): Promise<void> {
    try {
      this.#setStatus(await this.#deps.ipc.call(command, {}, recorderStatusSchema))
    } catch (cause) {
      this.#deps.progress.fail('Recording', errorMessage(cause))
    }
  }

  #setStatus(next: RecorderStatus): void {
    this.#status = next
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

export function createRecorderService(deps: RecorderServiceDeps): RecorderService {
  return new RecorderServiceImpl(deps)
}
