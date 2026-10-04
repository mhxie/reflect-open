import { describe, expect, it } from 'vitest'
import type { CalendarAttendee, CalendarEvent } from '../calendar/commands.ts'
import { MEETING_EVENT_LEAD_MS, pickMeetingEvent } from './event-match.ts'

const MINUTE = 60_000
const NINE = 9 * 60 * MINUTE
const TEN = 10 * 60 * MINUTE

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    calendarId: 'cal-1',
    title: 'Standup',
    startsAt: NINE,
    endsAt: NINE + 30 * MINUTE,
    allDay: false,
    recurring: false,
    availability: 'busy',
    canceled: false,
    attendees: [],
    ...overrides,
  }
}

const declinedByMe: CalendarAttendee = {
  name: 'Me',
  email: null,
  isCurrentUser: true,
  isPerson: true,
  status: 'declined',
}

describe('pickMeetingEvent', () => {
  it('returns null without events', () => {
    expect(pickMeetingEvent([], NINE, NINE + MINUTE)).toBeNull()
  })

  it('picks the event a recording sits inside', () => {
    const standup = event()
    expect(pickMeetingEvent([standup], NINE + 5 * MINUTE, NINE + 20 * MINUTE)).toBe(standup)
  })

  it('accepts a recording that starts within the lead time', () => {
    const standup = event()
    expect(pickMeetingEvent([standup], NINE - 5 * MINUTE, NINE + 20 * MINUTE)).toBe(standup)
    expect(pickMeetingEvent([standup], NINE - MEETING_EVENT_LEAD_MS, NINE - 8 * MINUTE)).toBe(
      standup,
    )
    expect(
      pickMeetingEvent([standup], NINE - 15 * MINUTE, NINE - MEETING_EVENT_LEAD_MS - 1),
    ).toBeNull()
  })

  it('matches a zero-length recording by its start alone', () => {
    const standup = event()
    expect(pickMeetingEvent([standup], NINE + MINUTE, NINE + MINUTE)).toBe(standup)
    expect(pickMeetingEvent([standup], NINE + MINUTE, 0)).toBe(standup)
    expect(pickMeetingEvent([standup], standup.endsAt, standup.endsAt)).toBeNull()
  })

  it('ignores events that ended before the recording started', () => {
    expect(pickMeetingEvent([event()], TEN, TEN + 10 * MINUTE)).toBeNull()
  })

  it('prefers the event sharing the most time with the recording', () => {
    const standup = event({ id: 'standup' })
    const review = event({
      id: 'review',
      title: 'Design review',
      startsAt: NINE + 15 * MINUTE,
      endsAt: TEN,
    })
    expect(pickMeetingEvent([standup, review], NINE + 10 * MINUTE, NINE + 50 * MINUTE)).toBe(review)
    expect(pickMeetingEvent([standup, review], NINE, NINE + 20 * MINUTE)).toBe(standup)
  })

  it('breaks an overlap tie by the closer start, then by title', () => {
    const early = event({ id: 'early', title: 'Planning', startsAt: NINE - 30 * MINUTE })
    const onTime = event({ id: 'on-time', title: 'Sync', startsAt: NINE - 5 * MINUTE })
    // Both cover the whole recording, so the overlap ties.
    expect(pickMeetingEvent([early, onTime], NINE, NINE + 10 * MINUTE)).toBe(onTime)
    const alpha = event({ id: 'alpha', title: 'Alpha' })
    const beta = event({ id: 'beta', title: 'Beta' })
    expect(pickMeetingEvent([beta, alpha], NINE, NINE + 10 * MINUTE)).toBe(alpha)
  })

  it('ignores declined, all-day, and canceled events', () => {
    const events = [
      event({ id: 'declined', attendees: [declinedByMe] }),
      event({ id: 'all-day', allDay: true, startsAt: 0, endsAt: 24 * 60 * MINUTE }),
      event({ id: 'canceled', canceled: true }),
    ]
    expect(pickMeetingEvent(events, NINE, NINE + 10 * MINUTE)).toBeNull()
  })
})
