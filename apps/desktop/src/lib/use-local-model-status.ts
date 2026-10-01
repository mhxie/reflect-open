import { useEffect, useState } from 'react'
import {
  localModelStatus,
  subscribeLocalModelStatus,
  type LocalModelStatus,
  type LocalTranscriptionModelId,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'

/** Reported until the runtime answers for the current model. */
const UNKNOWN: LocalModelStatus = { status: 'unsupported' }

interface ModelStatusEntry {
  model: LocalTranscriptionModelId
  status: LocalModelStatus
}

/**
 * The on-device transcription model's live status: polled when the model
 * changes, then tracked through `local-transcription:status` events. Reads
 * `unsupported` while `enabled` is false, without a bridge, off macOS, and
 * until the runtime answers for a newly chosen model — never another
 * model's status.
 */
export function useLocalModelStatus(
  model: LocalTranscriptionModelId,
  enabled: boolean,
): LocalModelStatus {
  const [entry, setEntry] = useState<ModelStatusEntry | null>(null)
  const bridgeReady = useBridgeReady()
  const active = bridgeReady && enabled

  useEffect(() => {
    if (!active) {
      return
    }
    let live = true
    let unlisten: (() => void) | null = null
    void localModelStatus(model)
      .then((status) => {
        if (live) {
          setEntry({ model, status })
        }
      })
      .catch(() => {
        if (live) {
          setEntry({ model, status: UNKNOWN })
        }
      })
    void subscribeLocalModelStatus((eventModel, status) => {
      if (live && eventModel === model) {
        setEntry({ model, status })
      }
    }).then((fn) => {
      if (live) {
        unlisten = fn
      } else {
        fn()
      }
    })
    return () => {
      live = false
      unlisten?.()
    }
  }, [active, model])

  return active && entry?.model === model ? entry.status : UNKNOWN
}
