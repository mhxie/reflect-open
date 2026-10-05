import type { ReactElement } from 'react'
import { activityFraction, type ActivityItem } from '@/lib/activity.ts'
import { cn } from '@/lib/utils.ts'

const numberFormat = new Intl.NumberFormat()

export interface ActivityRunningRowProps {
  item: ActivityItem
}

/** Work in progress: its label, count, and a bar (pulsing when its size is unknown). */
export function ActivityRunningRow({ item }: ActivityRunningRowProps): ReactElement {
  const fraction = item.progress === null ? null : activityFraction([item])
  return (
    <li className="px-3 py-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate text-text-secondary">{item.label}</span>
        {item.progress === null ? null : (
          <span className="shrink-0 text-2xs text-text-muted tabular-nums">
            {numberFormat.format(item.progress.done)} / {numberFormat.format(item.progress.total)}
          </span>
        )}
      </div>
      {item.detail === null ? null : (
        <p className="truncate text-2xs text-text-muted">{item.detail}</p>
      )}
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-surface-active">
        <div
          className={cn(
            'h-full rounded-full bg-accent transition-[width] duration-300',
            fraction === null && 'w-1/3 motion-safe:animate-pulse',
          )}
          style={fraction === null ? undefined : { width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
    </li>
  )
}
