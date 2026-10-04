import type { ReactElement, ReactNode } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'
import { cn } from '@/lib/utils.ts'

// Match the sidebar hover surface, including its translucent dark-mode layers.
const SHORTCUT_BACKGROUND = [
  'linear-gradient(to right, transparent, var(--surface-hover) 1.5rem)',
  'linear-gradient(to right, transparent, var(--surface-sunken) 1.5rem)',
  'linear-gradient(to right, transparent, var(--surface-app) 1.5rem)',
].join(', ')

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
      {binding ? (
        <span
          aria-hidden
          className="pointer-events-none invisible absolute top-1/2 right-2.5 -translate-y-1/2 py-1 pl-6 text-2xs font-medium tracking-wide text-text opacity-0 transition-[opacity,visibility] duration-150 ease-out group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100 motion-reduce:transition-none"
          style={{ backgroundImage: SHORTCUT_BACKGROUND }}
        >
          <ShortcutKeys binding={binding} ghost />
        </span>
      ) : null}
    </button>
  )
}
