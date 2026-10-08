import { memo, type MouseEvent, type ReactElement } from 'react'
import type { NoteListEntry } from '@reflect/core'
import { Pin } from 'lucide-react'
import { formatRecencyLabel } from '@/lib/dates.ts'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { NoteStateIndicator } from '@/components/note-state-indicator.tsx'
import { KnowledgeLevelLabel } from '@/components/knowledge-level-label.tsx'
import { NoteTitle } from '@/components/note-title.tsx'
import { ListRow } from './list-row.tsx'
import { ListRowSubject } from './list-row-subject.tsx'

/**
 * The shared column template (Subject · Level · Snippet · Tags · Updated) — the header
 * row in {@link AllNotesTable} uses the same classes so the columns line up.
 * The selection indicator is positioned beside the row, outside the column flow.
 */
export const ALL_NOTES_GRID =
  'grid grid-cols-[minmax(0,15rem)_3rem_minmax(0,1fr)_minmax(0,8rem)_6rem] items-center gap-4 pl-12 pr-7'

interface AllNotesRowProps {
  note: NoteListEntry
  /** Whether this row is part of the current multi-selection. */
  selected: boolean
  /** Body click: select, honoring ⌘/Ctrl (toggle) and Shift (range) modifiers. */
  onSelect: (path: string, event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void
  /** Indicator click: toggle this row (Shift extends a range) — V1's check gutter. */
  onToggle: (path: string, event: Pick<MouseEvent, 'shiftKey'>) => void
  /** Open the note (subject click / double-click). */
  onOpen: (path: string, event?: ModClickEvent) => void
}

/**
 * One note in the All Notes table: subject, snippet, tags, and when it was
 * last edited. A pinned note, which sorts ahead of the rest, is marked and
 * tinted so the pinned block doesn't read as out of order.
 */
export const AllNotesRow = memo(function AllNotesRow({
  note,
  selected,
  onSelect,
  onToggle,
  onOpen,
}: AllNotesRowProps): ReactElement {
  const { settings } = useSettings()
  return (
    <ListRow
      path={note.path}
      grid={ALL_NOTES_GRID}
      noun="note"
      selected={selected}
      onSelect={onSelect}
      onToggle={onToggle}
      onOpen={onOpen}
      className={note.isPinned && !selected ? 'bg-accent-soft/30' : undefined}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {note.isPinned ? (
          <span role="img" aria-label="Pinned" className="flex flex-none text-accent">
            <Pin aria-hidden className="size-3.5" />
          </span>
        ) : null}
        <ListRowSubject
          path={note.path}
          onOpen={onOpen}
          className={cn(
            'flex min-w-0 items-center gap-1.5',
            selected ? 'text-accent' : 'text-text',
          )}
        >
          <NoteTitle title={note.title} displayTitle={note.displayTitle} lang={note.lang} />
          <NoteStateIndicator
            path={note.path}
            isPrivate={note.isPrivate}
            hasConflict={note.hasConflict}
          />
        </ListRowSubject>
      </div>
      <span className="min-w-0" aria-label="Knowledge level">
        <KnowledgeLevelLabel path={note.path} compact />
      </span>
      <span
        className={cn('truncate text-[13px]', selected ? 'text-accent' : 'text-text-secondary')}
      >
        {note.snippet}
      </span>
      <span className="truncate text-right text-[13px] text-text-secondary">
        {note.tags.map((tag) => `#${tag}`).join(' ')}
      </span>
      <span className="whitespace-nowrap text-right text-[13px] tabular-nums text-text-secondary">
        {note.mtime > 0 ? formatRecencyLabel(note.mtime, settings) : '—'}
      </span>
    </ListRow>
  )
})
