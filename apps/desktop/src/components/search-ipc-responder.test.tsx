import { render } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchIpcAnswer, SearchIpcRequest } from '@reflect/core'
import { SearchIpcResponder } from './search-ipc-responder.tsx'

const core = vi.hoisted(() => ({
  handler: null as ((request: SearchIpcRequest) => void) | null,
  unlisten: vi.fn(),
  startSearchIpc: vi.fn(async () => {}),
  stopSearchIpc: vi.fn(async () => {}),
  respondSearchIpc: vi.fn(async (_id: number, _answer: SearchIpcAnswer) => {}),
  answerSearchIpcRequest: vi.fn(
    async (_request: SearchIpcRequest, _semantic: boolean): Promise<SearchIpcAnswer> => ({
      mode: 'hybrid',
      results: [{ path: 'notes/a.md', title: 'A', snippet: 'a', score: 1 }],
    }),
  ),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  startSearchIpc: core.startSearchIpc,
  stopSearchIpc: core.stopSearchIpc,
  respondSearchIpc: core.respondSearchIpc,
  answerSearchIpcRequest: core.answerSearchIpcRequest,
  subscribeSearchIpcRequests: async (handler: (request: SearchIpcRequest) => void) => {
    core.handler = handler
    return core.unlisten
  },
}))

const graph = vi.hoisted(() => ({ root: '/g' as string | null }))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: graph.root === null ? null : { root: graph.root, name: 'g' } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({ settings: { semanticSearchEnabled: true } }),
}))

beforeEach(() => {
  graph.root = '/g'
  core.handler = null
  for (const mock of [
    core.unlisten,
    core.startSearchIpc,
    core.stopSearchIpc,
    core.respondSearchIpc,
    core.answerSearchIpcRequest,
  ]) {
    mock.mockClear()
  }
})

const REQUEST: SearchIpcRequest = { id: 7, query: 'wombat', mode: 'hybrid', limit: 10 }

describe('SearchIpcResponder', () => {
  it('serves the open graph and answers each request through retrieve', async () => {
    await render(<SearchIpcResponder />)
    await vi.waitFor(() => expect(core.startSearchIpc).toHaveBeenCalledTimes(1))

    core.handler?.(REQUEST)
    await vi.waitFor(() =>
      expect(core.respondSearchIpc).toHaveBeenCalledWith(7, {
        mode: 'hybrid',
        results: [{ path: 'notes/a.md', title: 'A', snippet: 'a', score: 1 }],
      }),
    )
    expect(core.answerSearchIpcRequest).toHaveBeenCalledWith(REQUEST, true)
  })

  it('stops serving when the workspace goes away', async () => {
    const view = await render(<SearchIpcResponder />)
    await vi.waitFor(() => expect(core.startSearchIpc).toHaveBeenCalled())
    await view.unmount()
    await vi.waitFor(() => expect(core.stopSearchIpc).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(core.unlisten).toHaveBeenCalledTimes(1))
  })

  it('serves nothing without an open graph', async () => {
    graph.root = null
    await render(<SearchIpcResponder />)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(core.startSearchIpc).not.toHaveBeenCalled()
    expect(core.handler).toBeNull()
  })
})
