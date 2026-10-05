import { useState, type ReactElement } from 'react'
import { errorMessage, revealAsset } from '@reflect/core'
import type { NoteProtection } from '@/editor/status/note-protection.ts'
import type { NoteStatusScope } from '@/editor/status/note-status-store.ts'
import { isMobileSurface } from '@/lib/platform-surface.ts'
import { Button } from '@/components/ui/button.tsx'
import { NoteConflictBanner } from './note-conflict-banner.tsx'
import { SyncConflictNotice } from './sync-conflict-notice.tsx'

interface NoteProtectionDetailsProps {
  readonly scope: NoteStatusScope
  readonly protection: NoteProtection
}

/** Explain the current edit gate and offer its existing, scoped recovery actions. */
export function NoteProtectionDetails({
  scope,
  protection,
}: NoteProtectionDetailsProps): ReactElement {
  const [revealing, setRevealing] = useState(false)
  const [revealError, setRevealError] = useState<string | null>(null)

  async function showFile(): Promise<void> {
    setRevealing(true)
    setRevealError(null)
    try {
      await revealAsset(scope.path, scope.generation)
    } catch (cause) {
      setRevealError(errorMessage(cause))
    } finally {
      setRevealing(false)
    }
  }

  return (
    <div className="mb-3 space-y-2 border-b border-border pb-3 text-xs whitespace-normal">
      {protection.kind === 'sync-conflict' ? (
        <>
          <p className="font-medium">Sync conflict</p>
          <p className="text-text-secondary">Choose which versions of this note to keep.</p>
          <SyncConflictNotice path={scope.path} shownContent={protection.content} compact />
        </>
      ) : protection.kind === 'external-change' ? (
        <>
          <p className="font-medium">External change</p>
          <p className="break-words text-text-secondary">{protection.message}</p>
          <p className="text-text-secondary">
            The file changed while saving was blocked. Choose which version to keep.
          </p>
          <NoteConflictBanner
            onKeepMine={protection.keepMine}
            onLoadTheirs={protection.loadTheirs}
            compact
          />
        </>
      ) : protection.kind === 'save-blocked' ? (
        <>
          <p className="font-medium">Saving blocked</p>
          <p className="break-words text-text-secondary">{protection.message}</p>
          <p className="text-text-secondary">
            Your unsaved changes are kept until saving succeeds.
          </p>
          <Button size="sm" variant="outline" className="w-full" onClick={protection.retrySave}>
            Try again
          </Button>
        </>
      ) : (
        <>
          <p className="font-medium">Unsupported Markdown</p>
          <p className="text-text-secondary">
            The editor cannot save this Markdown faithfully. Edit the source file in another app.
          </p>
          {isMobileSurface() ? null : (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              disabled={revealing}
              onClick={() => void showFile()}
            >
              Show file
            </Button>
          )}
          {revealError !== null ? (
            <p role="alert" className="break-words text-destructive">
              {revealError}
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}
