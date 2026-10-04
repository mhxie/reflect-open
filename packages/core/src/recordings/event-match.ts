import type { CalendarEvent } from '../calendar/commands.ts'
import { displayEvents } from '../calendar/events.ts'

/**
 * How long before an event a recording may start and still belong to it:
 * people join and start recording a few minutes early.
 */
export const MEETING_EVENT_LEAD_MS = 10 * 60 * 1000

interface RankedEvent {
  readonly event: CalendarEvent
  /** Milliseconds the recording shares with the event itself. */
  readonly overlapMs: number
  /** Distance between the event's start and the recording's start. */
  readonly startDistanceMs: number
}

function compareRankedEvents(first: RankedEvent, second: RankedEvent): number {
  return (
    second.overlapMs - first.overlapMs ||
    first.startDistanceMs - second.startDistanceMs ||
    first.event.title.localeCompare(second.event.title)
  )
}

/**
 * The calendar event a recording most likely captured, or `null`. Only
 * displayable events count (see {@link displayEvents}). An event is a
 * candidate when the recording overlaps it or the
 * {@link MEETING_EVENT_LEAD_MS} before it; the candidate sharing the most
 * time with the recording wins, then the one starting closest to the
 * recording's start, then the first title alphabetically. An `endedAtMs`
 * before `startedAtMs` is read as a recording still at its start.
 */
export function pickMeetingEvent(
  events: readonly CalendarEvent[],
  startedAtMs: number,
  endedAtMs: number,
): CalendarEvent | null {
  const recordingEndMs = Math.max(endedAtMs, startedAtMs)
  const ranked: RankedEvent[] = []
  for (const event of displayEvents([...events])) {
    // Inclusive at the lead edge so a zero-length recording still matches;
    // exclusive at the event's end so a finished event never claims a
    // recording that starts as it ends.
    const windowStartMs = event.startsAt - MEETING_EVENT_LEAD_MS
    if (windowStartMs > recordingEndMs || event.endsAt <= startedAtMs) {
      continue
    }
    ranked.push({
      event,
      overlapMs: Math.max(
        0,
        Math.min(event.endsAt, recordingEndMs) - Math.max(event.startsAt, startedAtMs),
      ),
      startDistanceMs: Math.abs(event.startsAt - startedAtMs),
    })
  }
  return ranked.sort(compareRankedEvents)[0]?.event ?? null
}
