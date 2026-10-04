import type { ReactElement } from 'react'
import { isModEvent } from '@meowdown/core'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useOnThisDay } from '@/hooks/use-on-this-day.ts'
import { formatDayLabel } from '@/lib/dates.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { routeForPath } from '@/routing/route.ts'
import { SidebarSection } from './sidebar-section.tsx'

interface OnThisDaySectionProps {
  /** The day whose calendar date to look back on — a validated ISO date. */
  date: string
}

/** "1 year ago", "3 years ago". */
function yearsAgoLabel(yearsAgo: number): string {
  return yearsAgo === 1 ? '1 year ago' : `${yearsAgo} years ago`
}

/**
 * Daily-sidebar section listing this day's entries from earlier years; a row
 * opens that day. Renders nothing when there are none.
 */
export function OnThisDaySection({ date }: OnThisDaySectionProps): ReactElement | null {
  const { settings } = useSettings()
  const navigateNoteLink = useNoteLinkNavigation(date)
  const entries = useOnThisDay(date)
  if (entries.length === 0) {
    return null
  }

  return (
    <SidebarSection storageKey="on-this-day" title="On this day">
      <ul className="space-y-1">
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              title={formatDayLabel(entry.dailyDate, settings.dateFormat)}
              onClick={(event) =>
                navigateNoteLink({
                  target: routeForPath(entry.path),
                  openInNewWindow: isModEvent(event),
                })
              }
              className="flex w-full flex-col gap-0.5 rounded-md px-3 py-1 text-left leading-5 text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              <span className="text-xs">
                <span className="font-medium tabular-nums">{entry.dailyDate.slice(0, 4)}</span>
                <span className="text-text-muted"> · {yearsAgoLabel(entry.yearsAgo)}</span>
              </span>
              {entry.preview === '' ? null : (
                <span className="truncate text-xs text-text-muted">{entry.preview}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </SidebarSection>
  )
}
