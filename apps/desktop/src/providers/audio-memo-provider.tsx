import {
  createContext,
  useCallback,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  AUDIO_MEMO_REMINDER_MS,
  AUDIO_MEMO_SEGMENT_MS,
  audioMemoIdentity,
  audioMemoPartPath,
  deleteAudioMemo,
  errorMessage,
  type AudioMemoIdentity,
  type GraphInfo,
} from '@reflect/core'
import {
  isRecordingSupported,
  useAudioRecorder,
  type RecorderSegment,
} from '@/hooks/use-audio-recorder.ts'
import {
  dismissRecordingReminder,
  showRecordingReminder,
} from '@/components/audio-memo/recording-reminder.ts'
import { useAudioMemoPipeline } from '@/hooks/use-audio-memo-pipeline.ts'
import { useRecorder } from '@/providers/recorder-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useSidebar } from '@/providers/sidebar-provider.tsx'

/**
 * The desktop React surface for audio memos: MediaRecorder recording state +
 * the bridge to the shared capture pipeline (`useAudioMemoPipeline`, which
 * owns the serial capture queue and the transcription reconciler). State
 * lives here — above the sidebar — because the mic button unmounts with the
 * sidebar (`Mod-\`), and a recording must never outlive its UI invisibly:
 * collapsing mid-recording stops and saves instead of leaving a hidden hot
 * microphone.
 */

/**
 * 'transcribing' means committed memos are still being captured or
 * transcribed in the background — the mic stays available, so the next
 * recording can start immediately.
 */
export type AudioMemoPhase = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error'

interface AudioMemoContextValue {
  phase: AudioMemoPhase
  /** Live while recording. */
  elapsedMs: number
  /** The live input stream, for the waveform. */
  stream: MediaStream | null
  /** The native recorder's live level, for the waveform when there's no stream. */
  subscribeLevel: ((listener: (level: number) => void) => () => void) | null
  /** Recordings committed but not yet written to the graph. */
  pendingCount: number
  /** False when no OpenAI/Gemini model is configured or the platform can't record. */
  available: boolean
  /** Why the mic is disabled (tooltip copy), null when `available`. */
  unavailableReason: string | null
  /** The failure shown in the error phase. */
  error: string | null
  /** True when a retry can re-run the failed capture. */
  canRetry: boolean
  /** Idle → start recording (expanding a collapsed sidebar); recording → stop & save. */
  toggle: () => void
  /** Discard the in-flight recording without saving. */
  cancel: () => void
  /** Re-run the failed capture. */
  retry: () => void
  /** Drop the failed memo and let the queue continue. */
  discard: () => void
}

const AudioMemoContext = createContext<AudioMemoContextValue | null>(null)

/** A live session's bookkeeping: identity once known, and cancel cleanup. */
interface LiveSession {
  recordedAt: Date
  memo: AudioMemoIdentity | null
  cancelled: boolean
  /** Segment paths already durably written, in case of a later cancel. */
  captured: string[]
}

const NO_PROVIDER_REASON = 'Add an OpenAI or Gemini model in Settings to record audio memos'
const NO_LOCAL_MODEL_REASON =
  'Download the on-device transcription model in Settings to record audio memos'
const UNSUPPORTED_REASON = 'Audio recording is not supported on this platform'

/** Same macOS check as `hasMacosTitleBarOverlay` — settings paths differ per OS. */
function micDeniedMessage(): string {
  const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh')
  return isMac
    ? 'Microphone access was denied. Allow it in System Settings → Privacy & Security → Microphone.'
    : 'Microphone access was denied. Allow microphone access for Reflect in your system settings.'
}

interface AudioMemoProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function AudioMemoProvider({ graph, children }: AudioMemoProviderProps): ReactElement {
  // Keep the settings subscription alive at the provider (matches the
  // pipeline hook's own read), so the mic enables the moment a key is added.
  const { settings } = useSettings()
  const { collapsed, toggleSidebar } = useSidebar()
  // On a Mac that can tap system audio every recording goes through the
  // native recorder (microphone and system audio, transcribed on the
  // device); the webview recorder below serves every other platform. The
  // pipeline stays mounted either way for memos that sync in from them.
  const native = useRecorder()
  const nativeRecorder = native.supported

  /** True from the stop click until the recorder hands over the blob. */
  const [stopping, setStopping] = useState(false)

