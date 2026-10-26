import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import { act } from '@/test-utils/act.ts'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useNoteGitVersion } from './use-note-git-version.ts'

/**
 * The test core services of the running test, closed when it ends.
 */
function createApp(): TestCoreServices {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  return app
}

/**
 * The test core services, with the Git double answering `version` for every note.
 */
function appAnswering(version: string | null): TestCoreServices {
  const app = createApp()
  app.gitRepository.onNoteVersion(() => version)
  return app
}

/**
 * The `noteVersion` lookups the Git double has answered so far.
 */
function versionCalls(app: TestCoreServices): unknown[][] {
  return app.gitRepository
    .calls()
    .filter((call) => call.method === 'noteVersion')
    .map((call) => [...call.args])
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useNoteGitVersion', () => {
  it('does not query a closed detail view or a Local-only note', async () => {
    const app = appAnswering('abc123def4')
    let options = {
      root: '/g',
      generation: 11,
      path: 'notes/a.md',
      open: false,
      isLocalOnly: false,
    }
    const hook = await renderHookInApp(() => useNoteGitVersion(options), { core: app })
    expect(versionCalls(app)).toEqual([])

    options = { ...options, open: true, isLocalOnly: true }
    await hook.rerender()
    expect(versionCalls(app)).toEqual([])
    expect(hook.result.current.version).toBeNull()

    options = { ...options, isLocalOnly: false }
    await hook.rerender()
    await vi.waitFor(() => expect(hook.result.current.version).toBe('abc123def4'))
    expect(versionCalls(app)).toEqual([['notes/a.md', 11]])
  })

  it('fetches afresh on reopening without polling while details remain open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const app = appAnswering('abc123def4')
    let open = true
    const hook = await renderHookInApp(
      () => {
        return useNoteGitVersion({
          root: '/g',
          generation: 12,
          path: 'notes/a.md',
          open,
          isLocalOnly: false,
        })
      },
      { core: app },
    )
    await vi.waitFor(() => expect(hook.result.current.version).toBe('abc123def4'))
    expect(versionCalls(app)).toHaveLength(1)

    app.gitRepository.onNoteVersion(() => 'def456abc9')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000)
    })
    expect(versionCalls(app)).toHaveLength(1)
    expect(hook.result.current.version).toBe('abc123def4')

    open = false
    await hook.rerender()
    open = true
    await hook.rerender()
    await vi.waitFor(() => expect(hook.result.current.version).toBe('def456abc9'))
    expect(versionCalls(app)).toHaveLength(2)
  })

  it('discards a late version from another graph with the same note path', async () => {
    const first = Promise.withResolvers<string | null>()
    const app = createApp()
    app.gitRepository.onNoteVersion((_path, generation) => {
      return generation === 21 ? first.promise : 'newgraph123'
    })
    let generation = 21
    let root = '/first'
    const hook = await renderHookInApp(
      () => {
        return useNoteGitVersion({
          root,
          generation,
          path: 'notes/shared.md',
          open: true,
          isLocalOnly: false,
        })
      },
      { core: app },
    )
    await vi.waitFor(() => expect(versionCalls(app)).toEqual([['notes/shared.md', 21]]))

    generation = 22
    root = '/second'
    await hook.rerender()
    await vi.waitFor(() => expect(hook.result.current.version).toBe('newgraph123'))
    await act(async () => {
      first.resolve('oldgraph456')
      await first.promise
    })

    expect(hook.result.current.version).toBe('newgraph123')
  })

  it('reports unavailable history without replacing it with a false version', async () => {
    const app = createApp()
    app.gitRepository.onNoteVersion(() => {
      throw new Error('Git history unavailable')
    })
    const hook = await renderHookInApp(
      () => {
        return useNoteGitVersion({
          root: '/g',
          generation: 31,
          path: 'notes/a.md',
          open: true,
          isLocalOnly: false,
        })
      },
      { core: app },
    )

    await vi.waitFor(() => expect(hook.result.current.unavailable).toBe(true))
    expect(hook.result.current.version).toBeNull()
    expect(versionCalls(app)).toHaveLength(1)
  })
})
