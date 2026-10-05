import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import {
  cancelRecorder,
  configureRecorder,
  contactsAuthorizationStatus,
  errorMessage,
  hasBridge,
  isContactsReadable,
  localModelStatus,
  recorderStatus,
  startRecorder,
  stopRecorder,
  subscribeRecorderFinished,
  subscribeRecorderLevel,
  subscribeRecorderStatus,
  subscribeRecorderWarnings,
  type GraphInfo,
  type RecorderStatus,
} from '@reflect/core'
import { useMainWindowEffect } from '@/hooks/use-main-window-effect.ts'
import { formatTimeOfDay } from '@/lib/dates.ts'
import {
  createRecordingReconciler,
  type RecordingPassSettings,
} from '@/lib/recording-reconciler.ts'
import { startOperation } from '@/lib/operations.ts'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * The native recorder on the desktop (macOS 14.2+): every recording, a memo
 * or a call, captures the microphone and system audio through Rust. This
 * provider holds the live state, the start/stop/cancel controls the audio
 * memo surface and palette use, the menu bar and shortcut settings pushed to
 * the native side, watchdog warnings, and the background pass that turns
 * stopped recordings into transcript notes. Capture keeps going with every
 * window hidden; the menu bar item and global shortcut reach it from any app.
 */

export interface RecorderContextValue {
  /** The native recorder exists here (macOS 14.2+ desktop). */
  supported: boolean
  /** Epoch milliseconds the live recording started, or null when idle. */
  recordingSince: number | null
  /** Stopped recordings are being transcribed and written. */
  transcribing: boolean
  /** The transcript note written most recently, until dismissed. */
  lastTranscript: string | null
  /** Clear {@link lastTranscript}. */
  dismissTranscript: () => void
  /** Where recordings are archived when no folder is chosen. */
  defaultRecordingsFolder: string
  /** Start recording, or stop and save the one running. */
  toggle: () => void
  /** Stop and discard the live recording. */
  cancel: () => void
  /** Follow the live input level (0 to 1); returns the unsubscribe. */
  subscribeLevel: (listener: (level: number) => void) => () => void
}

const RecorderContext = createContext<RecorderContextValue | null>(null)

const IDLE_STATUS: RecorderStatus = {
  supported: false,
  defaultRecordingsFolder: '',
  recording: null,
}

/** What each watchdog warning tells the user. */
const WARNING_MESSAGES: Readonly<Record<string, string>> = {
  noAudio:
    'No audio is arriving. Check Microphone and Screen & System Audio Recording for Reflect in System Settings → Privacy & Security.',
  microphoneSilent: 'The microphone has been silent for a while. Is it muted?',
  idle: 'Nothing has been heard for five minutes. The recording stops on its own after fifteen.',
  captureFailed: 'Recording stopped working after an audio device change. Retrying.',
  writeFailed: 'The recording could not be saved. Check the free disk space.',
  startFailed: 'The recording could not start.',
}

const NO_MODEL_MESSAGE =
  'The recording is saved. Download an on-device transcription model under Settings → Audio memos to transcribe it.'

interface RecorderProviderProps {
  graph: GraphInfo
  children: ReactNode
}

