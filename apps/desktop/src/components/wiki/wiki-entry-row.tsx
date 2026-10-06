import { memo, type MouseEvent, type ReactElement } from 'react'
import { displayNoteTitle, isWikiGuide, type WikiEntry } from '@reflect/core'
import { Languages, Waypoints } from 'lucide-react'
import { ListRow } from '@/components/all-notes/list-row.tsx'
import { ListRowSubject } from '@/components/all-notes/list-row-subject.tsx'
import { NoteStateIndicator } from '@/components/note-state-indicator.tsx'
import { Badge } from '@/components/ui/badge.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { formatDayRecencyLabel, formatRecencyLabel } from '@/lib/dates.ts'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { WikiSignals } from './wiki-signals.tsx'

/**
 * The shared column template — All Notes' Subject · Snippet · Tags · Updated,
 * then the wiki's own columns ({@link WikiSignals}). The Wiki screen's header
 * row uses the same classes so the columns line up.
 */
export const WIKI_GRID =
  'grid grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,8rem)_6rem_auto] items-center gap-4 pl-12 pr-7'

interface WikiEntryRowProps {
  /** The entry as listed in the open language (see `wikiEntryIn`). */
  entry: WikiEntry
  /** Position in the flat render order; the keyboard nav scrolls rows by it. */
  index: number
  /** The open language's name when the entry has no copy in it, so the row shows its source. */
  untranslated: string | null
  selected: boolean
  onSelect: (path: string, event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void
  onToggle: (path: string, event: Pick<MouseEvent, 'shiftKey'>) => void
  onOpen: (path: string, event?: ModClickEvent) => void
}

/** What the snippet cell says for the copy a row shows. */
function snippetOf(entry: WikiEntry): string {
  switch (entry.state) {
    case 'local':
      return entry.preview ?? ''
    case 'evicted':
      return 'Not on this device'
    case 'unreadable':
      return 'Couldn’t read this file'
  }
}

/**
 * One wiki entry, laid out like an All Notes row: subject, the shown copy's
 * opening paragraph, tags, and when it was last updated — its newest
 * revision-log day, else its file's modification time — then the wiki's own
 * columns.
 */
export const WikiEntryRow = memo(function WikiEntryRow({
  entry,
  index,
  untranslated,
  selected,
  onSelect,
  onToggle,
  onOpen,
}: WikiEntryRowProps): ReactElement {
  const { settings } = useSettings()
  const isIndex = isWikiGuide(entry)
  let updated = '—'
  if (entry.revised !== null) {
    updated = formatDayRecencyLabel(entry.revised, settings)
  } else if (entry.mtime > 0) {
    updated = formatRecencyLabel(entry.mtime, settings)
  }

  return (
    <ListRow
      path={entry.path}
      grid={WIKI_GRID}
      className={isIndex && !selected ? 'bg-accent-soft/30' : undefined}
      index={index}
      noun="entry"
      selected={selected}
      onSelect={onSelect}
      onToggle={onToggle}
      onOpen={onOpen}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <ListRowSubject
          path={entry.path}
          onOpen={onOpen}
          className={cn(
            'flex min-w-0 items-center gap-1.5',
            selected ? 'text-accent' : untranslated === null ? 'text-text' : 'text-text-secondary',
          )}
        >
          {isIndex ? <Waypoints aria-hidden className="size-3.5 flex-none text-accent" /> : null}
          <span className="truncate">{displayNoteTitle(entry.title)}</span>
          <NoteStateIndicator
            path={entry.path}
            isPrivate={entry.isPrivate}
            hasConflict={entry.hasConflict}
          />
        </ListRowSubject>
        {isIndex ? (
          <Badge variant="secondary" className="h-4 rounded px-1.5 text-[10px]">
            Index
          </Badge>
        ) : null}
        {untranslated === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  role="img"
                  aria-label={`Not in ${untranslated} yet`}
                  className="flex flex-none text-text-muted"
                >
                  <Languages aria-hidden className="size-3" />
                </span>
              }
            />
            <TooltipContent>Not in {untranslated} yet</TooltipContent>
          </Tooltip>
        )}
      </div>
      <span
        className={cn(
          'truncate text-[13px]',
          selected
            ? 'text-accent'
            : untranslated === null && entry.state === 'local'
              ? 'text-text-secondary'
              : 'text-text-muted',
        )}
      >
        {snippetOf(entry)}
      </span>
      <span className="truncate text-right text-[13px] text-text-secondary">
        {entry.tags.map((tag) => `#${tag}`).join(' ')}
      </span>
      <span className="whitespace-nowrap text-right text-[13px] tabular-nums text-text-secondary">
        {updated}
      </span>
      <WikiSignals entry={entry} />
    </ListRow>
  )
})
