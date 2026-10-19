import { useEffect, useState } from 'react'
import type { LocalModelStatus, LocalTranscriptionModelId } from '@reflect/core'
import { useCoreServices } from '@/services/services-provider.tsx'

/** Reported until the runtime answers for the current model. */
const UNKNOWN: LocalModelStatus = { status: 'unsupported' }

interface ModelStatusEntry {
  model: LocalTranscriptionModelId
  status: LocalModelStatus
}

/**
 * The on-device transcription model's live status: polled when the model
 * changes, then tracked through `local-transcription:status` events. Reads
 * `unsupported` while `enabled` is false, when the runtime can't answer (off
 * macOS, no native shell), and until the runtime answers for a newly chosen
 * model — never another model's status.
 */
export function useLocalModelStatus(
  model: LocalTranscriptionModelId,
  enabled: boolean,
): LocalModelStatus {
  const { localTranscription } = useCoreServices()
  const [entry, setEntry] = useState<ModelStatusEntry | null>(null)

  useEffect(() => {
    if (!enabled) {
      return
    }
    let live = true
    const unlisten = localTranscription.onStatus((eventModel, status) => {
      if (live && eventModel === model) {
        setEntry({ model, status })
      }
    })
    void localTranscription.status(model).then(
      (status) => {
        if (live) {
          setEntry({ model, status })
        }
      },
      () => {
        if (live) {
          setEntry({ model, status: UNKNOWN })
        }
      },
    )
    return () => {
      live = false
      unlisten()
    }
  }, [enabled, localTranscription, model])

  return enabled && entry?.model === model ? entry.status : UNKNOWN
}
