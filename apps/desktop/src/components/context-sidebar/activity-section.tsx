import { useMemo, type ReactElement } from 'react'
import { activityThresholds, heatmapWeeks, weekStartDow } from '@reflect/core'
import { useDailyActivity } from '@/hooks/use-daily-activity.ts'
import { useDailyEditCounts } from '@/hooks/use-daily-edit-counts.ts'
import { useElementWidth } from '@/hooks/use-element-width.ts'
import { weekColumnsFitting } from '@/lib/heatmap-grid.ts'
import { useToday } from '@/lib/use-today.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { ActivityHeatmap } from './activity-heatmap.tsx'
import { SidebarSection } from './sidebar-section.tsx'

/**
 * Daily-sidebar heatmap of daily notes, as many weeks as the width fits.
 * Hidden when off in settings or before the first daily note.
 */
export function ActivitySection(): ReactElement | null {
  const today = useToday()
  const { settings } = useSettings()
  const enabled = settings.activityHeatmapEnabled
  const activity = useDailyActivity(enabled)
  const editCounts = useDailyEditCounts(enabled)
  const [measure, width] = useElementWidth()
  const weekCount = weekColumnsFitting(width)
  const weekStartsOn = weekStartDow(settings.weekStartDay)
  const weeks = useMemo(
    () => heatmapWeeks(today, weekCount - 1, weekStartsOn),
    [today, weekCount, weekStartsOn],
  )
  const thresholds = useMemo(() => activityThresholds(activity ?? []), [activity])
  const characters = useMemo(
    () => new Map((activity ?? []).map((entry) => [entry.date, entry.characters])),
    [activity],
  )
  if (!enabled || activity === undefined || activity.length === 0) {
    return null
  }

  return (
    <SidebarSection storageKey="activity" title="Activity">
      <div ref={measure} className="px-1.5">
        <ActivityHeatmap
          weeks={weeks}
          characters={characters}
          editCounts={editCounts}
          thresholds={thresholds}
          today={today}
        />
      </div>
    </SidebarSection>
  )
}
