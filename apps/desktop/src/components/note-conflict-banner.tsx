import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'

interface NoteConflictBannerProps {
  /** Resolve by keeping the editor buffer (rewrites the file). */
  onKeepMine: () => void
  /** Resolve by loading the external content (discards the buffer). */
  onLoadTheirs: () => void
  /** Show only the existing recovery controls inside another explanation. */
  compact?: boolean
}

/**
 * The non-destructive conflict prompt (Plan 05): an external change raced
 * unsaved edits, saves are paused, and nothing is written until the user
 * picks a side. The two actions map 1:1 onto the note session's
 * `keepMine`/`loadTheirs`.
 */
export function NoteConflictBanner({
  onKeepMine,
  onLoadTheirs,
  compact = false,
}: NoteConflictBannerProps): ReactElement {
  const actions = (
    <div className={compact ? 'flex flex-col gap-2' : 'flex gap-2'}>
      <Button size={compact ? 'sm' : 'xs'} variant="outline" onClick={onKeepMine}>
        Keep mine
      </Button>
      <Button size={compact ? 'sm' : 'xs'} variant="outline" onClick={onLoadTheirs}>
        Load theirs
      </Button>
    </div>
  )
  if (compact) {
    return actions
  }
  return (
    <InlineAlert className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1">This note changed on disk while you had unsaved edits.</span>
      {actions}
    </InlineAlert>
  )
}
