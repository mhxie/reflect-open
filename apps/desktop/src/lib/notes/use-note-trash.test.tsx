import { act, createElement, type ReactNode } from 'react'
import { renderHook } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { getOperations, resetOperations } from '@/lib/operations.ts'
import { useNoteTrash } from './use-note-trash.ts'

interface GraphValue {
  graph: { root: string; name: string; generation: number } | null
}
let graphValue: GraphValue
vi.mock('@/providers/graph-provider.tsx', () => ({ useGraph: () => graphValue }))

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

let client: QueryClient
function wrapper({ children }: { children: ReactNode }): ReactNode {
  return createElement(QueryClientProvider, { client }, children)
}

beforeEach(() => {
  graphValue = { graph: { root: '/g', name: 'g', generation: 1 } }
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
  mockInvoke.mockReset()
  mockInvoke.mockResolvedValue({ trashed: 'system' })
})

afterEach(() => {
  setBridge(null) // don't leak the mock transport into other suites in this worker
  resetOperations() // drop the operations a failed run leaves lingering
})

describe('useNoteTrash', () => {
  it('reports a failure without trashing when no graph is open (never a silent success)', async () => {
    graphValue = { graph: null }
    const { result } = await renderHook(() => useNoteTrash(), { wrapper })

    await expect(result.current.trash(['notes/a.md'])).resolves.toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('is a no-op for an empty selection', async () => {
    const { result } = await renderHook(() => useNoteTrash(), { wrapper })

    await expect(result.current.trash([])).resolves.toBe(true)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('trashes every note and resolves true', async () => {
    const { result } = await renderHook(() => useNoteTrash(), { wrapper })

    let trashed = false
    await act(async () => {
      trashed = await result.current.trash(['notes/a.md', 'notes/b.md'])
    })

    expect(trashed).toBe(true)
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', {
      path: 'notes/a.md',
      generation: 1,
    })
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', {
      path: 'notes/b.md',
      generation: 1,
    })
  })

  it('keeps going past a per-note failure and resolves false', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'note_delete' && args['path'] === 'notes/b.md') {
        throw new Error('locked')
      }
      return { trashed: 'system' }
    })
    const { result } = await renderHook(() => useNoteTrash(), { wrapper })

    let trashed = true
    await act(async () => {
      trashed = await result.current.trash(['notes/a.md', 'notes/b.md', 'notes/c.md'])
    })

    // The batch reports failure but still attempted (and trashed) the others.
    expect(trashed).toBe(false)
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', {
      path: 'notes/a.md',
      generation: 1,
    })
    expect(mockInvoke).toHaveBeenCalledWith('note_delete', {
      path: 'notes/c.md',
      generation: 1,
    })
  })

  it('says when the system Trash refused a note and the graph’s trash kept it', async () => {
    mockInvoke.mockImplementation(async (_command, args) => ({
      trashed: args['path'] === 'secure/bank.md' ? 'graph' : 'system',
    }))
    const { result } = await renderHook(() => useNoteTrash(), { wrapper })

    let trashed = false
    await act(async () => {
      trashed = await result.current.trash(['notes/a.md', 'secure/bank.md'])
    })

    expect(trashed).toBe(true)
    expect(getOperations()).toEqual([
      expect.objectContaining({
        label: 'Trashing notes',
        status: 'warning',
        message: 'Moved to .reflect/trash in this graph',
      }),
    ])
  })
})
