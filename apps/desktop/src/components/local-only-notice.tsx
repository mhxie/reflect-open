import type { ReactElement } from 'react'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils.ts'

interface LocalOnlyNoticeProps {
  className?: string | undefined
}

/**
 * The read-only marker on a note inside a local-only folder: one quiet line
 * rather than an alert — nothing is wrong, the note simply stays on this
 * device (never written, synced, or sent to a service).
 */
export function LocalOnlyNotice({ className }: LocalOnlyNoticeProps): ReactElement {
  return (
    <p
      data-testid="local-only-notice"
      className={cn('flex items-center gap-1.5 text-xs text-text-muted', className)}
    >
      <Lock size={12} aria-hidden />
      Local-only · read-only, stays on this device
    </p>
  )
}
