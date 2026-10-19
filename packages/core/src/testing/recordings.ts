import {
  IDLE_RECORDER_STATUS,
  type FinishedRecording,
  type RecorderConfig,
  type RecorderService,
  type RecorderStatus,
  type RecordingChannels,
  type TranscribeRecordingInput,
} from '../recordings/recorder-service.ts'
import type { Unlisten } from '../unlisten.ts'

export interface TestRecorderServiceOptions {
  /**
   * What the recorder reports. Defaults to {@link IDLE_RECORDER_STATUS}: no
   * native recorder, as off a Mac.
   */
  status?: RecorderStatus
  /**
   * The stopped recordings in staging, oldest first.
   */
  finished?: readonly FinishedRecording[]
  /**
   * What `transcribe` answers for every recording; empty channels by default.
   */
  channels?: RecordingChannels
  /**
   * The time a recording started or stopped through the controls reports.
   * Defaults to 0.
   */
  now?: () => number
}

/**
 * A control call the fake received.
 */
export type TestRecorderCall =
  | { method: 'toggleRecording' }
  | { method: 'cancelRecording' }
  | { method: 'configure'; config: RecorderConfig }
  | { method: 'transcribe'; input: TranscribeRecordingInput }
  | { method: 'archive'; sessionId: string; destination: string }

export interface TestRecorderService extends RecorderService {
  /**
   * Every control call, in order.
   */
  calls(): readonly TestRecorderCall[]
  /**
   * Report `status` as the native side would, notifying subscribers.
   */
  setStatus(status: RecorderStatus): void
  /**
   * Replace the stopped recordings `finishedRecordings` lists.
   */
  setFinished(finished: readonly FinishedRecording[]): void
  /**
   * Deliver a watchdog warning to every `onWarning` listener.
   */
  emitWarning(code: string, sessionId: string): void
  /**
   * Deliver a stopped recording to every `onFinished` listener.
   */
  emitFinished(sessionId: string): void
  /**
   * Deliver a live input level to every `subscribeLevel` listener.
   */
  emitLevel(level: number): void
}

class TestRecorderServiceImpl implements TestRecorderService {
  readonly #now: () => number
  readonly #channels: RecordingChannels | null
  readonly #log: TestRecorderCall[] = []
  readonly #listeners = new Set<() => void>()
  readonly #warningListeners = new Set<(code: string, sessionId: string) => void>()
  readonly #finishedListeners = new Set<(sessionId: string) => void>()
  readonly #levelListeners = new Set<(level: number) => void>()
  #status: RecorderStatus
  #finished: FinishedRecording[]
  #recordings = 0

  constructor(options?: TestRecorderServiceOptions) {
    this.#status = options?.status ?? IDLE_RECORDER_STATUS
    this.#finished = [...(options?.finished ?? [])]
    this.#channels = options?.channels ?? null
    this.#now = options?.now ?? (() => 0)
  }

  readonly getState = (): RecorderStatus => this.#status

  readonly subscribe = (listener: () => void): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    return () => {
      this.#listeners.delete(deliver)
    }
  }

  async toggleRecording(): Promise<void> {
    this.#log.push({ method: 'toggleRecording' })
    if (!this.#status.supported) {
      return
    }
    const live = this.#status.recording
    if (live === null) {
      this.#recordings += 1
      this.setStatus({
        ...this.#status,
        recording: {
          sessionId: `recording-${this.#recordings}`,
          startedAtMs: this.#now(),
          warnings: [],
        },
      })
      return
    }
    // Stopping stages the recording for the recording pass, as the native side does.
    this.#finished.push({
      id: live.sessionId,
      startedAtMs: live.startedAtMs,
      endedAtMs: this.#now(),
      transcribed: false,
      warnings: [...live.warnings],
    })
    this.setStatus({ ...this.#status, recording: null })
    this.emitFinished(live.sessionId)
  }

  async cancelRecording(): Promise<void> {
    this.#log.push({ method: 'cancelRecording' })
    if (this.#status.recording !== null) {
      this.setStatus({ ...this.#status, recording: null })
    }
  }

  async configure(config: RecorderConfig): Promise<void> {
    this.#log.push({ method: 'configure', config })
  }

  async finishedRecordings(): Promise<FinishedRecording[]> {
    return [...this.#finished]
  }

  async transcribe(input: TranscribeRecordingInput): Promise<RecordingChannels> {
    this.#log.push({ method: 'transcribe', input })
    return (
      this.#channels ?? {
        model: input.model,
        durationMs: 0,
        me: [],
        them: [],
        echoSuppressed: false,
        systemSilent: false,
      }
    )
  }

  async archive(sessionId: string, destination: string): Promise<void> {
    this.#log.push({ method: 'archive', sessionId, destination })
    this.#finished = this.#finished.filter((recording) => recording.id !== sessionId)
  }

  onWarning(listener: (code: string, sessionId: string) => void): Unlisten {
    const deliver = (code: string, sessionId: string): void => {
      listener(code, sessionId)
    }
    this.#warningListeners.add(deliver)
    return () => {
      this.#warningListeners.delete(deliver)
    }
  }

  onFinished(listener: (sessionId: string) => void): Unlisten {
    const deliver = (sessionId: string): void => {
      listener(sessionId)
    }
    this.#finishedListeners.add(deliver)
    return () => {
      this.#finishedListeners.delete(deliver)
    }
  }

  subscribeLevel(listener: (level: number) => void): Unlisten {
    const deliver = (level: number): void => {
      listener(level)
    }
    this.#levelListeners.add(deliver)
    return () => {
      this.#levelListeners.delete(deliver)
    }
  }

  calls(): readonly TestRecorderCall[] {
    return [...this.#log]
  }

  setStatus(status: RecorderStatus): void {
    this.#status = status
    for (const listener of this.#listeners) {
      listener()
    }
  }

  setFinished(finished: readonly FinishedRecording[]): void {
    this.#finished = [...finished]
  }

  emitWarning(code: string, sessionId: string): void {
    for (const listener of this.#warningListeners) {
      listener(code, sessionId)
    }
  }

  emitFinished(sessionId: string): void {
    for (const listener of this.#finishedListeners) {
      listener(sessionId)
    }
  }

  emitLevel(level: number): void {
    for (const listener of this.#levelListeners) {
      listener(level)
    }
  }
}

/**
 * An in-memory {@link RecorderService}: the native recorder of a Mac without
 * the native side. Starting records until the next toggle; stopping stages the
 * recording (listed by `finishedRecordings` until archived) and reports it to
 * `onFinished`; cancelling discards it. Without a supported status the
 * controls do nothing, as off a Mac.
 */
export function createTestRecorderService(
  options?: TestRecorderServiceOptions,
): TestRecorderService {
  return new TestRecorderServiceImpl(options)
}
