import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import type { AssetSaveError } from '@reflect/core'

interface NoteSaveAlertsProps {
  /** The session's save error, if its last write failed. */
  saveError: string | null
  /** Whether editing is paused until the session can save again. */
  saveBlocked?: boolean | undefined
  /** Retry the session's blocked save. */
  retrySave?: (() => void) | undefined
  /** A pasted image or dropped file that could not be saved. */
  assetSaveError?: AssetSaveError | null | undefined
}

/**
 * What went wrong saving a ready document. A blocked save (a local-only note
 * whose folder can't take the write) says the editor paused and offers to try
 * again.
 */
export function NoteSaveAlerts({
  saveError,
  saveBlocked = false,
  retrySave,
  assetSaveError = null,
}: NoteSaveAlertsProps): ReactElement {
  return (
    <>
      {saveError !== null && saveBlocked ? (
        <InlineAlert tone="error" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1">
            Saving failed: {saveError}. Editing is paused until a save works; your unsaved text
            stays in the editor and is kept for the next time this note opens.
          </span>
          <Button size="xs" variant="outline" onClick={retrySave}>
            Try again
          </Button>
        </InlineAlert>
      ) : saveError !== null ? (
        <InlineAlert tone="error" className="mb-4">
          Saving failed: {saveError}. Your edits are kept in the editor and the next successful save
          will persist them.
        </InlineAlert>
      ) : null}
      {assetSaveError !== null ? (
        <InlineAlert tone="error" className="mb-4">
          Couldn’t save the {assetSaveError.kind === 'image' ? 'pasted image' : 'file'}:{' '}
          {assetSaveError.message}. It was not added to the note.
        </InlineAlert>
      ) : null}
    </>
  )
}
