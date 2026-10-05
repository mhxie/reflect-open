import type { ReactElement } from 'react'
import { CircleAlert, CircleCheck } from 'lucide-react'
import type { FinishedOperation } from '@/lib/operations.ts'

/** "just now", "5 min ago", "2 h ago". */
function agoLabel(endedAt: number, now: number): string {
  const minutes = Math.floor((now - endedAt) / 60_000)
  if (minutes < 1) {
    return 'just now'
  }
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`
}

export interface ActivityHistoryRowProps {
  entry: FinishedOperation
  /** The current time (epoch ms), for the "ago" label. */
  now: number
}

/** A finished background operation and how long ago it ended. */
export function ActivityHistoryRow({ entry, now }: ActivityHistoryRowProps): ReactElement {
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
