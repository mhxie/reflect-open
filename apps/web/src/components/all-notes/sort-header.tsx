import type { ReactElement } from 'react'
import { ArrowDown, ArrowUp, type LucideIcon } from 'lucide-react'
import type { SortDirection } from '@reflect/core'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'

interface SortHeaderProps<Key extends string> {
  label: string
  sortKey: Key
  sort: { readonly key: Key; readonly direction: SortDirection }
  onSort: (key: Key) => void
  /** How each direction of this column is announced, e.g. A to Z / Z to A. */
  directionLabels: Readonly<Record<SortDirection, string>>
  /** Right-align the label and arrow (a numeric or date column). */
  alignEnd?: boolean
  /** Shown in place of the label, for a narrow column; the label becomes its tooltip. */
  icon?: LucideIcon | undefined
}

/**
 * A sortable column header (All Notes, Wiki): sorts by its key, or flips the
 * direction when the list is already sorted by it.
 */
export function SortHeader<Key extends string>({
  label,
  sortKey,
  sort,
  onSort,
  directionLabels,
  alignEnd = false,
  icon: Icon,
}: SortHeaderProps<Key>): ReactElement {
  const active = sort.key === sortKey
  const Arrow = sort.direction === 'asc' ? ArrowUp : ArrowDown
  const button = (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      aria-label={
        active
          ? `${label}, sorted ${directionLabels[sort.direction]}`
          : `Sort by ${label.toLowerCase()}`
      }
      className={cn(
        'flex items-center gap-1 rounded-sm hover:text-text focus-visible:text-text focus-visible:outline-none',
        alignEnd && 'justify-self-end',
        active && 'text-text',
      )}
    >
      {Icon === undefined ? <span>{label}</span> : <Icon aria-hidden className="size-3.5" />}
      {active ? <Arrow aria-hidden className="size-3" strokeWidth={2} /> : null}
    </button>
  )
  if (Icon === undefined) {
    return button
  }
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
