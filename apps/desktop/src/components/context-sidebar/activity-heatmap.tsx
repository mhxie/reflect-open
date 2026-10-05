import { memo, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import { format } from 'date-fns'
import {
  activityLevel,
  monthLabelColumns,
  type ActivityLevel,
  type ActivityThresholds,
} from '@reflect/core'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  createTooltipHandle,
} from '@/components/ui/tooltip.tsx'
import { activityDaySummary } from '@/lib/activity-day-summary.ts'
import { formatDayLabel, parseIsoDate } from '@/lib/dates.ts'
import {
  HEATMAP_CELL,
  HEATMAP_GAP,
  HEATMAP_LABEL_WIDTH,
  nextHeatmapIndex,
} from '@/lib/heatmap-grid.ts'
import { cn } from '@/lib/utils.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useRouter } from '@/routing/router.tsx'
import { ActivityDayTooltip } from './activity-day-tooltip.tsx'

export interface ActivityHeatmapProps {
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

/**
 * GitHub-style heatmap of daily-note size; a day opens All Notes filtered to
 * that day's edits, and hovering or focusing it shows one compact tooltip
 * (date · notes · chars), shared by every day. One tab stop: arrows, Home and
 * End move between days. Memoized so a sidebar resize re-renders only when
 * the week count changes.
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
  // One tooltip for the whole grid; each day's cell is a trigger carrying its date.
  const [tooltip] = useState(() => createTooltipHandle<string>())

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
    <div className="w-fit">
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
                <TooltipTrigger
                  key={date}
                  handle={tooltip}
                  payload={date}
                  delay={0}
                  disabled={date > today}
                  render={
                    <button
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
                      aria-label={`${formatDayLabel(date, settings.dateFormat)} · ${activityDaySummary(editCounts.get(date), size)}`}
                      data-date={date}
                      onFocus={() => setFocused(date)}
                      onClick={() =>
                        navigate({ kind: 'allNotes', filter: { kind: 'updated', date } })
                      }
                      className={cn(
                        'rounded-[2px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-text',
                        date > today ? 'invisible' : LEVEL_CLASSES[activityLevel(size, thresholds)],
                      )}
                    />
                  }
                />
              )
            })}
          </div>
        ))}
      </div>
      {/* Passive: it floats over neighbouring days, which stay hoverable and clickable. */}
      <Tooltip handle={tooltip} disableHoverablePopup>
        {({ payload }) =>
          payload === undefined ? null : (
            <TooltipContent
              side="top"
              sideOffset={4}
              collisionPadding={4}
              className="pointer-events-none max-w-56 flex-col items-start gap-0 bg-surface-inverse px-1.5 py-0.5 text-2xs whitespace-nowrap text-text-on-inverse shadow-sm ring-0"
            >
              <ActivityDayTooltip
                date={payload}
                today={today}
                characters={characters}
                editCounts={editCounts}
              />
            </TooltipContent>
          )
        }
      </Tooltip>
    </div>
  )
})
