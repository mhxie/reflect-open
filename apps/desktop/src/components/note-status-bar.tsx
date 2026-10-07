import { createElement, useState, type ReactElement } from 'react'
import { useNoteMenuRequest } from '@/editor/status/note-menu-request.ts'
import { useNoteStatus } from '@/editor/status/note-status-store.ts'
import { useNoteGitVersion } from '@/hooks/use-note-git-version.ts'
import { useNoteMtime } from '@/hooks/use-note-mtime.ts'
import { useNow } from '@/hooks/use-now.ts'
import { useTyping } from '@/hooks/use-typing.ts'
import { formatEditedLabel } from '@/lib/dates.ts'
import { noteDetails } from '@/lib/note-details.ts'
import { activeNoteStateKinds, noteStatePresentation } from '@/lib/note-state-presentation.ts'
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
import { NoteStatusMenu } from '@/components/note-status-menu.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Popover, PopoverContent } from '@/components/ui/popover.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { WikiClaimToggle } from '@/editor/wiki-anchors/wiki-claim-toggle.tsx'

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
  const [recovery, setRecovery] = useState({ root, generation, path, open: false })
  const recoveryOpen =
    visible &&
    recovery.root === root &&
    recovery.generation === generation &&
    recovery.path === path &&
    recovery.open
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  // The palette's "Show note details" and the editor's Private notice open
  // this menu from afar: each new request for this note opens it once, and a
  // request made before this note was shown is not replayed.
  const requested = useNoteMenuRequest(path)
  const [handled, setHandled] = useState({ path, id: requested })
  if (handled.path !== path) {
    setHandled({ path, id: requested })
  } else if (requested !== handled.id) {
    setHandled({ path, id: requested })
    if (requested !== null) {
      setDetails({ root, generation, path, open: true })
    }
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
  const kinds = activeNoteStateKinds(state)
  const labels = kinds.map((kind) => noteStatePresentation(kind).label)
  const sections = noteDetails({ state, backup: sync?.backup, version })
  const canTogglePrivacy = scope !== null && !state.isLocalOnly && !state.isProtected
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
      <div className="flex min-w-0 items-center gap-1">
        <DropdownMenu
          open={open}
          onOpenChange={(next) => setDetails({ root, generation, path, open: next })}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <DropdownMenuTrigger
                  ref={setAnchor}
                  aria-label={`Note state: ${labels.join(', ')}`}
                  className="pointer-events-auto inline-flex h-6 shrink-0 items-center gap-1.5 rounded px-1 hover:bg-surface-active focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none data-popup-open:bg-surface-active"
                />
              }
            >
              {kinds.map((kind) => {
                const presentation = noteStatePresentation(kind)
                return (
                  <span key={kind} data-testid="note-state-badge" data-state={kind}>
                    {createElement(presentation.icon, {
                      className: cn('size-3 shrink-0', presentation.className),
                      'aria-hidden': true,
                    })}
                  </span>
                )
              })}
            </TooltipTrigger>
            <TooltipContent side="top">{labels.join(' · ')}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            side="top"
            align="start"
            className="pointer-events-auto w-60 max-w-[calc(100vw-2rem)]"
          >
            <NoteStatusMenu
              sections={sections}
              state={state}
              protection={state.isProtected ? (status.protection?.kind ?? null) : null}
              togglePath={canTogglePrivacy ? scope.path : null}
              onResolve={() => setRecovery({ root, generation, path, open: true })}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <WikiClaimToggle path={path} />
      </div>
      {state.isProtected && status.protection !== null && scope !== null ? (
        <Popover
          open={recoveryOpen}
          onOpenChange={(next) => setRecovery({ root, generation, path, open: next })}
        >
          <PopoverContent
            side="top"
            align="start"
            anchor={anchor}
            aria-label="Resolve note"
            className="pointer-events-auto max-h-(--available-height) w-72 max-w-[calc(100vw-2rem)] overflow-y-auto"
          >
            <NoteProtectionDetails
              key={`${scope.generation}:${scope.path}:${status.protection.kind}`}
              scope={scope}
              protection={status.protection}
            />
          </PopoverContent>
        </Popover>
      ) : null}
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
