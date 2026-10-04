import { memo, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { format } from 'date-fns'
import {
  activityLevel,
  dateFromDailyPath,
  displayNoteTitle,
  monthLabelColumns,
  type ActivityLevel,
  type ActivityThresholds,
} from '@reflect/core'
import { useNotesEditedOn } from '@/hooks/use-notes-edited-on.ts'
import { formatCompactDate, formatDayLabel, formatShortDate, parseIsoDate } from '@/lib/dates.ts'
import {
  HEATMAP_CELL,
  HEATMAP_GAP,
  HEATMAP_LABEL_WIDTH,
  nextHeatmapIndex,
} from '@/lib/heatmap-grid.ts'
import { cn } from '@/lib/utils.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useRouter } from '@/routing/router.tsx'

interface ActivityHeatmapProps {
  /** Columns of seven ISO dates, oldest week first. */
  weeks: readonly (readonly string[])[]
  /** Characters per journaled day. */
  characters: ReadonlyMap<string, number>
  /** Notes touched per day, as the edit-day filter lists them. */
  editCounts: ReadonlyMap<string, number>
  thresholds: ActivityThresholds
  today: string
}

const LEVEL_CLASSES: Record<ActivityLevel, string> = {
  0: 'bg-surface-active',
  1: 'bg-accent/25',
  2: 'bg-accent/45',
  3: 'bg-accent/70',
  4: 'bg-accent',
}

/** Rows that carry a weekday label, GitHub-style: every other day. */
const LABELED_ROWS = new Set([1, 3, 5])

const LABEL_STYLE = { lineHeight: `${HEATMAP_CELL}px` }

const numberFormat = new Intl.NumberFormat()

/** The hovered or focused day, and where its tooltip anchors in the wrapper. */
interface Hover {
  date: string
  left: number
  top: number
  /** Anchor the tooltip's right edge instead, so it stays inside the sidebar. */
  alignRight: boolean
}

/** A day's summary parts: notes touched and characters written, each only when present. */
function daySummary(notes: number | undefined, characters: number | undefined): string {
  const parts = [
    notes === undefined ? null : `${numberFormat.format(notes)} ${notes === 1 ? 'note' : 'notes'}`,
    characters === undefined ? null : `${numberFormat.format(characters)} chars`,
  ].filter((part) => part !== null)
  return parts.length === 0 ? 'No notes' : parts.join(' · ')
}

/**
 * GitHub-style heatmap of daily-note size; a day opens All Notes filtered to
 * that day's edits, and hovering or focusing it shows one compact tooltip
 * (date · notes · chars). One tab stop: arrows, Home and End move between
 * days. Memoized so a sidebar resize re-renders only when the week count changes.
 */
export const ActivityHeatmap = memo(function ActivityHeatmap({
  weeks,
  characters,
  editCounts,
  thresholds,
  today,
}: ActivityHeatmapProps): ReactElement {
  const { settings } = useSettings()
  const { navigate } = useRouter()
  const labeledColumns = useMemo(() => new Set(monthLabelColumns(weeks)), [weeks])
  // Column-major day order, matching the arrow-key arithmetic in `nextHeatmapIndex`.
  const days = useMemo(() => weeks.flat(), [weeks])
  const lastPast = days.findLastIndex((date) => date <= today)
  const [focused, setFocused] = useState(today)
  // A focused day that scrolled out of the window falls back to today.
  const focusedIndex = days.indexOf(focused)
  const focusIndex = focusedIndex < 0 ? lastPast : Math.min(lastPast, focusedIndex)
  const cells = useRef(new Map<string, HTMLButtonElement>())
  const wrapper = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Hover | null>(null)

  const showTooltip = (date: string, cell: HTMLElement): void => {
    const half = (wrapper.current?.clientWidth ?? 0) / 2
    const alignRight = cell.offsetLeft > half
    setHover({
      date,
      left: alignRight ? cell.offsetLeft + cell.offsetWidth : cell.offsetLeft,
      top: cell.offsetTop,
      alignRight,
    })
  }

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = nextHeatmapIndex(event.key, focusIndex, lastPast)
    if (next === null) {
      return
    }
    event.preventDefault()
    const date = days[next]!
    setFocused(date)
    cells.current.get(date)?.focus()
  }

  return (
    <div ref={wrapper} className="relative w-fit" onPointerLeave={() => setHover(null)}>
      <div
        role="grid"
        aria-label="Daily note activity"
        onKeyDown={moveFocus}
        className="grid w-fit text-2xs text-text-muted"
        style={{
          gap: HEATMAP_GAP,
          gridTemplateColumns: `${HEATMAP_LABEL_WIDTH - HEATMAP_GAP}px repeat(${weeks.length}, ${HEATMAP_CELL}px)`,
          gridAutoRows: HEATMAP_CELL,
        }}
      >
        <div role="row" className="contents">
          <span role="columnheader" />
          {weeks.map((week, column) => (
            <span
              key={week[0]}
              role="columnheader"
              className="whitespace-nowrap"
              style={LABEL_STYLE}
            >
              {labeledColumns.has(column) ? format(parseIsoDate(week[0]!), 'MMM') : null}
            </span>
          ))}
        </div>
        {Array.from({ length: 7 }, (_, row) => (
          <div key={row} role="row" className="contents">
            <span role="rowheader" style={LABEL_STYLE}>
              {LABELED_ROWS.has(row) ? format(parseIsoDate(weeks[0]![row]!), 'EEE') : null}
            </span>
            {weeks.map((week) => {
              const date = week[row]!
              const size = characters.get(date)
              return (
                <button
                  key={date}
                  ref={(element) => {
                    if (element === null) {
                      cells.current.delete(date)
                    } else {
                      cells.current.set(date, element)
                    }
                  }}
                  type="button"
                  role="gridcell"
                  tabIndex={date === days[focusIndex] ? 0 : -1}
                  disabled={date > today}
                  aria-label={`${formatDayLabel(date, settings.dateFormat)} · ${daySummary(editCounts.get(date), size)}`}
                  data-date={date}
                  onPointerEnter={(event) => showTooltip(date, event.currentTarget)}
                  onFocus={(event) => {
                    setFocused(date)
                    showTooltip(date, event.currentTarget)
                  }}
                  onBlur={() => setHover(null)}
                  onClick={() => navigate({ kind: 'allNotes', filter: { kind: 'updated', date } })}
                  className={cn(
                    'rounded-[2px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-text',
                    date > today ? 'invisible' : LEVEL_CLASSES[activityLevel(size, thresholds)],
                  )}
                />
              )
            })}
          </div>
        ))}
      </div>
      {hover === null ? null : (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 max-w-56 -translate-y-full rounded-md bg-surface-inverse px-1.5 py-0.5 text-2xs whitespace-nowrap text-text-on-inverse shadow-sm"
          style={{
            top: hover.top - 4,
            ...(hover.alignRight
              ? { right: (wrapper.current?.clientWidth ?? 0) - hover.left }
              : { left: hover.left }),
          }}
        >
          <div>
            {formatCompactDate(hover.date, today, settings.dateFormat)} ·{' '}
            {daySummary(editCounts.get(hover.date), characters.get(hover.date))}
          </div>
          {editCounts.has(hover.date) ? <EditedTitles date={hover.date} /> : null}
        </div>
      )}
    </div>
  )
})

/** Titles shown in the day tooltip before "+N more". */
const TOOLTIP_TITLES = 3

/** The hovered day's most recently edited notes, as a preview of its All Notes list. */
function EditedTitles({ date }: { date: string }): ReactElement | null {
  const { settings } = useSettings()
  const notes = useNotesEditedOn(date)
  if (notes === undefined || notes.length === 0) {
    return null
  }
  const more = notes.length - TOOLTIP_TITLES
  return (
    <ul className="mt-0.5 border-t border-text-on-inverse/20 pt-0.5">
      {notes.slice(0, TOOLTIP_TITLES).map((note) => {
        const daily = dateFromDailyPath(note.path)
        return (
          <li key={note.path} className="truncate opacity-80">
            {daily !== null
              ? formatShortDate(daily, settings.dateFormat)
              : displayNoteTitle(note.title) || 'Untitled'}
          </li>
        )
      })}
      {more > 0 ? <li className="opacity-60">+{more} more</li> : null}
    </ul>
  )
}
