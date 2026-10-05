import { createElement, useState, type ReactElement } from 'react'
import { useNoteStatus } from '@/editor/status/note-status-store.ts'
import { useNoteGitVersion } from '@/hooks/use-note-git-version.ts'
import { useNoteMtime } from '@/hooks/use-note-mtime.ts'
import { useNow } from '@/hooks/use-now.ts'
import { useTyping } from '@/hooks/use-typing.ts'
import { formatEditedLabel } from '@/lib/dates.ts'
import { noteStatePresentation } from '@/lib/note-state-presentation.ts'
import { cn } from '@/lib/utils.ts'
import { useToday } from '@/lib/use-today.ts'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider.tsx'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useSyncContext } from '@/providers/sync-provider.tsx'
import { focusedNotePathForRoute } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'
import { usePeekedNotePath } from '@/components/peek/peek-provider.tsx'
import { NoteProtectionDetails } from '@/components/note-protection-details.tsx'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover.tsx'

const numberFormat = new Intl.NumberFormat()

/** Relative edit times ("5 min ago") refresh this often. */
const CLOCK_MS = 30_000

/** Only the statistics step aside while typing; the state entry stays usable. */
const TYPING_IDLE_MS = 1500

interface NoteStatusBarProps {
  readonly placement?: 'overlay' | 'inline'
  /** A retained mobile screen's note, independent of the currently active route. */
  readonly path?: string
}

/**
 * One compact row for the focused or peeked note: explicit state on the left,
 * edit time and counts on the right. The state entry opens keyboard-accessible
 * details; turning the existing status-bar setting off hides the whole row.
 */
export function NoteStatusBar({
  placement = 'overlay',
  path: explicitPath,
}: NoteStatusBarProps): ReactElement | null {
  const { route } = useRouter()
  const today = useToday()
  const focusedDailyDate = useFocusedDailyDate()
  const { settings } = useSettings()
  const { graph } = useGraph()
  const sync = useSyncContext()
  const peekedPath = usePeekedNotePath()
  const path = explicitPath ?? peekedPath ?? focusedNotePathForRoute(route, today, focusedDailyDate)
  const generation = graph?.generation ?? null
  const root = graph?.root ?? null
  const scope = generation === null || path === null ? null : { generation, path }
  const status = useNoteStatus(scope)
  const visible = settings.statusBarEnabled && status !== null
  const [details, setDetails] = useState({ root, generation, path, open: false })
  if (details.root !== root || details.generation !== generation || details.path !== path) {
    setDetails({ root, generation, path, open: false })
  }
  const open =
    visible &&
    details.root === root &&
    details.generation === generation &&
    details.path === path &&
    details.open
  const version = useNoteGitVersion({
    root,
    generation,
    path,
    open,
    isLocalOnly: status?.state.isLocalOnly ?? false,
  })
  const mtime = useNoteMtime(visible ? path : null)
  const now = useNow(CLOCK_MS)
  const typing = useTyping(TYPING_IDLE_MS)
  if (!visible) {
    return null
  }

  const { state } = status
  const backup = sync?.backup
  const connected = backup?.phase === 'connected'
  const presentation = noteStatePresentation(state.kind)
  const Icon = presentation.icon
  const graphStatus =
    backup?.phase === 'connected'
      ? { idle: 'Idle', syncing: 'Syncing', offline: 'Offline', error: 'Error' }[
          backup.status.state
        ]
      : backup?.phase === 'loading'
        ? 'Unknown'
        : 'Disconnected'
  const dimensions = [
    { name: 'Edit', value: state.isReadOnly ? 'Read-only' : 'Editable' },
    { name: 'Privacy', value: state.isPrivate ? 'Private' : 'Standard' },
    { name: 'AI', value: state.isPrivate ? 'Blocked' : 'Allowed' },
    {
      name: 'Backup',
      value: state.isLocalOnly
        ? 'Excluded'
        : connected
          ? 'Included'
          : backup?.phase === 'loading'
            ? 'Unknown'
            : 'Disconnected',
    },
    { name: 'Graph', value: graphStatus },
    {
      name: 'Version',
      value: state.isLocalOnly
        ? 'Excluded'
        : version.unavailable
          ? 'Unavailable'
          : version.version !== null
            ? version.version
            : version.pending
              ? 'Loading'
              : 'Uncommitted',
    },
  ]
  const editedAt = Math.max(mtime ?? 0, status.editedAt ?? 0)
  const characters = numberFormat.format(status.characters)
  return (
    <div
      role="status"
      aria-label="Note status"
      className={cn(
        'pointer-events-none flex h-6 min-w-0 shrink-0 items-center justify-between gap-3 border-t border-border/50 bg-surface/50 px-4 text-2xs whitespace-nowrap tabular-nums text-text-muted backdrop-blur-[2px] @container/note-status',
        placement === 'overlay' && 'absolute inset-x-0 bottom-0 z-10',
        placement === 'overlay' && peekedPath !== null && 'z-30',
      )}
    >
      <Popover
        open={open}
        onOpenChange={(next) => setDetails({ root, generation, path, open: next })}
      >
        <PopoverTrigger
          type="button"
          aria-label={`Note state: ${presentation.label}`}
          className={cn(
            'pointer-events-auto inline-flex h-6 shrink-0 items-center gap-1 rounded px-1 text-2xs hover:bg-surface-active focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
            presentation.className,
          )}
        >
          {createElement(Icon, {
            className: 'relative -top-px size-3 shrink-0',
            'aria-hidden': true,
          })}
          <span>{presentation.label}</span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          aria-label="Note details"
          className={cn(
            'pointer-events-auto max-h-(--available-height) max-w-[calc(100vw-2rem)] overflow-y-auto',
            state.isProtected ? 'w-72' : 'w-60',
          )}
        >
          <PopoverTitle className="text-xs">Note details</PopoverTitle>
          {state.isProtected && status.protection !== null && scope !== null ? (
            <NoteProtectionDetails
              key={`${scope.generation}:${scope.path}:${status.protection.kind}`}
              scope={scope}
              protection={status.protection}
            />
          ) : null}
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-xs">
            {dimensions.map(({ name, value }) => (
              <div key={name} className="contents">
                <dt className="text-text-muted">{name}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </PopoverContent>
      </Popover>
      <div
        data-testid="note-statistics"
        className={cn(
          'flex min-w-0 items-center gap-3 overflow-hidden transition-opacity duration-300',
          typing && 'opacity-0',
        )}
      >
        {editedAt > 0 ? (
          <span className="hidden @sm/note-status:inline" data-testid="note-edit-time">
            {formatEditedLabel(editedAt, settings, new Date(Math.max(now, editedAt)))}
          </span>
        ) : null}
        <span className="truncate">
          {status.selectedCharacters > 0
            ? `${numberFormat.format(status.selectedCharacters)} / ${characters} chars`
            : `${characters} chars`}
        </span>
      </div>
    </div>
  )
}
