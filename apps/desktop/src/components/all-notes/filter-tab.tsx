import type { ReactElement } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'

interface FilterTabProps {
  label: string
  active: boolean
  onClick: () => void
  /** Bound a long label and show its full text on hover or keyboard focus. */
  truncateLabel?: boolean
}

/** One segment of the All Notes tag-filter group. */
export function FilterTab({
  label,
  active,
  onClick,
  truncateLabel = false,
}: FilterTabProps): ReactElement {
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'shrink-0 whitespace-nowrap px-3 py-1.5 text-[13px] font-medium transition-colors duration-100',
        truncateLabel && 'max-w-44 truncate',
        active
          ? 'bg-surface-hover text-text'
          : 'text-text-secondary hover:bg-surface-hover hover:text-text',
      )}
    >
      {label}
    </button>
  )

  return truncateLabel ? (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent className="max-w-[min(20rem,calc(100vw-1rem))] break-all">
        {label}
      </TooltipContent>
    </Tooltip>
  ) : (
    button
  )
}
