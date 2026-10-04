import { useCallback, useEffect, useRef, type MouseEvent, type ReactElement } from 'react'
import { Virtualizer, type VirtualizerHandle } from 'virtua'
import type { DateFormat, NoteListEntry, NoteListSort, NoteListSortKey } from '@reflect/core'
import { formatShortDate } from '@/lib/dates.ts'
import type { ListSelection } from '@/lib/selection/use-list-selection.ts'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import type { AllNotesFilter } from '@/routing/route.ts'
import { ALL_NOTES_GRID, AllNotesRow } from './all-notes-row.tsx'
import { ATTACHMENT_FILTER_NOUNS } from './attachment-filter-labels.ts'
import { SortHeader } from './sort-header.tsx'

interface AllNotesTableProps {
  /** `undefined` while the index query settles (renders nothing, not "empty"). */
  notes: NoteListEntry[] | undefined
  /** The active filter, for the empty state's wording. */
  filter: AllNotesFilter | null
  /** The order `notes` arrive in, shown on the sortable column headers. */
  sort: NoteListSort
  /** Order the list by a column (a header click). */
  onSort: (key: NoteListSortKey) => void
  /** The shared row selection (click/keyboard); rows read their selected state from it. */
  selection: ListSelection
  onOpen: (path: string, event?: ModClickEvent) => void
  /**
   * Hand the screen a way to scroll a row index into view — a virtualized
   * off-screen row isn't in the DOM, so the keyboard nav can't `scrollIntoView`
   * it; only the virtualizer's own `scrollToIndex` reaches an unmounted row.
   */
  registerScrollToIndex: (scrollToIndex: (index: number) => void) => void
}

const ESTIMATED_ROW_HEIGHT = 48

/**
 * The All Notes table: a sticky header row over virtualized note rows. The
 * list is uncapped: virtualization keeps a many-thousand-note graph as cheap as
 * a ten-note one, so there is no silent "first N" truncation.
 *
 * Returns a fragment so the list virtualizes against the screen's scroll
 * container (its parent) directly. The header is a leading sibling; `bufferSize`
 * is wide enough to absorb its height so the windowed range never falls short.
 */
export function AllNotesTable({
  notes,
  filter,
  sort,
  onSort,
  selection,
  onOpen,
  registerScrollToIndex,
}: AllNotesTableProps): ReactElement | null {
  const { settings } = useSettings()
  const rows = notes ?? []
  const { clickSelect, isSelected } = selection
  const virtualizerRef = useRef<VirtualizerHandle>(null)
  const handleToggle = useCallback(
    (path: string, event: Pick<MouseEvent, 'shiftKey'>) =>
      clickSelect(
        path,
        event.shiftKey
          ? { metaKey: false, ctrlKey: false, shiftKey: true }
          : { metaKey: true, ctrlKey: true, shiftKey: false },
      ),
    [clickSelect],
  )

  useEffect(() => {
    registerScrollToIndex((index) => {
      if (index >= 0) {
        virtualizerRef.current?.scrollToIndex(index, { align: 'nearest' })
      }
    })
  }, [registerScrollToIndex])

  if (notes === undefined) {
    return null
  }
  return (
    <>
      <div
        className={cn(
          ALL_NOTES_GRID,
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
      </div>
      {notes.length === 0 ? (
        <p className="py-8 pl-12 pr-7 text-sm text-text-muted">
          {emptyListMessage(filter, settings.dateFormat)}
        </p>
      ) : (
        <Virtualizer
          ref={virtualizerRef}
          as="ul"
          item="li"
          data={rows}
          itemSize={ESTIMATED_ROW_HEIGHT}
          bufferSize={10 * ESTIMATED_ROW_HEIGHT}
        >
          {(note) => (
            <AllNotesRow
              key={note.path}
              note={note}
              selected={isSelected(note.path)}
              onSelect={clickSelect}
              onToggle={handleToggle}
              onOpen={onOpen}
            />
          )}
        </Virtualizer>
      )}
    </>
  )
}

/** What an empty list says under `filter`. */
function emptyListMessage(filter: AllNotesFilter | null, dateFormat: DateFormat): string {
  switch (filter?.kind) {
    case undefined:
      return 'No notes yet.'
    case 'tag':
      return `No notes tagged #${filter.tag}.`
    case 'attachment':
      return `No notes with ${ATTACHMENT_FILTER_NOUNS[filter.type]}.`
    case 'updated':
      return `No notes edited on ${formatShortDate(filter.date, dateFormat)}.`
  }
}