  const stopAndSaveRef = useRef<() => void>(() => {})
  const handleSegmentRef = useRef<(segment: RecorderSegment) => void>(() => {})
  const recorder = useAudioRecorder({
    segmentMs: AUDIO_MEMO_SEGMENT_MS,
    reminderMs: AUDIO_MEMO_REMINDER_MS,
    onReminder: (elapsedMs) => showRecordingReminder(elapsedMs, () => stopAndSaveRef.current()),
    onSegment: (segment) => handleSegmentRef.current(segment),
  })
  // The hook's functions are stable; the wrapper object is not (elapsed ticks
  // remint it every render). Callbacks and effects must hang off the
  // functions, or the collapse effect re-fires on every recording tick.
  const startRecorder = recorder.start
  const stopRecorder = recorder.stop
  const cancelRecorder = recorder.cancel

  const supported = isRecordingSupported()

  const collapsedRef = useRef(collapsed)
  useEffect(() => {
    collapsedRef.current = collapsed
  })

  // The mic button (and its popover) unmount with the sidebar — while
  // collapsed, a capture failure must surface as a toast instead.
  const pipeline = useAudioMemoPipeline({
    graph,
    isErrorSurfaceVisible: () => !collapsedRef.current,
  })

  const sessionRef = useRef<LiveSession | null>(null)
  const generationRef = useRef(graph.generation)
  useEffect(() => {
    generationRef.current = graph.generation
  })
  const enqueueCapture = pipeline.enqueue
  useEffect(() => {
    handleSegmentRef.current = (segment: RecorderSegment) => {
      const session = sessionRef.current
      if (session === null || session.cancelled) {
        return
      }
      session.memo ??= audioMemoIdentity(session.recordedAt, segment.mimeType)
      const path = audioMemoPartPath(session.memo, segment.part, segment.end)
      enqueueCapture({
        audio: { blob: segment.blob },
        mimeType: segment.mimeType,
        recordedAt: session.recordedAt,
        segment: { part: segment.part, end: segment.end },
        onCaptured: () => {
          // A cancel may land while this segment's write is in flight — its
          // bytes are durable by now, so the cancel cleanup runs here.
          if (session.cancelled) {
            return deleteAudioMemo(path, generationRef.current).catch(() => {})
          }
          session.captured.push(path)
        },
      })
    }
  })

  /** Re-entry guard for the stop click's await gap. */
  const stoppingRef = useRef(false)
  /** The in-flight stop, so a mic click in the gap can chain the next memo. */
  const stopSettledRef = useRef<Promise<void>>(Promise.resolve())

  const start = useCallback(async (): Promise<void> => {
    if (!supported || !pipeline.hasTranscriptionConfig) {
      return
    }
    if (collapsedRef.current) {
      // Never record without visible recording UI.
      toggleSidebar()
    }
    try {
      await startRecorder()
      // Identity derives from the session's start — every segment shares it.
      sessionRef.current = { recordedAt: new Date(), memo: null, cancelled: false, captured: [] }
    } catch (cause) {
      pipeline.reportError(
        cause instanceof DOMException && cause.name === 'NotAllowedError'
          ? micDeniedMessage()
          : errorMessage(cause),
      )
    }
  }, [supported, pipeline, toggleSidebar, startRecorder])

  const stopAndSave = useCallback(async (): Promise<void> => {
    if (stoppingRef.current) {
      return
    }
    stoppingRef.current = true
    dismissRecordingReminder()
    // The stop click commits the memo: flip to 'transcribing' before the stop
    // settles, so an Esc landing in the await gap can't read a lingering
    // 'recording' phase and cancel a recording the user just saved.
    setStopping(true)
    const settled = (async (): Promise<void> => {
      try {
        // Segments (including the final one) flow through onSegment as the
        // recorder rotates; the stop only flushes and summarizes.
        await stopRecorder()
      } finally {
        stoppingRef.current = false
        setStopping(false)
      }
    })()
    stopSettledRef.current = settled
    return await settled
  }, [stopRecorder, pipeline])
  useEffect(() => {
    stopAndSaveRef.current = () => void stopAndSave()
  })

  const toggle = useCallback((): void => {
    if (nativeRecorder) {
      if (native.recordingSince === null && collapsedRef.current) {
        // Never start a recording without visible recording UI.
        toggleSidebar()
      }
      native.toggle()
      return
    }
    if (recorder.status === 'recording') {
      if (stoppingRef.current) {
        // The click landed in the stop's await gap, where the button already
        // reads as the idle mic — honor it as "record the next memo" once
        // the recorder frees, instead of swallowing it on the re-entry guard.
        void stopSettledRef.current.then(() => start())
      } else {
        void stopAndSave()
      }
    } else if (recorder.status === 'requesting') {
      // A second press while the OS prompt is up aborts the request — the
      // alternative is a click that visibly does nothing.
      cancelRecorder()
    } else if (pipeline.error !== null) {
      // A parked error must never invisibly block recording. Collapsed, the
      // error UI doesn't exist — surface it; visible, it was on screen and a
      // fresh record request acknowledges it (the same click the red mic
      // anchor handles).
      if (collapsedRef.current) {
        toggleSidebar()
      } else {
        pipeline.discard()
      }
    } else if (recorder.status === 'idle') {
      void start()
    }
  }, [
    nativeRecorder,
    native,
    recorder.status,
    pipeline,
    stopAndSave,
    cancelRecorder,
    start,
    toggleSidebar,
  ])

