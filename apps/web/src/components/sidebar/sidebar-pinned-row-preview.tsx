import type { ReactElement } from 'react'
import { cn } from '@/lib/utils.ts'
import { SidebarShortcutHint } from './sidebar-shortcut-hint.tsx'

interface SidebarPinnedRowPreviewProps {
  label: string
  active: boolean
  overlay?: boolean
  placeholder?: boolean
  binding?: string | undefined
}

export function SidebarPinnedRowPreview({
  active,
  label,
  overlay = false,
  placeholder = false,
  binding,
}: SidebarPinnedRowPreviewProps): ReactElement {
  const stateClass = placeholder
    ? 'bg-surface-hover text-transparent'
    : overlay
      ? 'bg-white text-text-secondary'
      : active
        ? 'bg-surface-hover text-text-secondary dark:bg-transparent dark:text-accent dark:hover:bg-surface-hover dark:group-focus-visible:bg-surface-hover'
        : 'text-text-secondary hover:bg-surface-hover hover:text-text group-focus-visible:bg-surface-hover group-focus-visible:text-text'

  return (
    <span
      className={cn(
        'group relative flex w-full touch-none items-center rounded-md leading-5',
        stateClass,
        overlay && 'shadow-sm',
      )}
    >
      <span className={cn('min-w-0 flex-1 py-1 px-2.5 text-left', placeholder && 'invisible')}>
        <span className="block truncate text-xs font-medium">{label}</span>
      </span>
      {binding && !placeholder && !overlay ? <SidebarShortcutHint binding={binding} /> : null}
    </span>
  )
}
