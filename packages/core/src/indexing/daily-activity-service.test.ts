import { createDb } from '@reflect/db'
import { describe, expect, it } from 'vitest'
import { createNodeTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createDailyActivityService } from './daily-activity-service.ts'
import type { DatabaseService } from './database-service.ts'

function setup(notes: TestNote[]) {
  const database = createNodeTestDatabaseService()
  seedNotes(database, notes)
  return { database, activity: createDailyActivityService({ database }) }
}

/**
 * A database whose every query answers `rows`, for rows the real index can't hold.
 */
function answering(rows: unknown[]): DatabaseService {
  const runQuery = (): Promise<unknown> => Promise.resolve(rows)
  return { db: createDb(runQuery), runQuery }
}

/**
 * Local epoch milliseconds of noon on `date`.
 */
function localNoon(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, month! - 1, day, 12).getTime()
}

describe('listDailyActivity', () => {
  it('sizes every daily note with content, oldest first', async () => {
    const { database, activity } = setup([
      { path: 'daily/2026-10-02.md', markdown: '---\nprivate: true\n---\nShort.\n' },
      { path: 'daily/2026-09-30.md', markdown: '推理 and more words.\n' },
      { path: 'daily/2026-10-01.md', markdown: '' },
      { path: 'notes/plain.md', markdown: '# Plain\nNot a daily.\n' },
    ])

    await expect(activity.listDailyActivity()).resolves.toEqual([
      { date: '2026-09-30', characters: '推理 and more words.'.length },
      // Private dailies count: this is a local-only surface.
      { date: '2026-10-02', characters: 'Short.'.length },
    ])
    const [query] = database.getQueries()
    expect(query?.sql).toContain('"body_chars" as "characters"')
    expect(query?.sql).not.toContain('search_fts')
    expect(query?.sql).toContain('has_content')
    expect(query?.params).toEqual(['daily', 1])
  })
})

describe('listDailyEditCounts', () => {
  it('counts notes per local edit day, a daily note also on its own date', async () => {
    const { database, activity } = setup([
      { path: 'notes/a.md', markdown: '# A\n', mtime: localNoon('2026-10-02') },
      { path: 'notes/b.md', markdown: '# B\n', mtime: localNoon('2026-10-02') },
      // Edited on its own day: counted once.
      { path: 'daily/2026-10-02.md', markdown: 'Today.\n', mtime: localNoon('2026-10-02') },
      // Edited two days later: counted on both days.
      { path: 'daily/2026-10-01.md', markdown: 'Yesterday.\n', mtime: localNoon('2026-10-03') },
      { path: 'templates/t.md', markdown: '# Template\n', mtime: localNoon('2026-10-02') },
    ])

    await expect(activity.listDailyEditCounts()).resolves.toEqual([
      { date: '2026-10-01', notes: 1 },
      { date: '2026-10-02', notes: 3 },
      { date: '2026-10-03', notes: 1 },
    ])
    const [query] = database.getQueries()
    expect(query?.sql).toContain("'localtime'")
    expect(query?.sql).toContain('union')
  })

  it('rejects an edit-count row that is not a date and a count', async () => {
    const activity = createDailyActivityService({
      database: answering([{ date: '2026-10-02', notes: 'three' }]),
    })

    await expect(activity.listDailyEditCounts()).rejects.toThrow()
  })
})

describe('listOnThisDay', () => {
  it('lists earlier years of the same day with content, newest first', async () => {
    const { database, activity } = setup([
      { path: 'daily/2023-10-03.md', markdown: 'three years ago\n' },
      { path: 'daily/2025-10-03.md', markdown: 'last year\n' },
      // No content, a later year, another day: none shows.
      { path: 'daily/2024-10-03.md', markdown: '' },
      { path: 'daily/2026-10-03.md', markdown: 'today\n' },
      { path: 'daily/2027-10-03.md', markdown: 'next year\n' },
      { path: 'daily/2025-10-04.md', markdown: 'another day\n' },
    ])

    const entries = await activity.listOnThisDay('2026-10-03')

    expect(entries).toEqual([
      { path: 'daily/2025-10-03.md', dailyDate: '2025-10-03', preview: 'last year', yearsAgo: 1 },
      {
        path: 'daily/2023-10-03.md',
        dailyDate: '2023-10-03',
        preview: 'three years ago',
        yearsAgo: 3,
      },
    ])
    const [query] = database.getQueries()
    expect(query?.sql).toContain('has_content')
    expect(query?.sql).toContain('like')
    expect(query?.sql).toContain('order by "daily_date" desc')
    expect(query?.params).toEqual(['daily', 1, '2026-01-01', '____-10-03'])
  })

  it('keeps a leading-zero year in the cutoff', async () => {
    const { database, activity } = setup([])

    await activity.listOnThisDay('0099-10-03')

    expect(database.getQueries()[0]?.params).toEqual(['daily', 1, '0099-01-01', '____-10-03'])
  })

  it('returns nothing when no earlier year has an entry', async () => {
    const { activity } = setup([{ path: 'daily/2026-10-03.md', markdown: 'today\n' }])
    await expect(activity.listOnThisDay('2026-10-03')).resolves.toEqual([])
  })
})
