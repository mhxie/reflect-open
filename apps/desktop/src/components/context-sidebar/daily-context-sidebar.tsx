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
import { hasMacosTitleBarOverlay } from '@/lib/window-chrome.ts'

interface DailyContextSidebarProps {
  /** The day the sidebar describes — a validated ISO date from the route. */
  date: string
}

/**
 * The daily note's contextual sidebar (modeled on the old app's note context
 * sidebar): the month calendar up top — itself the day-navigation surface,
 * with a jump-to-today button — then sections ordered by scope: the day's
 * tasks and calendar events, the note's actions and published link, then the
 * same day in earlier years and semantic neighbors. Tasks always renders, so
 * it sits directly under the calendar on every day; the sections that come
 * and go sit below it and never move it. The calendar and sections scroll
 * together; the graph-wide journaling activity stays pinned to the bottom.
 * Inbound links live under the note itself (the incoming-backlinks section),
 * not here. Rendered in the AppShell's right region on daily routes only.
 */
export function DailyContextSidebar({ date }: DailyContextSidebarProps): ReactElement {
  const today = useToday()

  return (
    <div className="flex h-full flex-col text-text">
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          // The calendar's controls must clear the WindowDragRegion strip when
          // the macOS title bar is overlaid.
          hasMacosTitleBarOverlay ? 'pt-0' : 'pt-2',
        )}
      >
        <DayCalendar selectedDate={date} today={today} />
        <div className="my-4 space-y-4 pb-4">
          <DayTasksSection date={date} />
          <DailyEventsSection date={date} />
          <NoteActionsSection path={dailyPath(date)} />
          <PublishedUrlSection path={dailyPath(date)} />
          <OnThisDaySection date={date} />
          <SimilarNotesSection path={dailyPath(date)} />
        </div>
      </div>
      <ActivitySection />
    </div>
  )
}
