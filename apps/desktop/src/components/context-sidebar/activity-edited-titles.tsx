import type { ReactElement } from 'react'
import { dateFromDailyPath, displayNoteTitle } from '@reflect/core'
import { useNotesEditedOn } from '@/hooks/use-notes-edited-on.ts'
import { formatShortDate } from '@/lib/dates.ts'
import { useSettings } from '@/providers/settings-provider.tsx'

/** Titles shown in the day tooltip before "+N more". */
const TOOLTIP_TITLES = 3

export interface ActivityEditedTitlesProps {
  /** The hovered or focused day (ISO `YYYY-MM-DD`). */
  date: string
}

/** The day's most recently edited notes, as a preview of its All Notes list. */
export function ActivityEditedTitles({ date }: ActivityEditedTitlesProps): ReactElement | null {
  const { settings } = useSettings()
  const notes = useNotesEditedOn(date)
  if (notes === undefined || notes.length === 0) {
    return null
  }
  const more = notes.length - TOOLTIP_TITLES
  return (
    <ul className="mt-0.5 w-full border-t border-text-on-inverse/20 pt-0.5">
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
