import type { ReactElement } from 'react'
import { Activity as ActivityIcon, CircleAlert, CircleCheck, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx'
import { useNow } from '@/hooks/use-now.ts'
import { activityFraction, useActivity, type ActivityItem } from '@/lib/activity.ts'
import { dismissOperation, type FinishedOperation, type Operation } from '@/lib/operations.ts'
import { cn } from '@/lib/utils.ts'

const numberFormat = new Intl.NumberFormat()

/** "just now", "5 min ago", "2 h ago". */
function agoLabel(endedAt: number, now: number): string {
  const minutes = Math.floor((now - endedAt) / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
}

/** A 16px ring: filled to `fraction`, or a spinning arc when the size is unknown. */
function ProgressRing({ fraction }: { fraction: number | null }): ReactElement {
  const circumference = 2 * Math.PI * 6
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      className={cn('size-4 -rotate-90', fraction === null && 'motion-safe:animate-spin')}
    >
      <circle cx="8" cy="8" r="6" fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-accent transition-[stroke-dashoffset] duration-300"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - (fraction ?? 0.25))}
      />
    </svg>
  )
}

function SectionTitle({ children }: { children: string }): ReactElement {
  return (
    <p className="px-3 pt-2 pb-1 text-2xs font-medium tracking-wide text-text-muted uppercase">
      {children}
    </p>
  )
}

function RunningRow({ item }: { item: ActivityItem }): ReactElement {
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

function AttentionRow({ operation }: { operation: Operation }): ReactElement {
  const Icon = operation.status === 'failed' ? CircleAlert : TriangleAlert
  const action = operation.action
  return (
    <li className="flex gap-2 px-3 py-1.5">
      <Icon
        aria-hidden
        strokeWidth={1.75}
        className={cn(
          'mt-0.5 size-3.5 shrink-0',
          operation.status === 'failed' ? 'text-red-500' : 'text-amber-500',
        )}
      />
      <div className="min-w-0 flex-1 text-xs">
        <p className="text-text-secondary">{operation.label}</p>
        {operation.message === null ? null : (
          <p className="text-2xs break-words text-text-muted">{operation.message}</p>
        )}
        {action === null ? null : (
          <Button
            size="xs"
            variant="secondary"
            className="mt-1"
            onClick={() => {
              void Promise.resolve(action.run()).catch((error: unknown) => {
                console.error('operation action failed:', error)
              })
            }}
          >
            {action.label}
          </Button>
        )}
      </div>
      <button
        type="button"
        aria-label={`Dismiss ${operation.label}`}
        onClick={() => dismissOperation(operation.id)}
        className="flex size-5 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
      >
        <X aria-hidden className="size-3" strokeWidth={1.75} />
      </button>
    </li>
  )
}

function HistoryRow({ entry, now }: { entry: FinishedOperation; now: number }): ReactElement {
  // An operation removed while still `running` finished cleanly.
  const succeeded = entry.status === 'running'
  return (
    <li className="flex items-center gap-2 px-3 py-1 text-xs">
      {succeeded ? (
        <CircleCheck aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0 text-accent" />
      ) : (
        <CircleAlert aria-hidden strokeWidth={1.75} className="size-3.5 shrink-0 text-amber-500" />
      )}
      <span className="min-w-0 flex-1 truncate text-text-secondary">{entry.label}</span>
      <span className="shrink-0 text-2xs text-text-muted">{agoLabel(entry.endedAt, now)}</span>
    </li>
  )
}

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
              <ProgressRing fraction={activityFraction(running)} />
            ) : (
              <ActivityIcon aria-hidden strokeWidth={1.75} className="size-4" />
            )}
            {attention.length > 0 ? (
              <span
                aria-hidden
                className={cn(
                  'absolute top-1 right-1 size-1.5 rounded-full',
                  failed ? 'bg-red-500' : 'bg-amber-500',
                )}
              />
            ) : null}
          </Button>
        }
      />
      <PopoverContent side="top" align="start" sideOffset={8} className="w-72 p-0 pb-1.5">
        {running.length > 0 ? (
          <section aria-label="In progress">
            <SectionTitle>In progress</SectionTitle>
            <ul>
              {running.map((item) => (
                <RunningRow key={item.key} item={item} />
              ))}
            </ul>
          </section>
        ) : null}
        {attention.length > 0 ? (
          <section aria-label="Needs attention">
            <SectionTitle>Needs attention</SectionTitle>
            <ul>
              {attention.map((operation) => (
                <AttentionRow key={operation.id} operation={operation} />
              ))}
            </ul>
          </section>
        ) : null}
        {history.length > 0 ? (
          <section aria-label="Recent">
            <SectionTitle>Recent</SectionTitle>
            <ul>
              {history.map((entry) => (
                <HistoryRow key={entry.id} entry={entry} now={now} />
              ))}
            </ul>
          </section>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
