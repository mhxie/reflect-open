import { sql } from 'kysely'
import { db } from './db.ts'

/** How much was written in one day's daily note. */
export interface DailyActivity {
  /** ISO `YYYY-MM-DD`. */
  date: string
  /** Characters in the note's indexed body text. */
  characters: number
}

/**
 * Every daily note with content and its size, oldest first. Characters, not
 * words, so CJK writing counts fairly. Private dailies are included: this is a
 * local-only surface.
 */
export async function listDailyActivity(): Promise<DailyActivity[]> {
  const rows = await db
    .selectFrom('searchFts')
    .innerJoin('notes', 'notes.path', 'searchFts.path')
    .where('notes.kind', '=', 'daily')
    .where('notes.hasContent', '=', 1)
    .select(['notes.dailyDate', sql<number | null>`length(search_fts.body)`.as('characters')])
    .orderBy('notes.dailyDate')
    .execute()
  return rows.flatMap((row) =>
    row.dailyDate === null ? [] : [{ date: row.dailyDate, characters: row.characters ?? 0 }],
  )
}
