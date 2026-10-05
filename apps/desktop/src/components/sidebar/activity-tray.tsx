import type { ReactElement } from 'react'
import { Activity as ActivityIcon } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { useNow } from '@/hooks/use-now.ts'
import { activityFraction, useActivity } from '@/lib/activity.ts'
import { cn } from '@/lib/utils.ts'
import { ActivityAttentionRow } from './activity-attention-row.tsx'
import { ActivityHistoryRow } from './activity-history-row.tsx'
import { ActivityProgressRing } from './activity-progress-ring.tsx'
import { ActivityRunningRow } from './activity-running-row.tsx'
import { ActivitySectionTitle } from './activity-section-title.tsx'

/**
 * The sidebar footer's activity tray, after Arc's downloads: one quiet icon for
 * all background work — a progress ring while something runs, a dot when
 * something needs attention — opening a list of what is running, what went
 * wrong, and what finished. Hidden until there is anything to show.
 */
export function ActivityTray(): ReactElement | null {
  const { running, attention, history } = useActivity()
  const now = useNow(30_000)
  if (running.length === 0 && attention.length === 0 && history.length === 0) {
    return null
  }

  const failed = attention.some((operation) => operation.status === 'failed')
  const summary = [
    running.length > 0 ? `${running.length} running` : null,
    attention.length > 0 ? `${attention.length} need attention` : null,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={summary === '' ? 'Activity' : `Activity: ${summary}`}
            className="relative size-7 shrink-0 text-text-muted transition-colors duration-100 hover:bg-surface-hover hover:text-text-secondary"
          >
            {running.length > 0 ? (
              <ActivityProgressRing fraction={activityFraction(running)} />
            ) : (
              <ActivityIcon aria-hidden strokeWidth={1.75} className="size-4" />
            )}
            {attention.length > 0 ? (
              <span
                aria-hidden
                className={cn(
                  'absolute top-1 right-1 size-1.5 rounded-full',
                  failed ? 'bg-destructive' : 'bg-amber-500',
                )}
              />
            ) : null}
          </Button>
        }
      />
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 p-0 pb-1.5">
        {running.length > 0 ? (
          <section aria-label="In progress">
            <ActivitySectionTitle>In progress</ActivitySectionTitle>
            <ul>
              {running.map((item) => (
                <ActivityRunningRow key={item.key} item={item} />
              ))}
            </ul>
          </section>
        ) : null}
        {attention.length > 0 ? (
          <section aria-label="Needs attention">
            <ActivitySectionTitle>Needs attention</ActivitySectionTitle>
            <ul>
              {attention.map((operation) => (
                <ActivityAttentionRow key={operation.id} operation={operation} />
              ))}
            </ul>
          </section>
        ) : null}
        {history.length > 0 ? (
          <section aria-label="Recent">
            <ActivitySectionTitle>Recent</ActivitySectionTitle>
            <ul>
              {history.map((entry) => (
                <ActivityHistoryRow key={entry.id} entry={entry} now={now} />
              ))}
            </ul>
          </section>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
