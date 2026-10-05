import type { ReactElement, ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GitMerge } from 'lucide-react'
import {
  conflictMarkerBlockCount,
  conflictMarkerLabels,
  detectConflictMarkers,
  getNote,
  readNote,
} from '@reflect/core'
import { CONFLICT_SIDE_DOT } from '@/components/conflict-note-view.tsx'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { useConflictResolution } from '@/hooks/use-conflict-resolution.ts'
import { isMobileSurface } from '@/lib/platform-surface.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { cn } from '@/lib/utils.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

interface SyncConflictNoticeProps {
  /** Graph-relative path of the open note. */
  path: string
  /**
   * The file text the conflict view beside the notice shows. Resolution
   * splices exactly this text and never lands over a newer version. Omit it
   * where no conflict view renders; resolution then reads the file at click.
   */
  shownContent?: string
  /** Show the same resolution actions inside the note-state popover. */
  compact?: boolean
  className?: string
}

/**
 * The `Needs review` banner + resolution actions for a note whose file
 * carries sync conflict markers (a backup merge where this and another
 * device edited the same note, Plan 12).
 *
 * Conflict markers don't survive the editor's markdown round-trip (the
 * discovery spike showed `=======` re-parsing as a setext underline and both
 * marker lines mangling), so conflicted notes open **protected** — the file
 * is shown read-only with each block's sides color-coded
 * ({@link ConflictNoteView}), and the buttons here carry the matching color
 * dots. Resolution therefore happens here, as
 * a pure text splice over the raw file ({@link useConflictResolution}):
 * keep this device's side, the other device's, or both. Either way nothing
 * is lost — every version remains in the backup history. The flag is a
 * projection of the file content, so the banner clears itself once the
 * resolved file reindexes.
 *
 * Mobile uses the same protected session contract and raw-text resolution
 * actions. The buttons are touch-sized there, but still call the same resolver.
 */
export function SyncConflictNotice({
  path,
  shownContent,
  compact = false,
  className,
}: SyncConflictNoticeProps): ReactElement | null {
  const { graph } = useGraph()
  const { busy, error, resolve } = useConflictResolution(path, shownContent)
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: queryKeys.index.noteConflict(graph?.root, path),
    queryFn: async () => (await getNote(path)) ?? null,
    enabled: bridgeReady && graph !== null && shownContent === undefined,
  })
  const hasConflict =
    shownContent === undefined ? data?.hasConflict === true : detectConflictMarkers(shownContent)
  // The iCloud sweep labels marker sides with real device names (or the two
  // colliding filenames) — read them so the buttons say what they keep. The
  // Git path's generic `this device`/`other device` keeps the classic copy.
  // A multi-block note (three-plus devices, Plan 21) pluralizes: `theirs`
  // splices in every non-first side, so naming a single device would lie.
  const { data: markerInfo } = useQuery({
    queryKey: queryKeys.index.noteConflictLabels(graph?.root, path),
    queryFn: async () => {
      const source = await readNote(path)
      return {
        labels: conflictMarkerLabels(source),
        blocks: conflictMarkerBlockCount(source),
      }
    },
    enabled: bridgeReady && graph !== null && hasConflict && shownContent === undefined,
  })

  if (!bridgeReady || !hasConflict || graph === null) {
    return null
  }
  const labels =
    shownContent === undefined ? (markerInfo?.labels ?? null) : conflictMarkerLabels(shownContent)
  const manySided =
    (shownContent === undefined
      ? (markerInfo?.blocks ?? 0)
      : conflictMarkerBlockCount(shownContent)) > 1
  const named = labels != null && labels.ours !== 'this device'
  const mobile = isMobileSurface()
  // One row when the labels fit (short generic labels, wide panes); a button
  // whose device name doesn't fit wraps to its own full-width line. Mobile
  // buttons are touch-sized and stretch to share the row evenly.
  const actionClassName = compact
    ? 'h-auto min-h-8 w-full justify-start py-2 text-left whitespace-normal'
    : mobile
      ? 'h-9 flex-1 justify-center px-3'
      : undefined

  const actions = (
    <>
      <div className={cn('flex flex-wrap gap-2', !compact && (mobile ? 'mt-3' : 'mt-2.5'))}>
        <ResolveButton
          dot="ours"
          className={actionClassName}
          disabled={busy}
          onClick={() => void resolve('ours')}
        >
          {named ? `Keep “${labels.ours}”` : 'Keep this device’s version'}
        </ResolveButton>
        <ResolveButton
          dot="theirs"
          className={actionClassName}
          disabled={busy}
          onClick={() => void resolve('theirs')}
        >
          {manySided
            ? 'Keep the other versions'
            : named
              ? `Keep “${labels.theirs}”`
              : 'Keep the other device’s'}
        </ResolveButton>
        <ResolveButton
          dot="both"
          className={actionClassName}
          disabled={busy}
          onClick={() => void resolve('both')}
        >
          {manySided ? 'Keep all' : 'Keep both'}
        </ResolveButton>
      </div>
      {error !== null ? (
        <p className="mt-2 text-red-700 dark:text-red-300">Couldn’t resolve: {error}</p>
      ) : null}
    </>
  )

  if (compact) {
    return <div className={className}>{actions}</div>
  }
  return (
    <InlineAlert tone="warning" className={className}>
      <div className="flex gap-2">
        <GitMerge aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">This note was edited on two devices at once.</p>
          <p className="mt-0.5">
            Both versions are highlighted below. Choose what to keep — every version stays
            recoverable in the backup history.
          </p>
        </div>
      </div>
      {actions}
    </InlineAlert>
  )
}

interface ResolveButtonProps {
  /** Which side's color dot the button carries — `both` shows the pair. */
  dot: 'ours' | 'theirs' | 'both'
  className?: string | undefined
  disabled: boolean
  onClick: () => void
  children: ReactNode
}

/**
 * One resolution action, color-matched to the conflict view: the dot inside
 * the button is the same tone as the version it keeps.
 */
function ResolveButton({
  dot,
  className,
  disabled,
  onClick,
  children,
}: ResolveButtonProps): ReactElement {
  return (
    <Button size="sm" variant="outline" className={className} disabled={disabled} onClick={onClick}>
      {dot === 'both' ? (
        <span aria-hidden className="flex shrink-0 items-center -space-x-0.5">
          <span
            className={cn(
              'size-2 shrink-0 rounded-full ring-1 ring-background',
              CONFLICT_SIDE_DOT.ours,
            )}
          />
          <span className={cn('size-2 shrink-0 rounded-full', CONFLICT_SIDE_DOT.theirs)} />
        </span>
      ) : (
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', CONFLICT_SIDE_DOT[dot])} />
      )}
      <span className="min-w-0 break-words">{children}</span>
    </Button>
  )
}
