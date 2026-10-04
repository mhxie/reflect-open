import {
  isSilentStop,
  reconcileRecordings,
  subscribeRecorderFinished,
  type ReconcileRecordingsInput,
  type ReconcileStop,
} from '@reflect/core'
import { createBackgroundReconciler } from '@/lib/background-reconciler.ts'
import { startOperation } from '@/lib/operations.ts'

/** The pass settings read fresh at the start of every pass. */
export type RecordingPassSettings = Omit<
  ReconcileRecordingsInput,
  'generation' | 'graphRoot' | 'isStale' | 'onPending'
>

export interface RecordingReconcilerOptions {
  /** The open graph's generation: transcripts land in this graph. */
  generation: number
  graphRoot: string
  /** Read per pass, so a settings change applies to the next one. */
  getSettings: () => Promise<RecordingPassSettings>
  /** How many recordings a pass found waiting; zero once the loop settles. */
  onPending?: (count: number) => void
  /** Transcript notes a pass wrote, when it wrote any. */
  onWritten?: (paths: readonly string[]) => void
}

export interface RecordingReconciler {
  /** Attach the triggers (a stopped recording, focus) and run the launch pass. */
  start(): void
  /** Request a pass; coalesces while one runs. */
  schedule(): void
  /** Tear down triggers and abort an in-flight pass at its next gate. */
  dispose(): void
}

/**
 * The background lifecycle that turns stopped recordings into
 * transcript notes (see `reconcileRecordings` in core), built on the shared
 * {@link createBackgroundReconciler}. A pass runs at launch for recordings
 * left by an earlier session, whenever a recording stops, and on window focus,
 * which retries an archive folder that was unavailable.
 */
export function createRecordingReconciler(
  options: RecordingReconcilerOptions,
): RecordingReconciler {
  /** Last surfaced stop: focus retries must not repeat the same toast. */
  let surfacedStop: string | null = null

  function surfaceStop(stopped: ReconcileStop | null): void {
    if (stopped === null) {
      surfacedStop = null
      return
    }
    if (isSilentStop(stopped) || surfacedStop === stopped.message) {
      return
    }
    surfacedStop = stopped.message
    startOperation('Transcribing recording').fail(stopped.message)
  }

  const loop = createBackgroundReconciler({
    pass: async (isStale) => {
      const settings = await options.getSettings()
      if (isStale()) {
        return
      }
      const outcome = await reconcileRecordings({
        ...settings,
        generation: options.generation,
        graphRoot: options.graphRoot,
        isStale,
        ...(options.onPending === undefined ? {} : { onPending: options.onPending }),
      })
      if (outcome.written.length > 0) {
        options.onWritten?.(outcome.written)
      }
      surfaceStop(outcome.stopped)
    },
    onSettled: () => options.onPending?.(0),
  })

  function start(): void {
    if (loop.isStale()) {
      return
    }
    loop.schedule()
    loop.retryOnWake()
    void subscribeRecorderFinished(() => loop.schedule())
      .then((stop) => loop.onDispose(stop))
      .catch((cause: unknown) => {
        console.error('recording subscription failed:', cause)
      })
  }

  return { start, schedule: loop.schedule, dispose: loop.dispose }
}
