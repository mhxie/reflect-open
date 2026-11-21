import type { ReactElement } from 'react'
import { Shield } from 'lucide-react'
import { requestNoteMenu } from '@/editor/status/note-menu-request.ts'
import { cn } from '@/lib/utils.ts'

interface PrivateNoteNoticeProps {
  /** Graph-relative path of the private note, whose status menu the notice opens. */
  readonly path: string
  /** Whether a status bar is showing to host the menu; otherwise the notice is just text. */
  readonly interactive: boolean
  readonly className?: string | undefined
}

/**
 * The marker on a note marked `private: true`, in the local-only notice's
 * quiet one-line form: the hard privacy block is visible where the note is
 * written, not only in the footer. It opens the note's status menu, where the
 * flag can be changed.
 */
export function PrivateNoteNotice({
  path,
  interactive,
  className,
}: PrivateNoteNoticeProps): ReactElement {
  const content = (
    <>
      <Shield size={12} aria-hidden />
      Private · never sent to AI or other services
    </>
  )
  const classes = cn(
    'flex w-fit items-center gap-1.5 rounded text-xs text-note-state-private',
    className,
  )
  if (!interactive) {
    return (
      <p data-testid="private-note-notice" className={classes}>
        {content}
      </p>
    )
  }
  return (
    <button
      type="button"
      data-testid="private-note-notice"
      aria-label="Private note: show note details"
      onClick={() => requestNoteMenu(path)}
      className={cn(
        classes,
        '-mx-1 px-1 hover:bg-note-state-private/10 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
      )}
    >
      {content}
    </button>
  )
}
