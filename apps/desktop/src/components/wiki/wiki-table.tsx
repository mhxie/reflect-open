import { useCallback, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { BadgeCheck, BookOpen, Link, ListOrdered } from 'lucide-react'
import {
  wikiTopicKey,
  type WikiEntry,
  type WikiIndexNode,
  type WikiIndexRow,
  type WikiLanguage,
  type WikiSort,
  type WikiSortKey,
  type WikiTopicGroup,
} from '@reflect/core'
import { SortHeader } from '@/components/all-notes/sort-header.tsx'
import type { ListSelection } from '@/lib/selection/use-list-selection.ts'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { WIKI_GRID, WikiEntryRow } from './wiki-entry-row.tsx'
import { WIKI_SIGNALS_GRID } from './wiki-signals.tsx'
import { WikiTopicHeader } from './wiki-topic-header.tsx'

/**
 * What the table lays out: topic sections, every entry in one list, or the
 * index tree with its visible rows (what collapsing leaves showing).
 */
export type WikiTableLayout =
  | { readonly kind: 'grouped'; readonly groups: readonly WikiTopicGroup[] }
  | { readonly kind: 'flat'; readonly entries: readonly WikiEntry[] }
  | {
      readonly kind: 'tree'
      readonly nodes: readonly WikiIndexNode[]
      readonly rows: readonly WikiIndexRow[]
    }

interface WikiTableProps {
  /** The entries as listed in the open language (see `wikiEntryIn`). */
  layout: WikiTableLayout
  /** Keys (`wikiTopicKey`) of the folded topic sections. */
  folded: ReadonlySet<string>
  /** Fold or unfold one topic, or — `all` — every topic to that topic's new state. */
  onToggleFold: (key: string, all: boolean) => void
  /** Expand or collapse one index tree row, by its key. */
  onToggleExpanded: (key: string) => void
  sort: WikiSort
  onSort: (key: WikiSortKey) => void
  /** The translation the rows are read in, or null for the source language. */
  language: WikiLanguage | null
  /** Each visible entry's position in the flat render order. */
  rowIndex: ReadonlyMap<string, number>
  isSelected: ListSelection['isSelected']
  onSelect: ListSelection['clickSelect']
  onOpen: (path: string, event?: ModClickEvent) => void
}

const FEWEST_MOST = { asc: 'fewest first', desc: 'most first' } as const

/**
 * The Wiki screen's table — All Notes' sticky header of sortable columns,
 * then the wiki's own as icons — over one flat list, foldable topic
 * sections (the wiki root's entries under "Overview"), or the index tree.
 */
export function WikiTable({
  layout,
  folded,
  onToggleFold,
  onToggleExpanded,
  sort,
  onSort,
  language,
  rowIndex,
  isSelected,
  onSelect,
  onOpen,
}: WikiTableProps): ReactElement {
  const handleToggle = useCallback(
    (path: string, event: Pick<MouseEvent, 'shiftKey'>) =>
      onSelect(
        path,
        event.shiftKey
          ? { metaKey: false, ctrlKey: false, shiftKey: true }
          : { metaKey: true, ctrlKey: true, shiftKey: false },
      ),
    [onSelect],
  )
  const row = (entry: WikiEntry, treeRow?: WikiIndexRow, children?: ReactNode): ReactElement => (
    <li key={entry.path}>
      <WikiEntryRow
        entry={entry}
        index={rowIndex.get(entry.path) ?? -1}
        untranslated={
          language !== null && !entry.translations.has(language.folder) ? language.label : null
        }
        selected={isSelected(entry.path)}
        onSelect={onSelect}
        onToggle={handleToggle}
        onOpen={onOpen}
        treeRow={treeRow}
        onToggleExpanded={onToggleExpanded}
      />
      {children}
    </li>
  )
  // Children nest inside their parent's item, so assistive tech hears each level.
  const treeRows = new Map(
    layout.kind === 'tree' ? layout.rows.map((item) => [item.key, item]) : [],
  )
  const branch = (nodes: readonly WikiIndexNode[]): ReactElement[] =>
    nodes.flatMap((node) => {
      const treeRow = treeRows.get(node.key)
      if (treeRow === undefined) {
        return []
      }
      const children = treeRow.expanded ? <ul>{branch(node.children)}</ul> : null
      return [row(node.entry, treeRow, children)]
    })

  return (
    <>
      <div
        className={cn(
          WIKI_GRID,
          'sticky top-0 z-10 border-b border-border bg-surface py-3 text-[13px] font-medium leading-none text-text-secondary shadow-sm',
        )}
      >
        <SortHeader
          label="Subject"
          sortKey="title"
          sort={sort}
          onSort={onSort}
          directionLabels={{ asc: 'A to Z', desc: 'Z to A' }}
        />
        <span>Wiki</span>
        <span>Snippet</span>
        <span className="text-right">Tags</span>
        <SortHeader
          label="Updated"
          sortKey="updated"
          sort={sort}
          onSort={onSort}
          directionLabels={{ asc: 'oldest first', desc: 'newest first' }}
          alignEnd
        />
        <div className={WIKI_SIGNALS_GRID}>
          <SortHeader
            label="Review"
            sortKey="review"
            sort={sort}
            onSort={onSort}
            directionLabels={{ asc: 'needs attention first', desc: 'verified first' }}
            icon={BadgeCheck}
          />
          <SortHeader
            label="Claims"
            sortKey="claims"
            sort={sort}
            onSort={onSort}
            directionLabels={FEWEST_MOST}
            icon={ListOrdered}
          />
          <SortHeader
            label="Sources"
            sortKey="sources"
            sort={sort}
            onSort={onSort}
            directionLabels={FEWEST_MOST}
            icon={BookOpen}
          />
          <SortHeader
            label="Cited by"
            sortKey="citedBy"
            sort={sort}
            onSort={onSort}
            directionLabels={FEWEST_MOST}
            icon={Link}
          />
        </div>
      </div>
      {layout.kind === 'tree' ? (
        <ul aria-label="Indexes">{branch(layout.nodes)}</ul>
      ) : layout.kind === 'flat' ? (
        <ul aria-label="Entries">{layout.entries.map((entry) => row(entry))}</ul>
      ) : (
        layout.groups.map((group) => {
          const key = wikiTopicKey(group.topic)
          const label = group.topic ?? 'Overview'
          const isFolded = folded.has(key)
          return (
            <section key={key} aria-label={label}>
              <WikiTopicHeader
                label={label}
                count={group.entries.length}
                folded={isFolded}
                onToggle={(all) => onToggleFold(key, all)}
              />
              {isFolded ? null : <ul>{group.entries.map((entry) => row(entry))}</ul>}
            </section>
          )
        })
      )}
    </>
  )
}
