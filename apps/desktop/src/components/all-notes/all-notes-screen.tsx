import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  chooseNoteListSort,
  classifyKnowledgePath,
  foldTag,
  isDaily,
  listNotes,
  listNoteTags,
  sortNoteListRows,
  type NoteListOptions,
  type NoteListSortKey,
} from '@reflect/core'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { useKnowledgeLevels } from '@/hooks/use-knowledge-level.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { queryKeys } from '@/lib/query-client.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { useListSelection } from '@/lib/selection/use-list-selection.ts'
import { useScrollRestoration } from '@/lib/use-scroll-restoration.ts'
import { useScrollToIndexBridge } from '@/lib/use-scroll-to-index-bridge.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { routeForPath, type AllNotesFilter } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'
import { AllNotesFilters } from './all-notes-filters.tsx'
import { AllNotesPrivacyButton } from './all-notes-privacy-button.tsx'
import { AllNotesTable } from './all-notes-table.tsx'
import { AttachmentGallery } from './attachment-gallery.tsx'
import { AllNotesTrashDialog } from './all-notes-trash-dialog.tsx'
import { NewNoteButton } from './new-note-button.tsx'
import { useAllNotesKeyboard } from './use-all-notes-keyboard.ts'
import { isModEvent } from '@meowdown/core'

/** The `listNotes` options for a route filter. */
function noteListOptions(filter: AllNotesFilter | null): NoteListOptions {
  switch (filter?.kind) {
    case undefined:
      return {}
    case 'tag':
      return { tag: filter.tag }
    case 'attachment':
      return { attachment: filter.type }
    case 'updated':
      return { updatedOn: filter.date }
    case 'level':
      return { includeDaily: true }
  }
}

/** The list query's cache key for a route filter. */
function allNotesQueryKey(root: string | undefined, filter: AllNotesFilter | null) {
  switch (filter?.kind) {
    case undefined:
      return queryKeys.index.allNotesWithTag(root, null)
    case 'tag':
      return queryKeys.index.allNotesWithTag(root, foldTag(filter.tag))
    case 'attachment':
      return queryKeys.index.allNotesWithAttachment(root, filter.type)
    case 'updated':
      return queryKeys.index.allNotesUpdatedOn(root, filter.date)
    case 'level':
      return queryKeys.index.allNotesIncludingDaily(root)
  }
}

interface AllNotesScreenProps {
  /** Active filter carried by the route (`null` = all non-daily notes). */
  filter: AllNotesFilter | null
}

/**
 * The All Notes screen (a routed view, like settings): every non-daily note,
 * newest first or in the order chosen from the column headers (the
 * `allNotesSort` setting, so it holds across filters and restarts), filterable
 * by a tag, attachment type, edit day, or knowledge level. The active filter lives on the route so
 * back/forward and "open a note, come back" keep it.
 * Daily notes are deliberately absent from the unfiltered view, but appear when
 * they match the active filter.
 *
 * Rows are multi-selectable (V1 parity): click to select (⌘ toggle, Shift
 * range), the indicator gutter toggles, the subject or a double-click opens.
 * Keyboard shortcuts act on the selection — ↑/↓ (Shift to extend), ⌘A select
 * all, Return open, ⌘⌫ trash (to the OS trash, after a confirm), Esc clear.
 *
 * Owns its scroll container (the daily stream's shape, not `ScrollRestored`'s)
 * so the header and filter bar stay put while the virtualized table scrolls,
 * wired to the router's per-entry scroll memory by hand.
 */
