import type { ParsedNote } from './model.ts'

/**
 * Characters a note's reader sees: its display text in code points (as SQLite
 * `length` counts), without Markdown syntax. The one definition behind the
 * index's `body_chars` and the editor's live count, so the two always agree.
 */
export function countDisplayChars(parsed: Pick<ParsedNote, 'displayText'>): number {
  return Array.from(parsed.displayText).length
}
