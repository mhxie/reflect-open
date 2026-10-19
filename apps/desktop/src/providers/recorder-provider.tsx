import { createContext, use, useEffect, useMemo, type ReactElement, type ReactNode } from 'react'
import type { GraphInfo, Unlisten } from '@reflect/core'
import { formatTimeOfDay } from '@/lib/dates.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * The native recorder on the desktop (macOS 14.2+): every recording, a memo
 * or a call, captures the microphone and system audio through Rust. A thin
 * shell over `RecorderService` (the live status and the start/stop/cancel
 * controls the audio-memo surface and palette share) and `RecordingService`
 * (the background pass that turns stopped recordings into transcript notes,
 * pushes the menu bar and shortcut settings, and reports watchdog warnings),
 * opened here for the open graph's session. Capture keeps going with every
 * window hidden; the menu bar item and global shortcut reach it from any app.
 */

export interface RecorderContextValue {
  /**
   * The native recorder exists here (macOS 14.2+ desktop).
   */
  supported: boolean
  /**
   * Epoch milliseconds the live recording started, or null when idle.
   */
  recordingSince: number | null
  /**
   * Stopped recordings are being transcribed and written.
   */
  transcribing: boolean
  /**
   * The transcript note written most recently, until dismissed.
   */
  lastTranscript: string | null
  /**
   * Clear {@link lastTranscript}.
   */
  dismissTranscript: () => void
  /**
   * Where recordings are archived when no folder is chosen.
   */
  defaultRecordingsFolder: string
  /**
   * Start recording, or stop and save the one running.
   */
  toggle: () => void
  /**
   * Stop and discard the live recording.
   */
  cancel: () => void
  /**
   * Follow the live input level (0 to 1); returns the unsubscribe.
   */
  subscribeLevel: (listener: (level: number) => void) => Unlisten
}

const RecorderContext = createContext<RecorderContextValue | null>(null)

interface RecorderProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function RecorderProvider({ graph, children }: RecorderProviderProps): ReactElement {
  const { recorder, recordings, settings } = useCoreServices()
  const status = useServiceState(recorder, recorder.getState)
  const progress = useServiceState(recordings, recordings.getState)

  // One pass loop per graph session while the recorder exists. The session
  // does nothing in a note window: two loops would write every transcript twice.
  const supported = status.supported
  useEffect(() => {
    if (!supported) {
      return
    }
    const session = recordings.openSession({
      generation: graph.generation,
      root: graph.root,
      formatStartTime: (startsAt) => formatTimeOfDay(startsAt, settings.get().timeFormat),
    })
    session.start()
    return () => {
      session.dispose()
    }
  }, [recordings, settings, supported, graph.generation, graph.root])

  const value = useMemo(
    (): RecorderContextValue => ({
      supported: status.supported,
      recordingSince: status.recording?.startedAtMs ?? null,
      transcribing: progress.transcribing,
      lastTranscript: progress.lastTranscript,
      dismissTranscript: () => {
        recordings.dismissTranscript()
      },
      defaultRecordingsFolder: status.defaultRecordingsFolder,
      toggle: () => {
        void recorder.toggleRecording()
      },
      cancel: () => {
        void recorder.cancelRecording()
      },
      subscribeLevel: (listener) => recorder.subscribeLevel(listener),
    }),
    [status, progress, recorder, recordings],
  )

  return <RecorderContext value={value}>{children}</RecorderContext>
}

/**
 * The recorder, or null outside a {@link RecorderProvider}.
 */
export function useOptionalRecorder(): RecorderContextValue | null {
  return use(RecorderContext)
}

/**
 * Access the recorder. Use within a {@link RecorderProvider}.
 */
export function useRecorder(): RecorderContextValue {
  const context = use(RecorderContext)
  if (!context) {
    throw new Error('useRecorder must be used within a RecorderProvider')
  }
  return context
}
