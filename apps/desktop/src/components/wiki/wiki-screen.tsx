import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { isModEvent } from '@meowdown/core'
import {
  buildWikiIndexTree,
  chooseWikiSort,
  errorMessage,
  filterWikiEntries,
  groupWikiEntries,
  listWikiEntries,
  sortWikiEntries,
  visibleWikiIndexRows,
  wikiEntryIn,
  wikiSourceLanguage,
  wikiTopicKey,
  wikiTotals,
  type WikiFilter,
  type WikiSortKey,
} from '@reflect/core'
import { useAllNotesKeyboard } from '@/components/all-notes/use-all-notes-keyboard.ts'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useListSelection } from '@/lib/selection/use-list-selection.ts'
import { useScrollRestoration } from '@/lib/use-scroll-restoration.ts'
import { useToday } from '@/lib/use-today.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { routeForPath, wikiRoute } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'
import { WikiFilters } from './wiki-filters.tsx'
import { WikiLanguageTabs } from './wiki-language-tabs.tsx'
import { WikiLayoutTabs } from './wiki-layout-tabs.tsx'
import { WikiTable, type WikiTableLayout } from './wiki-table.tsx'

/** Whether a layout has no rows to show. */
function layoutIsEmpty(layout: WikiTableLayout): boolean {
  switch (layout.kind) {
    case 'tree':
      return layout.rows.length === 0
    case 'flat':
      return layout.entries.length === 0
    case 'grouped':
      return layout.groups.length === 0
  }
}

interface WikiScreenProps {
  /** The active filter, from the route (`null` = every entry). */
  filter: WikiFilter | null
  /** The folder of the language entries open in, from the route (`null` = the source). */
  language: string | null
}

/**
 * The Wiki screen (a routed view, like All Notes): every entry in the source
 * language's folder. The filter and the language it is read in live on the
 * route; order, grouping, and folded topics are settings. The Indexes filter
 * lays its rows out as the index tree instead, each index under the nearest
 * one above it, with what is collapsed kept only while the screen is open.
 * Keyboard follows All Notes, without trash: wiki entries are maintained by
 * their own pipeline.
 */
