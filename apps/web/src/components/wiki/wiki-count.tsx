import type { ReactElement, ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

interface WikiCountProps {
  icon: LucideIcon
  count: number
  /** What the count is, in words — its tooltip and accessible name. */
  label: string
  /** A mark after the number, such as a warning dot. */
  children?: ReactNode
}

/** A compact count on the Wiki screen: an icon naming what is counted, then the number. */
export function WikiCount({ icon: Icon, count, label, children }: WikiCountProps): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className="flex items-center gap-1 text-[12px] tabular-nums text-text-secondary"
          >
            <Icon aria-hidden className="size-3 flex-none text-text-muted" />
            <span aria-hidden>{count}</span>
            {children}
          </span>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
