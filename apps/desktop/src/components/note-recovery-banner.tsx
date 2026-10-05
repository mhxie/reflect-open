import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'

interface NoteRecoveryBannerProps {
  /** When the text was kept, already formatted for display (a time or a date). */
  keptAt: string
  /** Put the kept text back into the note, which then saves it. */
  onRestore: () => void
  /** Drop the kept text. */
  onDiscard: () => void
}

/**
 * The unsaved-text offer on a local-only note: an earlier session couldn't
 * save, kept its text, and nothing is written until the user picks. Restore
 * saves the kept text only while the note still holds the version it was
 * kept against; when the note changed since, Restore opens the conflict
 * prompt instead (Keep mine / Load theirs), so that newer version is never
 * silently replaced. The two actions map 1:1 onto the note session's
 * `restoreRecovery`/`discardRecovery`.
 */
export function NoteRecoveryBanner({
  keptAt,
  onRestore,
  onDiscard,
}: NoteRecoveryBannerProps): ReactElement {
  return (
    <InlineAlert className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1">
        Unsaved text from {keptAt} was kept when this note couldn’t be saved.
      </span>
      <div className="flex gap-2">
        <Button size="xs" variant="outline" onClick={onRestore}>
          Restore
        </Button>
        <Button size="xs" variant="outline" onClick={onDiscard}>
          Discard
        </Button>
      </div>
    </InlineAlert>
  )
}
