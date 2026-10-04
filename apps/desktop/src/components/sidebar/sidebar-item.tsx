import type { ReactElement, ReactNode } from 'react'
import { cn } from '@/lib/utils.ts'
import { SidebarShortcutHint } from './sidebar-shortcut-hint.tsx'

interface SidebarItemProps {
  /** A 24px icon node — the V1 custom glyphs, or a Lucide icon in a 24px box. */
  icon: ReactNode
  label: string
  /** Keymap binding hinted on hover/focus (e.g. `Mod-d`). */
  binding?: string | undefined
  active?: boolean
  onClick: () => void
}

/** Primary navigation with a shortcut revealed on hover or keyboard focus. */
export function SidebarItem({
  icon,
  label,
  binding,
  active = false,
  onClick,
}: SidebarItemProps): ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex w-full items-center gap-3 rounded-md px-2.5 py-1.5 text-sm font-medium',
        active
          ? 'bg-surface-hover text-text dark:bg-transparent dark:text-accent dark:hover:bg-surface-hover dark:focus-visible:bg-surface-hover'
          : 'text-text hover:bg-surface-hover focus-visible:bg-surface-hover',
      )}
    >
      <span className="relative z-10 flex shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {binding ? <SidebarShortcutHint binding={binding} /> : null}
    </button>
  )
}
