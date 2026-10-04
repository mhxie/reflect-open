import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { listDailyActivity } from './daily-activity.ts'

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('listDailyActivity', () => {
  it('sizes every daily note with content, oldest first', async () => {
    mockInvoke.mockResolvedValue([
      { daily_date: '2026-09-30', characters: 120 },
      { daily_date: '2026-10-02', characters: 0 },
    ])

    await expect(listDailyActivity()).resolves.toEqual([
      { date: '2026-09-30', characters: 120 },
      { date: '2026-10-02', characters: 0 },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const query = String(args['sql'])
    expect(query).toContain('"body_chars" as "characters"')
    expect(query).not.toContain('search_fts')
    expect(query).toContain('has_content')
    expect(args['params']).toEqual(['daily', 1])
  })
})
