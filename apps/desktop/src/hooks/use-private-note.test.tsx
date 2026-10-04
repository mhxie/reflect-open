import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { renderHook } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NoteRow } from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import { usePrivateNoteState, type PrivateNoteOptions } from './use-private-note.ts'

const getNote = vi.hoisted(() => vi.fn<(path: string) => Promise<NoteRow | undefined>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getNote,
  // The graph's local-only folders are `secure`.
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))

function row(path: string, isPrivate: boolean): NoteRow {
  return {
    path,
    title: 'Plan',
    dailyDate: null,
    isPrivate,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
  }
}

/** Rows by path; a missing entry is a note the index doesn't have. */
let rows: Record<string, NoteRow>
let client: QueryClient

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

async function settledState(path: string, options: PrivateNoteOptions) {
  const hook = await renderHook(() => usePrivateNoteState(path, options), { wrapper })
  await vi.waitFor(() => expect(getNote).toHaveBeenCalledWith(path))
  await vi.waitFor(() => expect(hook.result.current.pending).toBe(false))
  return hook
}

beforeEach(() => {
  rows = {}
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  getNote.mockReset().mockImplementation(async (path) => rows[path])
})

describe('usePrivateNoteState', () => {
  const noSession = { sessionEpoch: null, privateHeader: false }

  it('is public once a public row resolves', async () => {
    rows['notes/plan.md'] = row('notes/plan.md', false)
    const { result } = await settledState('notes/plan.md', noSession)
    expect(result.current).toEqual({ privateNote: false, pending: false })
  })

  it('is private for a private row', async () => {
    rows['notes/plan.md'] = row('notes/plan.md', true)
    const { result } = await settledState('notes/plan.md', noSession)
    expect(result.current.privateNote).toBe(true)
  })

  it('is private when the live header is, even while the row says public', async () => {
    rows['notes/plan.md'] = row('notes/plan.md', false)
    const { result } = await settledState('notes/plan.md', {
      sessionEpoch: 1,
      privateHeader: true,
    })
    expect(result.current).toEqual({ privateNote: true, pending: false })
  })

  it('is private for a local-only path whatever the row says', async () => {
    rows['finance/secure/bank.md'] = row('finance/secure/bank.md', false)
    const { result } = await settledState('finance/secure/bank.md', noSession)
    expect(result.current).toEqual({ privateNote: true, pending: false })
  })

  it('fails closed while the row loads, and says it is pending', async () => {
    getNote.mockImplementation(() => new Promise(() => {}))
    const { result } = await renderHook(() => usePrivateNoteState('notes/plan.md', noSession), {
      wrapper,
    })
    await vi.waitFor(() => expect(getNote).toHaveBeenCalled())
    expect(result.current).toEqual({ privateNote: true, pending: true })
  })

  it('stays private for a note the index has no row for', async () => {
    const { result } = await settledState('notes/new.md', noSession)
    expect(result.current).toEqual({ privateNote: true, pending: false })
  })

  it('follows an in-app Lock toggle through the row cache', async () => {
    rows['notes/plan.md'] = row('notes/plan.md', false)
    const { result, act } = await settledState('notes/plan.md', noSession)
    expect(result.current.privateNote).toBe(false)

    await act(() => {
      client.setQueryData(queryKeys.index.note('/g', 'notes/plan.md'), row('notes/plan.md', true))
    })
    expect(result.current.privateNote).toBe(true)
  })

  it("keeps a session's verdict through a rename until the new path's row lands", async () => {
    rows['notes/old.md'] = row('notes/old.md', false)
    let releaseRow!: () => void
    getNote.mockImplementation(async (path) => {
      if (path === 'notes/new.md') {
        await new Promise<void>((resolve) => {
          releaseRow = resolve
        })
        return row('notes/new.md', false)
      }
      return rows[path]
    })
    const session = { sessionEpoch: 3, privateHeader: false }
    const hook = await renderHook(
      ({ path }: { path: string } = { path: 'notes/old.md' }) => usePrivateNoteState(path, session),
      { wrapper, initialProps: { path: 'notes/old.md' } },
    )
    await vi.waitFor(() => expect(hook.result.current.privateNote).toBe(false))

    await hook.rerender({ path: 'notes/new.md' })
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledWith('notes/new.md'))
    expect(hook.result.current).toEqual({ privateNote: false, pending: false })
    releaseRow()
    await vi.waitFor(() => expect(hook.result.current.privateNote).toBe(false))
  })

  it('carries nothing across notes without a session', async () => {
    rows['notes/old.md'] = row('notes/old.md', false)
    getNote.mockImplementation(async (path) =>
      path === 'notes/other.md' ? await new Promise<never>(() => {}) : rows[path],
    )
    const hook = await renderHook(
      ({ path }: { path: string } = { path: 'notes/old.md' }) =>
        usePrivateNoteState(path, noSession),
      { wrapper, initialProps: { path: 'notes/old.md' } },
    )
    await vi.waitFor(() => expect(hook.result.current.privateNote).toBe(false))

    await hook.rerender({ path: 'notes/other.md' })
    expect(hook.result.current).toEqual({ privateNote: true, pending: true })
  })
})
