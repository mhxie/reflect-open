import type { ReactElement } from 'react'
import { dailyPath } from '@reflect/core'
import { ActivitySection } from './activity-section.tsx'
import { DailyEventsSection } from './daily-events-section.tsx'
import { DayCalendar } from './day-calendar.tsx'
import { DayTasksSection } from './day-tasks-section.tsx'
import { NoteActionsSection } from './note-actions-section.tsx'
import { OnThisDaySection } from './on-this-day-section.tsx'
import { PublishedUrlSection } from './published-url-section.tsx'
import { SimilarNotesSection } from './similar-notes-section.tsx'
import { useToday } from '@/lib/use-today.ts'
import { cn } from '@/lib/utils.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

interface DailyContextSidebarProps {
  /** The day the sidebar describes — a validated ISO date from the route. */
  date: string
}

/**
 * The daily note's contextual sidebar. The month calendar (the day-navigation
 * surface), the note's actions and its published link stay pinned at the top
 * and the graph-wide activity at the bottom; the sections of open-ended length
 * scroll between them. Tasks always renders, so the sections that come and go
 * sit below it and never move it. Rendered in the AppShell's right region on
 * daily routes only.
 */
export function DailyContextSidebar({ date }: DailyContextSidebarProps): ReactElement {
  const today = useToday()
  const { platform } = useCoreServices()

  return (
    <div
      data-testid="daily-context-sidebar"
      className="flex h-full flex-col overflow-y-auto text-text"
    >
      <div
        className={cn(
          // Half-size gaps: the calendar grid and the action buttons pad
          // themselves by 8px, making up the 16px every section gets.
          'flex-none space-y-2 border-b border-border pb-2',
          // The calendar's controls must clear the WindowDragRegion strip when
          // the macOS title bar is overlaid.
          platform.hasMacosTitleBarOverlay ? 'pt-0' : 'pt-2',
        )}
      >
        <DayCalendar selectedDate={date} today={today} />
        <NoteActionsSection path={dailyPath(date)} />
        <PublishedUrlSection path={dailyPath(date)} />
      </div>
      {/* min-h-20: a few lines of sections; a shorter window scrolls the whole sidebar.
          Keyed by day, so another day's sections start at the top. */}
      <div key={date} className="min-h-20 flex-1 overflow-y-auto">
        <div className="space-y-4 py-4">
          <DayTasksSection date={date} />
          <DailyEventsSection date={date} />
          <OnThisDaySection date={date} />
          <SimilarNotesSection path={dailyPath(date)} />
        </div>
      </div>
      <ActivitySection />
    </div>
  )
}
