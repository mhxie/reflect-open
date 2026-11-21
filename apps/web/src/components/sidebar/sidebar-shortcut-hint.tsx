import type { ReactElement } from 'react'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'

// Match the sidebar hover surface, including its translucent dark-mode layers.
const SHORTCUT_BACKGROUND = [
  'linear-gradient(to right, transparent, var(--surface-hover) 1.5rem)',
  'linear-gradient(to right, transparent, var(--surface-sunken) 1.5rem)',
  'linear-gradient(to right, transparent, var(--surface-app) 1.5rem)',
].join(', ')

interface SidebarShortcutHintProps {
  binding: string
}

/** Reveal a floating shortcut inside a sidebar row on hover or keyboard focus. */
export function SidebarShortcutHint({ binding }: SidebarShortcutHintProps): ReactElement {
  return (
    <span
      aria-hidden
      className="pointer-events-none invisible absolute top-1/2 right-2.5 -translate-y-1/2 py-1 pl-6 text-2xs font-medium tracking-wide text-text opacity-0 transition-[opacity,visibility] duration-150 ease-out group-hover:visible group-hover:opacity-100 group-focus-visible:visible group-focus-visible:opacity-100 motion-reduce:transition-none"
      style={{ backgroundImage: SHORTCUT_BACKGROUND }}
    >
      <ShortcutKeys binding={binding} ghost />
    </span>
  )
}
