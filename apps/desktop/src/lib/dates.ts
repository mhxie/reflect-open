import { format, isSameDay, isSameWeek } from 'date-fns'
import {
  formatDayLabel,
  formatMonthDay,
  formatShortDate,
  parseIsoDate,
  todayIso,
  type DateFormat,
  type TimeFormat,
} from '@reflect/core'

/**
 * The app's date layer (Plan 06). Daily notes are keyed by **local** calendar
 * dates as ISO `YYYY-MM-DD` strings — "today" follows the user's clock. Pure
 * calendar arithmetic (`addDaysIso`, `isIsoDate`) lives in `@reflect/utils` and
 * the local clock helpers (`todayIso`, `parseIsoDate`) live in `@reflect/core`;
 * both are re-exported here. This module owns the date-fns-backed *display*
 * formatting. Nothing else in the app may compute dates by hand.
 */

// Pure calendar math is shared with the indexing layer — one implementation.
export { addDaysIso, isIsoDate } from '@reflect/utils'
export { parseIsoDate, todayIso }
// The ISO-date labels are shared with the core services that build menu rows.
export { formatDayLabel, formatMonthDay, formatShortDate }

const ISO_DATE_FORMAT = 'yyyy-MM-dd'

/**
 * The shortest unambiguous date label: `10/2` for `mdy`, `2/10` for `dmy`,
 * `10-02` for `iso`, with the year added when `date` falls outside `today`'s.
 */
export function formatCompactDate(date: string, today: string, dateFormat: DateFormat): string {
  const sameYear = date.slice(0, 4) === today.slice(0, 4)
  switch (dateFormat) {
    case 'dmy':
      return format(parseIsoDate(date), sameYear ? 'd/M' : 'd/M/yy')
    case 'iso':
      return sameYear ? date.slice(5) : date
    case 'mdy':
      return format(parseIsoDate(date), sameYear ? 'M/d' : 'M/d/yy')
  }
}

/**
 * A date label per the date-format setting: `June 10th, 2026` for `mdy`,
 * `10th June, 2026` for `dmy`, and `2026-06-10` for `iso` (the forms the
 * settings screen shows as the options themselves).
 */
export function formatFullDate(date: Date, dateFormat: DateFormat): string {
  switch (dateFormat) {
    case 'dmy':
      return format(date, 'do MMMM, yyyy')
    case 'iso':
      return format(date, ISO_DATE_FORMAT)
    case 'mdy':
      return format(date, 'MMMM do, yyyy')
  }
}

/**
 * A time of day per the user's time-format setting: `8:22pm` for `12h`,
 * `20:22` for `24h`. Every time the app displays goes through this.
 */
export function formatTimeOfDay(date: Date, timeFormat: TimeFormat): string {
  return format(date, timeFormat === '24h' ? 'HH:mm' : 'h:mmaaa')
}

/**
 * The display-format preferences the date/time formatters need — a structural
 * subset of the settings document, so call sites can pass `settings` whole.
 */
export interface DateTimePrefs {
  timeFormat: TimeFormat
  dateFormat: DateFormat
}

/**
 * The status bar's last-edit label: `just now` and `N min ago` within the
 * hour, then {@link formatRecencyLabel}'s form (the All Notes Updated column).
 */
export function formatEditedLabel(epochMs: number, prefs: DateTimePrefs, now: Date): string {
  const minutes = Math.floor((now.getTime() - epochMs) / 60_000)
  if (minutes < 1) {
    return 'Edited just now'
  }
  if (minutes < 60) {
    return `Edited ${minutes} min ago`
  }
  return `Edited ${formatRecencyLabel(epochMs, prefs, now)}`
}

/**
 * Compact recency label for list rows (the original app's Updated column):
 * the time for today (per `timeFormat`), the weekday within the current week
 * (`Mon`), the short date otherwise (`6/3/2026`, `3/6/2026`, or
 * `2026-06-03`). `now` is injectable for tests.
 */
export function formatRecencyLabel(
  epochMs: number,
  prefs: DateTimePrefs,
  now: Date = new Date(),
): string {
  const date = new Date(epochMs)
  if (isSameDay(date, now)) {
    return formatTimeOfDay(date, prefs.timeFormat)
  }
  if (isSameWeek(date, now)) {
    return format(date, 'EEE')
  }
  switch (prefs.dateFormat) {
    case 'dmy':
      return format(date, 'd/M/yyyy')
    case 'iso':
      return format(date, ISO_DATE_FORMAT)
    case 'mdy':
      return format(date, 'M/d/yyyy')
  }
}

/**
 * {@link formatRecencyLabel} for a calendar day (ISO `YYYY-MM-DD`) rather than
 * an instant: `Today` where that shows the time, then the weekday within the
 * current week, the short date otherwise. `now` is injectable for tests.
 */
export function formatDayRecencyLabel(
  date: string,
  prefs: Pick<DateTimePrefs, 'dateFormat'>,
  now: Date = new Date(),
): string {
  const day = parseIsoDate(date)
  if (isSameDay(day, now)) {
    return 'Today'
  }
  if (isSameWeek(day, now)) {
    return format(day, 'EEE')
  }
  return formatShortDate(date, prefs.dateFormat)
}
