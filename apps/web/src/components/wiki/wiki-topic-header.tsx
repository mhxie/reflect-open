import type { MouseEvent, ReactElement } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

interface WikiTopicHeaderProps {
  /** The section's label: the topic folder, or "Overview" for root entries. */
  label: string
  count: number
  folded: boolean
  /** Fold or unfold this topic; ⌥-click (`all`) applies the new state to every topic. */
  onToggle: (all: boolean) => void
}

/**
 * A topic section's heading on the grouped Wiki screen, doubling as its fold
 * toggle: a chevron, the topic, and its entry count.
 */
export function WikiTopicHeader({
  label,
  count,
  folded,
  onToggle,
}: WikiTopicHeaderProps): ReactElement {
  const Chevron = folded ? ChevronRight : ChevronDown
  return (
    <h2 className="pb-1.5 pl-7 pr-7 pt-5">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={(event: MouseEvent) => onToggle(event.altKey)}
        className="flex items-center gap-1.5 rounded-sm text-[11px] font-semibold uppercase tracking-wide text-text-muted hover:text-text focus-visible:text-text focus-visible:outline-none"
      >
        <Chevron aria-hidden strokeWidth={2} className="size-3.5" />
        {label}
        <span className="font-normal tabular-nums">{count}</span>
      </button>
    </h2>
  )
}
