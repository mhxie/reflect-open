import { useCallback, type MouseEvent, type ReactElement } from 'react'
import { BadgeCheck, BookOpen, Link, ListOrdered } from 'lucide-react'
import {
  wikiTopicKey,
  type WikiEntry,
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

/** What the table lays out: topic sections, or every entry in one list. */
export type WikiTableLayout =
  | { readonly kind: 'grouped'; readonly groups: readonly WikiTopicGroup[] }
  | { readonly kind: 'flat'; readonly entries: readonly WikiEntry[] }

interface WikiTableProps {
  /** The entries as listed in the open language (see `wikiEntryIn`). */
  layout: WikiTableLayout
  /** Keys (`wikiTopicKey`) of the folded topic sections. */
  folded: ReadonlySet<string>
  /** Fold or unfold one topic, or — `all` — every topic to that topic's new state. */
  onToggleFold: (key: string, all: boolean) => void
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
 * then the wiki's own as icons — over one flat list or foldable topic
 * sections (the wiki root's entries under "Overview").
 */
export function WikiTable({
  layout,
  folded,
  onToggleFold,
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
  const row = (entry: WikiEntry): ReactElement => (
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
      />
    </li>
  )

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
      {layout.kind === 'flat' ? (
        <ul aria-label="Entries">{layout.entries.map(row)}</ul>
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
              {isFolded ? null : <ul>{group.entries.map(row)}</ul>}
            </section>
          )
        })
      )}
    </>
  )
}
