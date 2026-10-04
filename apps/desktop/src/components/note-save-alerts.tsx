import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { NoteConflictBanner } from '@/components/note-conflict-banner.tsx'
import { Button } from '@/components/ui/button.tsx'
import type { AssetSaveError } from '@/editor/use-asset-persistence.ts'
import type { NoteDocument } from '@/editor/use-note-document.ts'

interface NoteSaveAlertsProps {
  document: NoteDocument
  /** A pasted image or dropped file that could not be saved. */
  assetSaveError?: AssetSaveError | null
}

/**
 * What went wrong saving a ready document, and the external-change conflict
 * prompt. A blocked save (a local-only note whose folder can't take the
 * write) says the editor paused and offers to try again.
 */
export function NoteSaveAlerts({
  document,
  assetSaveError = null,
}: NoteSaveAlertsProps): ReactElement {
  return (
    <>
      {document.error !== null && document.saveBlocked ? (
        <InlineAlert tone="error" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1">
            Saving failed: {document.error}. Editing is paused until a save works; your unsaved text
            stays in the editor and is kept for the next time this note opens.
          </span>
          <Button size="xs" variant="outline" onClick={document.retrySave}>
            Try again
          </Button>
        </InlineAlert>
      ) : document.error !== null ? (
        <InlineAlert tone="error" className="mb-4">
          Saving failed: {document.error}. Your edits are kept in the editor and the next successful
          save will persist them.
        </InlineAlert>
      ) : null}
      {assetSaveError !== null ? (
        <InlineAlert tone="error" className="mb-4">
          Couldn’t save the {assetSaveError.kind === 'image' ? 'pasted image' : 'file'}:{' '}
          {assetSaveError.message}. It was not added to the note.
        </InlineAlert>
      ) : null}
      {document.conflict !== null ? (
        <NoteConflictBanner onKeepMine={document.keepMine} onLoadTheirs={document.loadTheirs} />
      ) : null}
    </>
  )
}