  const cancel = useCallback((): void => {
    if (nativeRecorder) {
      native.cancel()
      return
    }
    dismissRecordingReminder()
    const session = sessionRef.current
    if (session !== null) {
      // Discard means discard: segments already on disk go too. Segments
      // whose write is still in flight delete themselves via onCaptured.
      session.cancelled = true
      for (const path of session.captured) {
        void deleteAudioMemo(path, generationRef.current).catch(() => {})
      }
      session.captured = []
    }
    cancelRecorder()
  }, [nativeRecorder, native, cancelRecorder])

  // Collapsing the sidebar mid-flow: stop-and-save a live recording, and
  // abandon a pending permission request — a grant arriving after the
  // collapse would otherwise start a recording with no UI mounted.
  useEffect(() => {
    if (!collapsed) {
      return
    }
    if (nativeRecorder) {
      // A native recording stays visible in the menu bar; without that item
      // it would be invisible, so it ends like a webview one.
      if (native.recordingSince !== null && !settings.recordingMenuBar) {
        native.toggle()
      }
      return
    }
    if (recorder.status === 'recording') {
      void stopAndSave()
    } else if (recorder.status === 'requesting') {
      cancelRecorder()
    }
  }, [
    collapsed,
    nativeRecorder,
    native,
    settings.recordingMenuBar,
    recorder.status,
    cancelRecorder,
    stopAndSave,
  ])

  const nativeElapsedMs = useNativeElapsed(native.recordingSince)

  // A live capture owns the surface — a background save's failure parks and
  // shows after the stop, never yanking the waveform mid-recording.
  const phase: AudioMemoPhase = nativeRecorder
    ? native.recordingSince !== null
      ? 'recording'
      : pipeline.error !== null
        ? 'error'
        : native.transcribing || pipeline.pendingCount > 0 || pipeline.transcribing
          ? 'transcribing'
          : 'idle'
    : recorder.status === 'recording' && !stopping
      ? 'recording'
      : recorder.status === 'requesting'
        ? 'requesting'
        : pipeline.error !== null
          ? 'error'
          : stopping || pipeline.pendingCount > 0 || pipeline.transcribing
            ? 'transcribing'
            : 'idle'

  const unavailableReason = nativeRecorder
    ? null
    : !supported
      ? UNSUPPORTED_REASON
      : !pipeline.hasTranscriptionConfig
        ? pipeline.transcriptionEngine === 'local'
          ? NO_LOCAL_MODEL_REASON
          : NO_PROVIDER_REASON
        : null

  const value = useMemo<AudioMemoContextValue>(
    () => ({
      phase,
      elapsedMs: nativeRecorder ? nativeElapsedMs : recorder.elapsedMs,
      stream: nativeRecorder ? null : recorder.stream,
      subscribeLevel: nativeRecorder ? native.subscribeLevel : null,
      pendingCount: pipeline.pendingCount,
      available: unavailableReason === null,
      unavailableReason,
      error: pipeline.error,
      canRetry: pipeline.canRetry,
      toggle,
      cancel,
      retry: pipeline.retry,
      discard: pipeline.discard,
    }),
    [
      phase,
      nativeRecorder,
      nativeElapsedMs,
      native.subscribeLevel,
      recorder.elapsedMs,
      recorder.stream,
      pipeline.pendingCount,
      unavailableReason,
      pipeline.error,
      pipeline.canRetry,
      pipeline.retry,
      pipeline.discard,
      toggle,
      cancel,
    ],
  )

  return <AudioMemoContext value={value}>{children}</AudioMemoContext>
}

/** Milliseconds since `since`, ticking while a native recording runs. */
function useNativeElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (since === null) {
      return
    }
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [since])
  return since === null ? 0 : Math.max(0, now - since)
}

/** Access the audio-memo surface. Use within an AudioMemoProvider. */
export function useAudioMemo(): AudioMemoContextValue {
  const context = use(AudioMemoContext)
  if (!context) {
    throw new Error('useAudioMemo must be used within an AudioMemoProvider')
  }
  return context
}