export function WikiScreen({ filter: routeFilter, language }: WikiScreenProps): ReactElement {
  const { graph } = useGraph()
  const { settings, updateSettingsWith } = useSettings()
  const { navigate } = useRouter()
  const navigateNoteLink = useNoteLinkNavigation()
  const today = useToday()
  // In state, not a ref, so scroll restoration re-runs once the element attaches.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const { wikiLanguages: languages, wikiSort: sort, wikiGroupByTopic: grouped } = settings
  const source = wikiSourceLanguage(languages)
  const folded = useMemo(() => new Set(settings.wikiFoldedTopics), [settings.wikiFoldedTopics])
  // Tree rows collapsed in this view, by their path inside the language folder.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  // A language removed from settings since the route was pushed reads the source.
  const translation =
    languages.find((candidate) => candidate !== source && candidate.folder === language) ?? null
  const openLanguage = translation?.folder ?? null
  // Likewise, a "Missing" filter for a removed language reads as no filter:
  // no entry has a copy there any more, so it would match them all.
  const filter =
    routeFilter?.kind === 'untranslated' &&
    !languages.some((candidate) => candidate !== source && candidate.folder === routeFilter.folder)
      ? null
      : routeFilter

  const bridgeReady = useBridgeReady()
  const { data: entries, error } = useQuery({
    queryKey: queryKeys.index.wikiEntries(graph?.root, today, languages),
    queryFn: async () =>
      graph === null
        ? []
        : await listWikiEntries({ generation: graph.generation, asOf: today, languages }),
    enabled: bridgeReady && graph !== null,
  })

  const layout = useMemo((): WikiTableLayout | undefined => {
    if (entries === undefined) {
      return undefined
    }
    const listed = entries.map((entry) => wikiEntryIn(entry, openLanguage))
    const visible = sortWikiEntries(filterWikiEntries(listed, filter), sort)
    if (filter?.kind === 'index') {
      const nodes = buildWikiIndexTree(visible, languages)
      return { kind: 'tree', nodes, rows: visibleWikiIndexRows(nodes, collapsed) }
    }
    return grouped
      ? { kind: 'grouped', groups: groupWikiEntries(visible) }
      : { kind: 'flat', entries: visible }
  }, [entries, openLanguage, filter, sort, grouped, languages, collapsed])
  const totals = useMemo(() => wikiTotals(entries ?? []), [entries])
  const { onScroll } = useScrollRestoration(scrollElement, layout !== undefined)

  // The flat, render-order paths of visible rows (folded topics hide theirs),
  // which the selection and its shortcuts act on.
  const orderedPaths = useMemo(() => {
    if (layout === undefined) {
      return []
    }
    if (layout.kind === 'tree') {
      return layout.rows.map((row) => row.entry.path)
    }
    if (layout.kind === 'flat') {
      return layout.entries.map((entry) => entry.path)
    }
    return layout.groups.flatMap((group) =>
      folded.has(wikiTopicKey(group.topic)) ? [] : group.entries.map((entry) => entry.path),
    )
  }, [layout, folded])
  const rowIndex = useMemo(
    () => new Map(orderedPaths.map((path, index) => [path, index])),
    [orderedPaths],
  )
  const selection = useListSelection(orderedPaths)

  // Rows carry the path of the copy they show, so an entry opens in the
  // language it is listed in.
  const openEntry = useCallback(
    (path: string, event?: ModClickEvent) =>
      navigateNoteLink({
        target: routeForPath(path),
        openInNewWindow: event !== undefined && isModEvent(event),
      }),
    [navigateNoteLink],
  )

  const handleSort = useCallback(
    (key: WikiSortKey) =>
      updateSettingsWith((current) => ({ wikiSort: chooseWikiSort(current.wikiSort, key) })),
    [updateSettingsWith],
  )
  const handleToggleFold = useCallback(
    (key: string, all: boolean) =>
      updateSettingsWith((current) => {
        const fold = !current.wikiFoldedTopics.includes(key)
        const keys =
          all && layout?.kind === 'grouped'
            ? layout.groups.map((group) => wikiTopicKey(group.topic))
            : [key]
        const rest = current.wikiFoldedTopics.filter((topic) => !keys.includes(topic))
        return { wikiFoldedTopics: fold ? [...rest, ...keys] : rest }
      }),
    [updateSettingsWith, layout],
  )

  const handleToggleExpanded = useCallback(
    (key: string) =>
      setCollapsed((current) => {
        const next = new Set(current)
        if (!next.delete(key)) {
          next.add(key)
        }
        return next
      }),
    [],
  )

  const scrollToIndex = useCallback((index: number) => {
    rootRef.current
      ?.querySelector(`[data-row-index="${CSS.escape(String(index))}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [])

  useAllNotesKeyboard({ selection, orderedPaths, onOpen: openEntry, rootRef, scrollToIndex })

  // Focus the surface on mount so the shortcuts work without a click first.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const isEmpty = entries !== undefined && entries.length === 0
  const nothingMatches = !isEmpty && layout !== undefined && layoutIsEmpty(layout)

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label="Wiki"
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-border py-4 pl-12 pr-7">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[15px] font-semibold text-text">Wiki</h1>
          {entries === undefined ? null : (
            <span className="text-[13px] tabular-nums text-text-secondary">
              {totals.entries} entries · {totals.claims} claims
            </span>
          )}
        </div>
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
          {entries === undefined || isEmpty ? null : (
            <WikiFilters
              entries={entries}
              languages={languages}
              filter={filter}
              onSelect={(next) => navigate(wikiRoute({ filter: next, language: openLanguage }))}
            />
          )}
          <WikiLanguageTabs
            languages={languages}
            language={openLanguage}
            onSelect={(next) => navigate(wikiRoute({ filter, language: next }))}
          />
          {/* The index tree is the Indexes layout; flat and topic views would contradict it. */}
          {filter?.kind === 'index' ? null : (
            <WikiLayoutTabs
              grouped={grouped}
              onChange={(next) => updateSettingsWith(() => ({ wikiGroupByTopic: next }))}
            />
          )}
        </div>
      </header>
      <div
        ref={setScrollElement}
        data-testid="wiki-scroll"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto"
      >
        {entries === undefined && error !== null ? (
          <p role="alert" className="py-8 pl-12 pr-7 text-sm text-text-muted">
            Couldn’t list the wiki: {errorMessage(error)}
          </p>
        ) : null}
        {isEmpty ? (
          <p className="py-8 pl-12 pr-7 text-sm text-text-muted">
            No wiki entries yet. Notes in {source.folder}/ appear here.
          </p>
        ) : null}
        {nothingMatches ? (
          <p className="py-8 pl-12 pr-7 text-sm text-text-muted">No entries match this filter.</p>
        ) : null}
        {layout !== undefined && !isEmpty && !nothingMatches ? (
          <WikiTable
            layout={layout}
            folded={folded}
            onToggleFold={handleToggleFold}
            onToggleExpanded={handleToggleExpanded}
            sort={sort}
            onSort={handleSort}
            language={translation}
            rowIndex={rowIndex}
            isSelected={selection.isSelected}
            onSelect={selection.clickSelect}
            onOpen={openEntry}
          />
        ) : null}
      </div>
    </div>
  )
}
