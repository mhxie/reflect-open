import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNoteGitVersion } from './use-note-git-version.ts'

const gitNoteVersion = vi.hoisted(() =>
  vi.fn<(path: string, generation: number) => Promise<string | null>>(),
)
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  gitNoteVersion,
}))

const clients: QueryClient[] = []

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  gitNoteVersion.mockReset()
  gitNoteVersion.mockResolvedValue('abc123def4')
})

afterEach(async () => {
  await cleanup()
  for (const client of clients.splice(0)) {
    client.clear()
  }
  vi.useRealTimers()
})

describe('useNoteGitVersion', () => {
  it('does not query a closed detail view or a Local-only note', async () => {
    let options = {
      root: '/g',
      generation: 11,
      path: 'notes/a.md',
      open: false,
      isLocalOnly: false,
    }
    const hook = await renderHook(() => useNoteGitVersion(options), { wrapper: makeWrapper() })
    expect(gitNoteVersion).not.toHaveBeenCalled()

    options = { ...options, open: true, isLocalOnly: true }
    await hook.rerender()
    expect(gitNoteVersion).not.toHaveBeenCalled()
    expect(hook.result.current.version).toBeNull()

    options = { ...options, isLocalOnly: false }
    await hook.rerender()
    await vi.waitFor(() => expect(hook.result.current.version).toBe('abc123def4'))
    expect(gitNoteVersion).toHaveBeenCalledWith('notes/a.md', 11)
  })

  it('fetches afresh on reopening without polling while details remain open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let open = true
    const hook = await renderHook(
      () =>
        useNoteGitVersion({
          root: '/g',
          generation: 12,
          path: 'notes/a.md',
          open,
          isLocalOnly: false,
        }),
      { wrapper: makeWrapper() },
    )
    await vi.waitFor(() => expect(hook.result.current.version).toBe('abc123def4'))
    expect(gitNoteVersion).toHaveBeenCalledTimes(1)

    gitNoteVersion.mockResolvedValue('def456abc9')
    await hook.act(async () => {
      await vi.advanceTimersByTimeAsync(45_000)
    })
    expect(gitNoteVersion).toHaveBeenCalledTimes(1)
    expect(hook.result.current.version).toBe('abc123def4')

    open = false
    await hook.rerender()
    open = true
    await hook.rerender()
    await vi.waitFor(() => expect(hook.result.current.version).toBe('def456abc9'))
    expect(gitNoteVersion).toHaveBeenCalledTimes(2)
  })

  it('discards a late version from another graph with the same note path', async () => {
    let finishFirst: ((version: string | null) => void) | undefined
    const firstVersion = new Promise<string | null>((resolve) => {
      finishFirst = resolve
    })
    gitNoteVersion.mockImplementation(async (_path, generation) =>
      generation === 21 ? await firstVersion : 'newgraph123',
    )
    let generation = 21
    let root = '/first'
    const hook = await renderHook(
      () =>
        useNoteGitVersion({
          root,
          generation,
          path: 'notes/shared.md',
          open: true,
          isLocalOnly: false,
        }),
      { wrapper: makeWrapper() },
    )
    await vi.waitFor(() => expect(gitNoteVersion).toHaveBeenCalledWith('notes/shared.md', 21))

    generation = 22
    root = '/second'
    await hook.rerender()
    await vi.waitFor(() => expect(hook.result.current.version).toBe('newgraph123'))
    await hook.act(async () => {
      finishFirst?.('oldgraph456')
      await firstVersion
    })

    expect(hook.result.current.version).toBe('newgraph123')
  })

  it('reports unavailable history without replacing it with a false version', async () => {
    gitNoteVersion.mockRejectedValue(new Error('Git history unavailable'))
    const hook = await renderHook(
      () =>
        useNoteGitVersion({
          root: '/g',
          generation: 31,
          path: 'notes/a.md',
          open: true,
          isLocalOnly: false,
        }),
      { wrapper: makeWrapper() },
    )

    await vi.waitFor(() => expect(hook.result.current.unavailable).toBe(true))
    expect(hook.result.current.version).toBeNull()
    expect(gitNoteVersion).toHaveBeenCalledTimes(1)
  })
})
