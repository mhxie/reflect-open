import type { MouseEvent, ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'

interface ListRowProps {
  path: string
  /** The column template the list's header row shares. */
  grid: string
  /** Additional row styling; callers preserve the row's selection treatment. */
  className?: string | undefined
  /** Position in the list's render order, for keyboard scrolling (`data-row-index`). */
  index?: number | undefined
  /** What a row is, for the indicator's label: "note", "entry". */
  noun: string
  selected: boolean
  /** Body click: select, honoring ⌘/Ctrl (toggle) and Shift (range) modifiers. */
  onSelect: (path: string, event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void
  /** Indicator click: toggle this row (Shift extends a range) — V1's check gutter. */
  onToggle: (path: string, event: Pick<MouseEvent, 'shiftKey'>) => void
  /** Open the row's note (double-click). */
  onOpen: (path: string, event?: ModClickEvent) => void
  /** The row's cells, in the grid's column order. */
  children: ReactNode
}

/**
 * One selectable row of a note list (All Notes, Wiki): clicking the body
 * selects it (V1's multi-select: plain = exclusive, ⌘/Ctrl = toggle, Shift =
 * range), the indicator gutter toggles it, and a double-click opens it.
 */
export function ListRow({
  path,
  grid,
  className,
  index,
  noun,
  selected,
  onSelect,
  onToggle,
  onOpen,
  children,
}: ListRowProps): ReactElement {
  return (
    <div
      data-row-index={index}
      onClick={(event) => {
        // Shift-click selects a range; stop the browser turning that into a text
        // selection across the rows.
        if (event.shiftKey) {
          event.preventDefault()
        }
        onSelect(path, event)
      }}
      onDoubleClick={(event) => onOpen(path, event)}
      className={cn(
        'group/row relative h-12 cursor-default select-none',
        grid,
        selected
          ? 'border-y border-accent/20 bg-accent-soft text-text dark:border-accent/10 dark:text-text'
          : 'shadow-[var(--border-hairline)] hover:bg-surface-hover',
        className,
      )}
    >
      <button
        type="button"
        aria-label={selected ? `Deselect ${noun}` : `Select ${noun}`}
        aria-pressed={selected}
        onClick={(event) => {
          event.stopPropagation()
          onToggle(path, event)
        }}
        className={cn(
          'group absolute inset-y-0 left-0 flex w-12 items-center justify-center opacity-0 transition-opacity duration-100 hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none',
          selected ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'size-2 rounded-full transition-transform duration-150 group-hover:scale-110',
            selected ? 'bg-accent' : 'ring-1 ring-accent',
          )}
        />
      </button>
      {children}
    </div>
  )
}