export function RecorderProvider({ graph, children }: RecorderProviderProps): ReactElement {
  const { settings } = useSettings()
  const [status, setStatus] = useState<RecorderStatus>(IDLE_STATUS)
  const [transcribing, setTranscribing] = useState(false)
  const [lastTranscript, setLastTranscript] = useState<string | null>(null)
  const dismissTranscript = useCallback(() => setLastTranscript(null), [])

  useEffect(() => {
    if (!hasBridge()) {
      return
    }
    let active = true
    let unlisten: (() => void) | null = null
    void recorderStatus()
      .then((next) => {
        if (active) {
          setStatus(next)
        }
      })
      .catch((cause: unknown) => console.error('recorder status failed:', cause))
    void subscribeRecorderStatus(setStatus)
      .then((stop) => {
        if (active) {
          unlisten = stop
        } else {
          stop()
        }
      })
      .catch((cause: unknown) => console.error('recorder status subscription failed:', cause))
    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  // One native level stream, fanned out to whichever waveforms are mounted.
  const levelListenersRef = useRef(new Set<(level: number) => void>())
  useEffect(() => {
    if (!hasBridge()) {
      return
    }
    let active = true
    let unlisten: (() => void) | null = null
    void subscribeRecorderLevel((level) => {
      for (const listener of levelListenersRef.current) {
        listener(level)
      }
    })
      .then((stop) => {
        if (active) {
          unlisten = stop
        } else {
          stop()
        }
      })
      .catch((cause: unknown) => console.error('recorder level subscription failed:', cause))
    return () => {
      active = false
      unlisten?.()
    }
  }, [])
  const subscribeLevel = useCallback((listener: (level: number) => void): (() => void) => {
    const listeners = levelListenersRef.current
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  const settingsRef = useRef(settings)
  useEffect(() => {
    settingsRef.current = settings
  })
  const recordingsFolder = settings.recordingsFolder || status.defaultRecordingsFolder

  // Native settings are app-wide, so only the main window pushes them.
  useMainWindowEffect(() => {
    if (!status.supported) {
      return
    }
    configureRecorder({
      menuBar: settings.recordingMenuBar,
      shortcut: settings.recordingShortcut,
      recordingsFolder,
    }).catch((cause: unknown) => {
      startOperation('Recording shortcut').fail(errorMessage(cause))
    })
  }, [status.supported, settings.recordingMenuBar, settings.recordingShortcut, recordingsFolder])

  useMainWindowEffect(() => {
    if (!hasBridge()) {
      return
    }
    let active = true
    const teardown: Array<() => void> = []
    const keep = (stop: () => void): void => {
      if (active) {
        teardown.push(stop)
      } else {
        stop()
      }
    }
    void subscribeRecorderWarnings((code) => {
      startOperation('Recording').warn(WARNING_MESSAGES[code] ?? code)
    })
      .then(keep)
      .catch((cause: unknown) => console.error('recorder warning subscription failed:', cause))
    void subscribeRecorderFinished(() => {
      localModelStatus(settingsRef.current.localTranscriptionModel)
        .then((model) => {
          if (model.status !== 'ready') {
            startOperation('Recording').warn(NO_MODEL_MESSAGE)
          }
        })
        .catch((cause: unknown) => console.error('recording model status failed:', cause))
    })
      .then(keep)
      .catch((cause: unknown) => console.error('recorder finished subscription failed:', cause))
    return () => {
      active = false
      for (const stop of teardown) {
        stop()
      }
    }
  }, [])

  const recordingsFolderRef = useRef(recordingsFolder)
  useEffect(() => {
    recordingsFolderRef.current = recordingsFolder
  })
  // One pass loop per graph session, main window only: two would write every
  // transcript twice.
  useMainWindowEffect(() => {
    if (!status.supported) {
      return
    }
    const reconciler = createRecordingReconciler({
      generation: graph.generation,
      graphRoot: graph.root,
      onPending: (count) => setTranscribing(count > 0),
      onWritten: (paths) => setLastTranscript(paths.at(-1) ?? null),
      getSettings: async (): Promise<RecordingPassSettings> => {
        const current = settingsRef.current
        const lookupContacts = current.contactsEnabled && (await canReadContacts())
        return {
          localModel: current.localTranscriptionModel,
          transcriptionLanguage: current.transcriptionLanguage,
          transcriptionPrompt: current.transcriptionPrompt,
          calendarEnabled: current.calendarEnabled,
          calendarIds: current.calendarIds,
          lookupContacts,
          recordingsFolder: recordingsFolderRef.current,
          formatStartTime: (startsAt) => formatTimeOfDay(startsAt, current.timeFormat),
        }
      },
    })
    reconciler.start()
    return () => {
      reconciler.dispose()
      setTranscribing(false)
      setLastTranscript(null)
    }
  }, [status.supported, graph.generation, graph.root])

  const recording = status.recording !== null
  const toggle = useCallback((): void => {
    void (async () => {
      try {
        setStatus(await (recording ? stopRecorder() : startRecorder()))
      } catch (cause) {
        startOperation('Recording').fail(errorMessage(cause))
      }
    })()
  }, [recording])

  const cancel = useCallback((): void => {
    void (async () => {
      try {
        setStatus(await cancelRecorder())
      } catch (cause) {
        startOperation('Recording').fail(errorMessage(cause))
      }
    })()
  }, [])

  const value = useMemo(
    (): RecorderContextValue => ({
      supported: status.supported,
      recordingSince: status.recording?.startedAtMs ?? null,
      transcribing,
      lastTranscript,
      dismissTranscript,
      defaultRecordingsFolder: status.defaultRecordingsFolder,
      toggle,
      cancel,
      subscribeLevel,
    }),
    [status, transcribing, lastTranscript, dismissTranscript, toggle, cancel, subscribeLevel],
  )

  return <RecorderContext value={value}>{children}</RecorderContext>
}

/** Whether contacts can be read; an unanswerable check reads as no, so a
 * failed permission query never fails the recording pass. */
async function canReadContacts(): Promise<boolean> {
  try {
    return isContactsReadable(await contactsAuthorizationStatus())
  } catch (cause) {
    console.error('recording contacts check failed:', cause)
    return false
  }
}

/** The recorder, or null outside a {@link RecorderProvider}. */
export function useOptionalRecorder(): RecorderContextValue | null {
  return use(RecorderContext)
}

export function useRecorder(): RecorderContextValue {
  const context = use(RecorderContext)
  if (!context) {
    throw new Error('useRecorder must be used within a RecorderProvider')
  }
  return context
}
