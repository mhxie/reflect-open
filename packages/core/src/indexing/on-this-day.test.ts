import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { listOnThisDay } from './on-this-day.ts'

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('listOnThisDay', () => {
  it('lists earlier years of the same day with content, newest first', async () => {
    mockInvoke.mockResolvedValue([
      { path: 'daily/2025-10-03.md', daily_date: '2025-10-03', preview: 'last year' },
      { path: 'daily/2023-10-03.md', daily_date: '2023-10-03', preview: '' },
    ])

    const entries = await listOnThisDay('2026-10-03')

    expect(entries).toEqual([
      { path: 'daily/2025-10-03.md', dailyDate: '2025-10-03', preview: 'last year', yearsAgo: 1 },
      { path: 'daily/2023-10-03.md', dailyDate: '2023-10-03', preview: '', yearsAgo: 3 },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('has_content')
    expect(sql).toContain('like')
    expect(sql).toContain('order by "daily_date" desc')
    expect(args['params']).toEqual(['daily', 1, '2026-01-01', '____-10-03'])
  })

  it('keeps a leading-zero year in the cutoff', async () => {
    mockInvoke.mockResolvedValue([])

    await listOnThisDay('0099-10-03')

    expect(mockInvoke.mock.calls[0]![1]['params']).toEqual(['daily', 1, '0099-01-01', '____-10-03'])
  })

  it('returns nothing when no earlier year has an entry', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(listOnThisDay('2026-10-03')).resolves.toEqual([])
  })
})
