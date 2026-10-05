import type { ReactElement } from 'react'
import { activityDaySummary } from '@/lib/activity-day-summary.ts'
import { formatCompactDate } from '@/lib/dates.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { ActivityEditedTitles } from './activity-edited-titles.tsx'

export interface ActivityDayTooltipProps {
  /** The hovered or focused day (ISO `YYYY-MM-DD`). */
  date: string
  today: string
  /** Characters per journaled day. */
  characters: ReadonlyMap<string, number>
  /** Notes touched per day, as the edit-day filter lists them. */
  editCounts: ReadonlyMap<string, number>
}

/** A heatmap day's tooltip body: date · notes · chars, then what was edited. */
export function ActivityDayTooltip({
  date,
  today,
  characters,
  editCounts,
}: ActivityDayTooltipProps): ReactElement {
  const { settings } = useSettings()
  return (
    <>
      <div>
        {formatCompactDate(date, today, settings.dateFormat)} ·{' '}
        {activityDaySummary(editCounts.get(date), characters.get(date))}
      </div>
      {editCounts.has(date) ? <ActivityEditedTitles date={date} /> : null}
    </>
  )
}
