import type { ReactElement } from 'react'
import { Lock } from 'lucide-react'
import { isLocalOnlyPath } from '@reflect/core'
import { cn } from '@/lib/utils.ts'

/**
 * A small lock beside a note title in lists, for a note in a local-only
 * folder — read-only and never leaving this device — so it reads as such
 * before it is opened. Renders nothing for any other note.
 */
export function LocalOnlyMark({
  path,
  className,
}: {
  path: string
  className?: string
}): ReactElement | null {
  if (!isLocalOnlyPath(path)) {
    return null
  }
  return (
    <Lock
      role="img"
      aria-label="Local-only"
      strokeWidth={2}
      className={cn('inline size-3 shrink-0 align-[-1px] text-text-muted', className)}
    />
  )
}
