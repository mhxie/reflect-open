import type { ReactElement } from 'react'
import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils.ts'

interface LocalOnlyNoticeProps {
  /**
   * The note is edited in place (its folder is editable): the notice drops
   * "read-only" and says the note stays out of the backup instead.
   */
  editable?: boolean
  className?: string | undefined
}

/**
 * The marker on a note inside a local-only folder: one quiet line rather
 * than an alert — nothing is wrong, the note simply stays on this device,
 * out of the Git backup and away from every service. It claims no more than
 * that: the folder itself may sit in a cloud drive's synced folder.
 */
export function LocalOnlyNotice({
  editable = false,
  className,
}: LocalOnlyNoticeProps): ReactElement {
  return (
    <p
      data-testid="local-only-notice"
      className={cn('flex items-center gap-1.5 text-xs text-text-muted', className)}
    >
      <Lock size={12} aria-hidden />
      {editable
        ? 'Local-only · stays on this device, not backed up'
        : 'Local-only · read-only, stays on this device'}
    </p>
  )
}
