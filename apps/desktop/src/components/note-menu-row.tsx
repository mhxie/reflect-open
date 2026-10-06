import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu.tsx'

/** Status-menu rows: compact like the app's menus, room for a hint line. */
export const NOTE_MENU_ITEM = 'items-start gap-2 py-1.5 text-[13px] [&_svg]:mt-0.5 [&_svg]:size-3.5'

interface NoteMenuItemContentProps {
  readonly icon: ReactNode
  readonly label: string
  readonly hint?: string | null
  readonly trailing?: ReactNode
  readonly monospace?: boolean
}

/** A row's icon, label and, when the label needs explaining, a muted hint under it. */
export function NoteMenuItemContent({
  icon,
  label,
  hint = null,
  trailing,
  monospace = false,
}: NoteMenuItemContentProps): ReactElement {
  return (
    <>
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          data-testid="note-menu-label"
          className={cn('truncate', monospace && 'font-mono text-xs leading-5')}
        >
          {label}
        </span>
        {hint === null ? null : (
          <span
            data-testid="note-detail-hint"
            className="text-2xs leading-snug break-words whitespace-normal text-text-muted"
          >
            {hint}
          </span>
        )}
      </span>
      {trailing === undefined ? null : (
        <span className="text-2xs leading-5 text-text-muted">{trailing}</span>
      )}
    </>
  )
}

/**
 * A fact about the note, shown as a disabled menu item the way native menus
 * show status lines: arrow keys still stop on it, so a screen reader reads
 * each fact in turn, but it does nothing.
 */
export function NoteMenuInfoItem(props: NoteMenuItemContentProps): ReactElement {
  return (
    <DropdownMenuItem
      disabled
      className={cn(NOTE_MENU_ITEM, 'text-text-secondary data-disabled:opacity-100')}
    >
      <NoteMenuItemContent {...props} />
    </DropdownMenuItem>
  )
}
