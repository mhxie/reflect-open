import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { NoteRow } from '@reflect/core'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { queryKeys } from '@/lib/query-client.ts'
import { act } from '@/test-utils/act.ts'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { usePrivateNoteState, type PrivateNoteOptions } from './use-private-note.ts'

/**
 * The open graph: rooted at `/g`, its local-only folders are `secure`.
 */
const GRAPH = { root: '/g', localOnlyFolders: ['secure'] }

function row(path: string, isPrivate: boolean): NoteRow {
  return {
    path,
    title: 'Plan',
    dailyDate: null,
    isPrivate,
    gistUrl: null,
    gistStale: false,
  }
}

/** Rows by path; a missing entry is a note the index doesn't have. */
let rows: Record<string, NoteRow>
let app: TestCoreServices
let getNote: MockInstance<TestCoreServices['indexQuery']['getNote']>

async function settledState(path: string, options: PrivateNoteOptions) {
  const hook = await renderHookInApp(() => usePrivateNoteState(path, options), {
    app,
    graph: GRAPH,
  })
  await vi.waitFor(() => expect(getNote).toHaveBeenCalledWith(path))
  await vi.waitFor(() => expect(hook.result.current.pending).toBe(false))
  return hook
}

beforeEach(() => {
  rows = {}
  app = createTestCoreServices()
  // Spied before the render: the hook reads the service when it mounts.
  getNote = vi
    .spyOn(app.indexQuery, 'getNote')
    .mockImplementation((path) => Promise.resolve(rows[path]))
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
    const { result } = await renderHookInApp(
      () => usePrivateNoteState('notes/plan.md', noSession),
      { app, graph: GRAPH },
    )
    await vi.waitFor(() => expect(getNote).toHaveBeenCalled())
    expect(result.current).toEqual({ privateNote: true, pending: true })
  })

  it('stays private for a note the index has no row for', async () => {
    const { result } = await settledState('notes/new.md', noSession)
    expect(result.current).toEqual({ privateNote: true, pending: false })
  })

  it('follows an in-app Lock toggle through the row cache', async () => {
    rows['notes/plan.md'] = row('notes/plan.md', false)
    const { result, queryClient } = await settledState('notes/plan.md', noSession)
    expect(result.current.privateNote).toBe(false)

    await act(() => {
      queryClient.setQueryData(
        queryKeys.index.note('/g', 'notes/plan.md'),
        row('notes/plan.md', true),
      )
    })
    await vi.waitFor(() => expect(result.current.privateNote).toBe(true))
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
    const hook = await renderHookInApp(
      ({ path }: { path: string } = { path: 'notes/old.md' }) => usePrivateNoteState(path, session),
      { app, graph: GRAPH, initialProps: { path: 'notes/old.md' } },
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
    const hook = await renderHookInApp(
      ({ path }: { path: string } = { path: 'notes/old.md' }) =>
        usePrivateNoteState(path, noSession),
      { app, graph: GRAPH, initialProps: { path: 'notes/old.md' } },
    )
    await vi.waitFor(() => expect(hook.result.current.privateNote).toBe(false))

    await hook.rerender({ path: 'notes/other.md' })
    expect(hook.result.current).toEqual({ privateNote: true, pending: true })
  })
})
