import { isNotNullish } from '@ocavue/utils'
import { sql } from 'kysely'
import { z } from 'zod'
import type { DatabaseService } from './database-service.ts'

/**
 * How much was written in one day's daily note.
 */
export interface DailyActivity {
  /**
   * ISO `YYYY-MM-DD`.
   */
  date: string
  /**
   * Characters of the note's display text (`notes.body_chars`).
   */
  characters: number
}

/**
 * How many notes one local day touched.
 */
export interface DailyEditCount {
  /**
   * ISO `YYYY-MM-DD`, local.
   */
  date: string
  /**
   * Notes last edited that day, plus that day's daily note (as All Notes'
   * edit-day filter lists them).
   */
  notes: number
}

/**
 * One earlier year's daily note shown under "On this day".
 */
export interface OnThisDayEntry {
  path: string
  /**
   * The entry's day (ISO `YYYY-MM-DD`).
   */
  dailyDate: string
  /**
   * The indexed row preview (`buildIndexedNote`; may be empty).
   */
  preview: string
  /**
   * Whole years between the entry and the day it is shown on (≥ 1).
   */
  yearsAgo: number
}

/**
 * A raw `listDailyEditCounts` row, as the SQL names its columns.
 */
const dailyEditCountRowSchema = z.object({
  date: z.string(),
  notes: z.number().int().nonnegative(),
})

export interface DailyActivityServiceDeps {
  readonly database: DatabaseService
}

/**
 * The daily workspace's history reads: the writing-activity heatmap and the
 * "On this day" entries from earlier years. Both are local-only surfaces, so
 * private notes count like any other.
 */
export interface DailyActivityService {
  /**
   * Every daily note with content and its size, oldest first. Characters, not
   * words, so CJK writing counts fairly. Private dailies are included: this is
   * a local-only surface.
   */
  listDailyActivity(): Promise<DailyActivity[]>
  /**
   * Per-day note counts matching All Notes' edit-day filter: each note counts
   * on the local day of its last edit, and a daily note also on its own date.
   * The union drops the double count when the two coincide.
   */
  listDailyEditCounts(): Promise<DailyEditCount[]>
  /**
   * Daily notes with content from `date`'s month and day in earlier years,
   * newest first. Later years never show. Matching is exact, so a February 29
   * entry returns only on later leap days.
   */
  listOnThisDay(date: string): Promise<OnThisDayEntry[]>
}

class DailyActivityServiceImpl implements DailyActivityService {
  readonly #deps: DailyActivityServiceDeps

  constructor(deps: DailyActivityServiceDeps) {
    this.#deps = deps
  }

  async listDailyActivity(): Promise<DailyActivity[]> {
    const { db } = this.#deps.database
    const rows = await db
      .selectFrom('notes')
      .where('kind', '=', 'daily')
      .where('hasContent', '=', 1)
      .select(['dailyDate', 'bodyChars as characters'])
      .orderBy('dailyDate')
      .execute()
    return rows
      .map((row) =>
        row.dailyDate === null ? null : { date: row.dailyDate, characters: row.characters },
      )
      .filter(isNotNullish)
  }

  async listDailyEditCounts(): Promise<DailyEditCount[]> {
    const { db } = this.#deps.database
    // Raw SQL bypasses Kysely's typing, so the rows are parsed at the boundary.
    const { rows } = await sql<unknown>`
      select day as date, count(*) as notes from (
        select path, date(mtime / 1000, 'unixepoch', 'localtime') as day
          from notes where kind in ('note', 'daily')
        union
        select path, daily_date as day from notes where kind = 'daily' and daily_date is not null
      )
      group by day
      order by day
    `.execute(db)
    return z.array(dailyEditCountRowSchema).parse(rows)
  }

  async listOnThisDay(date: string): Promise<OnThisDayEntry[]> {
    const { db } = this.#deps.database
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
    return rows
      .map((row) =>
        row.dailyDate === null
          ? null
          : {
              path: row.path,
              dailyDate: row.dailyDate,
              preview: row.preview,
              yearsAgo: Number(year) - Number(row.dailyDate.slice(0, 4)),
            },
      )
      .filter(isNotNullish)
  }
}

export function createDailyActivityService(deps: DailyActivityServiceDeps): DailyActivityService {
  return new DailyActivityServiceImpl(deps)
}
