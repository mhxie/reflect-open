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
  return rows.flatMap((row) =>
    row.dailyDate === null ? [] : [{ date: row.dailyDate, characters: row.characters }],
  )
}
