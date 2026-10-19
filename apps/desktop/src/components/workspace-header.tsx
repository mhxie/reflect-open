import type { ReactElement } from 'react'
import { Settings } from 'lucide-react'
import { ShortcutKeys } from '@/components/shortcut-keys.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { keybindingFor } from '@/lib/commands/app-commands.ts'
import type { ResolvedTheme } from '@/providers/theme-provider.tsx'

const SETTINGS_BINDING = keybindingFor('settings.open')

interface WorkspaceHeaderProps {
  /** Display name of the open graph. */
  graphName: string
  /** Absolute root path (shown as a tooltip when the name is truncated). */
  graphRoot: string
  /** True while the background index reconcile is running. */
  indexing: boolean
  /** App version, or `null` while it loads. */
  version: string | null
  resolvedTheme: ResolvedTheme
  onToggleTheme: () => void
  onOpenSettings: () => void
}

/**
 * The workspace title bar: graph name, indexing status, version, and the
 * theme/settings controls. The workspace passes its state down as props; the
 * settings tooltip's shortcut hint reads the platform from the core services.
 */
export function WorkspaceHeader({
  graphName,
  graphRoot,
  indexing,
  version,
  resolvedTheme,
  onToggleTheme,
  onOpenSettings,
}: WorkspaceHeaderProps): ReactElement {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-black/10 px-6 py-3 dark:border-white/10">
      <Tooltip>
        <TooltipTrigger
          delay={700}
          render={<h1 className="truncate text-sm font-semibold">{graphName}</h1>}
        />
        <TooltipContent>{graphRoot}</TooltipContent>
      </Tooltip>
      <div className="flex items-center gap-3">
        {indexing ? (
          <span
            role="status"
            className="text-xs text-[color:var(--text-muted)] motion-safe:animate-pulse"
          >
            Indexing…
          </span>
        ) : null}
        <span className="text-xs text-[color:var(--text-muted)]">v{version ?? '—'}</span>
        <button
          type="button"
          onClick={onToggleTheme}
          className="rounded-md border border-black/10 px-2.5 py-1 text-xs font-medium dark:border-white/10"
        >
          {resolvedTheme === 'dark' ? 'Light' : 'Dark'} mode
        </button>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Open settings"
                onClick={onOpenSettings}
                className="rounded-md border border-black/10 p-1.5 text-[color:var(--text-secondary)] dark:border-white/10"
              >
                <Settings aria-hidden className="size-3.5" />
              </button>
            }
          />
          <TooltipContent>
            Settings {SETTINGS_BINDING && <ShortcutKeys binding={SETTINGS_BINDING} />}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  )
}