export function AllNotesScreen({ filter }: AllNotesScreenProps): ReactElement {
  const { graph } = useGraph()
  const { settings, updateSettingsWith } = useSettings()
  const knowledgeLevels = useKnowledgeLevels()
  const sort = settings.allNotesSort
  const { navigate } = useRouter()
  const navigateNoteLink = useNoteLinkNavigation()
  // The scroll container lives in state, not a ref, so scroll restoration
  // re-runs its restore once the element attaches (a callback ref re-renders;
  // a plain ref would still be null during the restore effect on the first,
  // warm-cache-only mount). The table virtualizes against this container as its
  // parent, so it no longer needs the element handed down.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  // The surface, so the keyboard shortcuts can scope to it (and focus it on mount).
  const rootRef = useRef<HTMLDivElement>(null)

  const bridgeReady = useBridgeReady()
  const enabled = bridgeReady && graph !== null

  const { data: notes } = useQuery({
    queryKey: allNotesQueryKey(graph?.root, filter),
    queryFn: () => listNotes(noteListOptions(filter)),
    enabled,
  })
  const { data: facets } = useQuery({
    queryKey: queryKeys.index.allNotesTags(graph?.root),
    queryFn: () => listNoteTags(),
    enabled,
  })

  // The index read is newest first; another order re-sorts the cached rows, so
  // switching order is instant and shares the filter's query.
  const sortedNotes = useMemo(() => {
    if (notes === undefined) return
    if (filter?.kind !== 'level') return sortNoteListRows(notes, sort)
    if (knowledgeLevels === undefined) return
    if (knowledgeLevels.kind !== 'ready') return []
    return sortNoteListRows(
      notes.filter(
        (note) => classifyKnowledgePath(note.path, knowledgeLevels.config)?.level === filter.level,
      ),
      sort,
    )
  }, [notes, sort, filter, knowledgeLevels])
  const levels = useMemo(
    () =>
      knowledgeLevels?.kind === 'ready'
        ? knowledgeLevels.config.levels
            .map(({ level }) => level)
            .sort((left, right) => left - right)
        : [],
    [knowledgeLevels],
  )
  const levelUnavailable =
    filter?.kind === 'level' && knowledgeLevels !== undefined && knowledgeLevels.kind !== 'ready'
  const handleSort = useCallback(
    (key: NoteListSortKey) =>
      updateSettingsWith((current) => ({
        allNotesSort: chooseNoteListSort(current.allNotesSort, key),
      })),
    [updateSettingsWith],
  )

  const ready = sortedNotes !== undefined
  const { onScroll } = useScrollRestoration(scrollElement, ready)

  // The flat, render-order paths the selection and its shortcuts act on.
  const orderedPaths = useMemo(() => (sortedNotes ?? []).map((note) => note.path), [sortedNotes])
  const selection = useListSelection(orderedPaths)
  const openNote = useCallback(
    (path: string, event?: ModClickEvent) =>
      navigateNoteLink({
        target: routeForPath(path),
        openInNewWindow: event !== undefined && isModEvent(event),
      }),
    [navigateNoteLink],
  )
  const handleFilterSelect = useCallback(
    (next: AllNotesFilter | null) => navigate({ kind: 'allNotes', filter: next }),
    [navigate],
  )

  // The bulk-trash confirm: the screen owns whether it's open and which paths it
  // acts on (snapshotted at open time, since the delete prunes the live
  // selection); the dialog owns the delete and its error. Daily rows remain
  // selectable for keyboard navigation, but are never valid trash targets.
  const [confirmingTrash, setConfirmingTrash] = useState(false)
  const [pendingPaths, setPendingPaths] = useState<readonly string[]>([])
  const trashableSelectedPaths = useMemo(
    () => [...selection.selected].filter((path) => !isDaily(path)),
    [selection.selected],
  )
  const selectedNotes = useMemo(
    () => (sortedNotes ?? []).filter((note) => selection.selected.has(note.path)),
    [sortedNotes, selection.selected],
  )
  const openTrashConfirm = useCallback(() => {
    if (trashableSelectedPaths.length === 0) {
      return
    }
    setPendingPaths(trashableSelectedPaths)
    setConfirmingTrash(true)
  }, [trashableSelectedPaths])

  // The table owns the virtualizer; the bridge lets the keyboard nav pull an
  // off-screen (unmounted) row into view through the virtualizer's scrollToIndex.
  const { scrollToIndex, registerScrollToIndex } = useScrollToIndexBridge()

  useAllNotesKeyboard({
    selection,
    orderedPaths,
    onOpen: openNote,
    onRequestTrash: openTrashConfirm,
    rootRef,
    scrollToIndex,
  })

  // Move focus into the surface on mount so the shortcuts work the moment you
  // navigate here, without first clicking the list (mirrors the Tasks view).
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label="All notes"
      className="flex h-full min-h-0 flex-col outline-none @container/all-notes"
    >
      <header className="flex min-w-0 flex-none flex-wrap items-center gap-2 border-b border-border px-3 py-4 @xs/all-notes:flex-nowrap @xl/all-notes:gap-3 @3xl/all-notes:pl-12 @3xl/all-notes:pr-7">
        <h1 className="hidden shrink-0 text-[15px] font-semibold text-text @xl/all-notes:block">
          Notes
        </h1>
        <div className="ml-auto w-full min-w-0 @xs/all-notes:w-auto">
          <AllNotesFilters
            filter={filter}
            facets={facets ?? []}
            levels={levels}
            onSelect={handleFilterSelect}
          />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2 @xs/all-notes:ml-0 @xl/all-notes:gap-3">
          <AllNotesPrivacyButton notes={selectedNotes} />
          {trashableSelectedPaths.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              aria-label={`Trash (${trashableSelectedPaths.length})`}
              onClick={openTrashConfirm}
              className="px-2 text-text-secondary hover:text-destructive @3xl/all-notes:px-2.5"
            >
              <Trash2 aria-hidden className="size-3.5" />
              <span className="hidden @3xl/all-notes:inline">Trash</span>
              <span
                aria-hidden
                className="flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive/10 px-1 text-[10px] font-semibold leading-none tabular-nums text-destructive"
              >
                {trashableSelectedPaths.length}
              </span>
            </Button>
          ) : null}
          <NewNoteButton />
        </div>
      </header>
      <div
        ref={setScrollElement}
        data-testid="all-notes-scroll"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto"
      >
        {levelUnavailable ? (
          <p role="status" className="py-8 pl-12 pr-7 text-sm text-text-muted">
            Knowledge levels are unavailable. Choose All levels to show notes.
          </p>
        ) : filter?.kind === 'attachment' &&
          (filter.type === 'image' || filter.type === 'pdf') &&
          sortedNotes !== undefined &&
          sortedNotes.length > 0 ? (
          <AttachmentGallery
            type={filter.type}
            notes={sortedNotes}
            selection={selection}
            onOpen={openNote}
            registerScrollToIndex={registerScrollToIndex}
          />
        ) : (
          <AllNotesTable
            notes={sortedNotes}
            filter={filter}
            sort={sort}
            onSort={handleSort}
            selection={selection}
            onOpen={openNote}
            registerScrollToIndex={registerScrollToIndex}
          />
        )}
      </div>

      <AllNotesTrashDialog
        open={confirmingTrash}
        onOpenChange={setConfirmingTrash}
        paths={pendingPaths}
        onTrashed={selection.clear}
      />
    </div>
  )
}
