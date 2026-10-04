import type { ReactElement } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { NoteListSort, NoteListSortKey } from '@reflect/core'
import { cn } from '@/lib/utils.ts'

interface SortHeaderProps {
  label: string
  sortKey: NoteListSortKey
  sort: NoteListSort
  onSort: (key: NoteListSortKey) => void
  /** Right-align the label and arrow (the Updated column). */
  alignEnd?: boolean
}

/** How each key's active direction is announced. */
const DIRECTION_LABELS: Record<NoteListSortKey, Record<NoteListSort['direction'], string>> = {
  title: { asc: 'A to Z', desc: 'Z to A' },
  updated: { asc: 'oldest first', desc: 'newest first' },
}

/**
 * An All Notes column header that sorts by its key, or flips the direction
 * when the list is already sorted by it.
 */
export function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  alignEnd = false,
}: SortHeaderProps): ReactElement {
  const active = sort.key === sortKey
  const Arrow = sort.direction === 'asc' ? ArrowUp : ArrowDown
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={
        active
          ? `${label}, sorted ${DIRECTION_LABELS[sortKey][sort.direction]}`
          : `Sort by ${label.toLowerCase()}`
      }
      className={cn(
        'flex items-center gap-1 rounded-sm hover:text-text focus-visible:text-text focus-visible:outline-none',
        alignEnd && 'justify-self-end',
        active && 'text-text',
      )}
    >
      <span>{label}</span>
      {active ? <Arrow aria-hidden className="size-3" strokeWidth={2} /> : null}
    </button>
  )
}
