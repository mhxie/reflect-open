const numberFormat = new Intl.NumberFormat()

/**
 * A heatmap day's summary: notes touched and characters written, each only
 * when present ("3 notes · 1,200 chars"), or "No notes".
 */
export function activityDaySummary(
  notes: number | undefined,
  characters: number | undefined,
): string {
  const parts = [
    notes === undefined ? null : `${numberFormat.format(notes)} ${notes === 1 ? 'note' : 'notes'}`,
    characters === undefined ? null : `${numberFormat.format(characters)} chars`,
  ].filter((part) => part !== null)
  return parts.length === 0 ? 'No notes' : parts.join(' · ')
}
