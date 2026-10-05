import { sql } from 'kysely'
import { isNotNullish } from '@ocavue/utils'
import { z } from 'zod'
import { db } from './db.ts'

/** How much was written in one day's daily note. */
export interface DailyActivity {
  /** ISO `YYYY-MM-DD`. */
  date: string
  /** Characters of the note's display text (`notes.body_chars`). */
  characters: number
}

/**
 * Every daily note with content and its size, oldest first. Characters, not
 * words, so CJK writing counts fairly. Private dailies are included: this is a
 * local-only surface.
 */
export async function listDailyActivity(): Promise<DailyActivity[]> {
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

/** How many notes one local day touched. */
export interface DailyEditCount {
  /** ISO `YYYY-MM-DD`, local. */
  date: string
  /** Notes last edited that day, plus that day's daily note (as All Notes' edit-day filter lists them). */
  notes: number
}

/** A raw `listDailyEditCounts` row, as the SQL names its columns. */
const dailyEditCountRowSchema = z.object({
  date: z.string(),
  notes: z.number().int().nonnegative(),
})

/**
 * Per-day note counts matching All Notes' edit-day filter: each note counts on
 * the local day of its last edit, and a daily note also on its own date. The
 * union drops the double count when the two coincide.
 */
export async function listDailyEditCounts(): Promise<DailyEditCount[]> {
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
