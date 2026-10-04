import { useState, type ReactElement } from 'react'
import {
  deleteLocalModel,
  downloadLocalModel,
  errorMessage,
  localTranscriptionModel,
  type LocalModelStatus,
  type LocalTranscriptionModelId,
} from '@reflect/core'
import { InlineAlert } from '@/components/inline-alert.tsx'
import {
  clearPendingLocalModelUpdate,
  formatModelSize,
  installLocalModelUpdate,
  skipPendingLocalModelUpdate,
  usePendingLocalModelUpdate,
} from '@/lib/local-model-updates.ts'
import { ModelDownloadProgress } from './model-download-progress.tsx'

const PRIMARY_BUTTON =
  'inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover'
const SECONDARY_BUTTON =
  'shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-100 hover:bg-surface-hover'

interface LocalModelActionsProps {
  /** The selected on-device model. */
  model: LocalTranscriptionModelId
  /** Its live status. */
  status: LocalModelStatus
}

/**
 * The selected model's download state and actions: download, progress,
 * delete, and — when a background check found newer weights — update or
 * skip that version. A failed first download reports through `status`; a
 * failed update reports through its operation toast.
 */
export function LocalModelActions({ model, status }: LocalModelActionsProps): ReactElement | null {
  const update = usePendingLocalModelUpdate()
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const download = (): void => {
    // The status events carry progress and the outcome; nothing to add here.
    void downloadLocalModel(model).catch(() => undefined)
  }

  switch (status.status) {
    case 'unsupported':
      return null
    case 'downloading':
      return (
        <ModelDownloadProgress
          progress={status.progress}
          ariaLabel="Transcription model download"
        />
      )
    case 'failed':
      return (
        <div>
          <InlineAlert tone="error">Couldn’t download the model: {status.message}</InlineAlert>
          <button type="button" onClick={download} className={`mt-2 ${SECONDARY_BUTTON}`}>
            Try again
          </button>
        </div>
      )
    case 'missing':
      return (
        <button type="button" onClick={download} className={PRIMARY_BUTTON}>
          Download ({formatModelSize(localTranscriptionModel(model).sizeBytes)})
        </button>
      )
    case 'ready':
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-xs text-text-muted">
              <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
              Downloaded
            </span>
            <button
              type="button"
              onClick={() => {
                setDeleteError(null)
                clearPendingLocalModelUpdate()
                void deleteLocalModel(model).catch((cause) => setDeleteError(errorMessage(cause)))
              }}
              className={SECONDARY_BUTTON}
            >
              Delete
            </button>
          </div>
          {update?.model === model ? (
            <div className="flex items-center justify-between gap-4">
              <span className="text-xs text-text-muted">
                Newer weights are available ({formatModelSize(update.sizeBytes)}).
              </span>
              <span className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={() => void installLocalModelUpdate()}
                  className={PRIMARY_BUTTON}
                >
                  Update
                </button>
                <button
                  type="button"
                  onClick={() => void skipPendingLocalModelUpdate()}
                  className={SECONDARY_BUTTON}
                >
                  Skip this version
                </button>
              </span>
            </div>
          ) : null}
          {deleteError !== null ? <InlineAlert tone="error">{deleteError}</InlineAlert> : null}
        </div>
      )
  }
}
