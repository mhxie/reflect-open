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
 * sidebar). Pinned at the top: the month calendar — itself the day-navigation
 * surface, with a jump-to-today button — then the note's actions and published
 * link. Pinned at the bottom: the graph-wide journaling activity. Between them
 * scroll the sections of open-ended length: the day's tasks and calendar
 * events, then the same day in earlier years and semantic neighbors. Tasks
 * always renders, so it opens the scrolling sections on every day; the
 * sections that come and go sit below it and never move it. A window too short
 * for the pinned parts and a few lines of sections scrolls the whole sidebar
 * instead. Inbound links live under the note itself (the incoming-backlinks
 * section), not here. Rendered in the AppShell's right region on daily routes
 * only.
 */
export function DailyContextSidebar({ date }: DailyContextSidebarProps): ReactElement {
  const today = useToday()

  return (
    <div className="flex h-full flex-col overflow-y-auto text-text">
      <div
        className={cn(
          // The calendar grid and the action buttons carry 8px of padding of
          // their own, so these half-size gaps leave the same 16px around the
          // note actions as around every section below.
          'flex-none space-y-2 border-b border-border pb-2',
          // The calendar's controls must clear the WindowDragRegion strip when
          // the macOS title bar is overlaid.
          hasMacosTitleBarOverlay ? 'pt-0' : 'pt-2',
        )}
      >
        <DayCalendar selectedDate={date} today={today} />
        <NoteActionsSection path={dailyPath(date)} />
        <PublishedUrlSection path={dailyPath(date)} />
      </div>
      <div className="min-h-24 flex-1 overflow-y-auto">
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
