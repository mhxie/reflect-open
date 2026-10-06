import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'

/** A status-menu row, sized and spaced like the app's dropdown menu items. */
export const NOTE_MENU_ITEM =
  'flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] outline-none [&_svg]:size-3.5 [&_svg]:shrink-0 enabled:hover:bg-surface-hover enabled:focus-visible:bg-surface-hover'

interface NoteMenuRowProps {
  readonly icon: ReactNode
  readonly label: string
  readonly trailing?: ReactNode
  readonly monospace?: boolean
  readonly hint?: string | null
}

/** A read-only status-menu row: what is true of the note, with no action. */
export function NoteMenuRow({
  icon,
  label,
  trailing,
  monospace = false,
  hint = null,
}: NoteMenuRowProps): ReactElement {
  return (
    <>
      <div className={cn(NOTE_MENU_ITEM, 'text-text-secondary')}>
        {icon}
        <span
          data-testid="note-menu-label"
          className={cn('min-w-0 flex-1 truncate', monospace && 'font-mono text-xs')}
        >
          {label}
        </span>
        {trailing === undefined ? null : (
          <span className="text-2xs text-text-muted">{trailing}</span>
        )}
      </div>
      <NoteMenuHint>{hint}</NoteMenuHint>
    </>
  )
}

interface NoteMenuHintProps {
  readonly children: string | null
}

/** One muted line under a row, aligned with its label, when the label needs explaining. */
export function NoteMenuHint({ children }: NoteMenuHintProps): ReactElement | null {
  if (children === null) {
    return null
  }
  return (
    <p
      data-testid="note-detail-hint"
      className="pr-2 pb-1 pl-[30px] text-2xs leading-snug break-words whitespace-normal text-text-muted"
    >
      {children}
    </p>
  )
}

interface NoteMenuSectionProps {
  readonly label: string
  readonly children: ReactNode
}

/** A labelled group of rows. */
export function NoteMenuSection({ label, children }: NoteMenuSectionProps): ReactElement {
  return (
    <div role="group" aria-label={label}>
      <div className="px-2 pt-1 pb-0.5 text-2xs text-text-muted" aria-hidden>
        {label}
      </div>
      {children}
    </div>
  )
}
