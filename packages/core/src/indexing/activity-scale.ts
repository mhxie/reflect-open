import { addDaysIso, weekdayIso } from '@reflect/utils'
import { isNotNullish } from '@ocavue/utils'
import type { DailyActivity } from './daily-activity.ts'

/** A heatmap cell's intensity: 0 for no entry, 1–4 by size. */
export type ActivityLevel = 0 | 1 | 2 | 3 | 4

/** Ascending character cutoffs between levels 1/2, 2/3 and 3/4. */
export type ActivityThresholds = readonly [number, number, number]

/** Below this many distinct sizes quartiles are noise; scale against the largest instead. */
const MIN_QUANTILE_SAMPLES = 10

/** Columns this close to the next month label leave the first column unlabeled. */
const MIN_LABEL_GAP = 3

function quantile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0
}

/**
 * The intensity scale for `activity`: the user's own quartiles, so dense CJK
 * and sparse Latin writing both spread across all four levels.
 */
export function activityThresholds(activity: readonly DailyActivity[]): ActivityThresholds {
  // Distinct sizes, so a run of identical days can't collapse the quartiles.
  const sorted = [...new Set(activity.map((entry) => entry.characters))].sort(
    (left, right) => left - right,
  )
  if (sorted.length < MIN_QUANTILE_SAMPLES) {
    const max = sorted.at(-1) ?? 0
    return [max / 4, max / 2, (max * 3) / 4]
  }
  return [quantile(sorted, 0.25), quantile(sorted, 0.5), quantile(sorted, 0.75)]
}

/** The level of a day with `characters` written; `undefined` means no entry. */
export function activityLevel(
  characters: number | undefined,
  thresholds: ActivityThresholds,
): ActivityLevel {
  if (characters === undefined) {
    return 0
  }
  if (characters <= thresholds[0]) {
    return 1
  }
  if (characters <= thresholds[1]) {
    return 2
  }
  return characters <= thresholds[2] ? 3 : 4
}

/**
 * The heatmap's columns: `weeksBefore` full weeks, then the week holding
 * `today`, each as seven ISO dates starting on `weekStartsOn` (`getDay()`
 * numbering). Dates after `today` are included; callers leave them blank.
 */
export function heatmapWeeks(today: string, weeksBefore: number, weekStartsOn: number): string[][] {
  const currentWeekStart = addDaysIso(today, -((weekdayIso(today) - weekStartsOn + 7) % 7))
  return Array.from({ length: weeksBefore + 1 }, (_, column) => {
    const start = addDaysIso(currentWeekStart, (column - weeksBefore) * 7)
    return Array.from({ length: 7 }, (_, row) => addDaysIso(start, row))
  })
}

/**
 * The columns that start a month on the time axis. The first column is
 * labeled only when the next label is far enough away not to collide.
 */
export function monthLabelColumns(weeks: readonly (readonly string[])[]): number[] {
  const starts = weeks
    .map((week, column) =>
      column > 0 && week[0]?.slice(0, 7) !== weeks[column - 1]?.[0]?.slice(0, 7) ? column : null,
    )
    .filter(isNotNullish)
  const next = starts[0]
  return next === undefined || next >= MIN_LABEL_GAP ? [0, ...starts] : starts
}
