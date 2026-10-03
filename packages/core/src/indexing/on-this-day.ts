import { db } from './db.ts'

/** One earlier year's daily note shown under "On this day". */
export interface OnThisDayEntry {
  path: string
  /** The entry's day (ISO `YYYY-MM-DD`). */
  dailyDate: string
  /** The indexed row preview (`buildIndexedNote`; may be empty). */
  preview: string
  /** Whole years between the entry and the day it is shown on (≥ 1). */
  yearsAgo: number
}

/**
 * Daily notes with content from `date`'s month and day in earlier years,
 * newest first. Later years never show. Matching is exact, so a February 29
 * entry returns only on later leap days.
 */
export async function listOnThisDay(date: string): Promise<OnThisDayEntry[]> {
  const year = date.slice(0, 4)
  const rows = await db
    .selectFrom('notes')
    .where('kind', '=', 'daily')
    .where('hasContent', '=', 1)
    // Dates compare as text, so the cutoff keeps the four-digit year as written.
    .where('dailyDate', '<', `${year}-01-01`)
    .where('dailyDate', 'like', `____-${date.slice(5)}`)
    .select(['path', 'dailyDate', 'preview'])
    .orderBy('dailyDate', 'desc')
    .execute()
  return rows.flatMap((row) =>
    row.dailyDate === null
      ? []
      : [
          {
            path: row.path,
            dailyDate: row.dailyDate,
            preview: row.preview,
            yearsAgo: Number(year) - Number(row.dailyDate.slice(0, 4)),
          },
        ],
  )
}
