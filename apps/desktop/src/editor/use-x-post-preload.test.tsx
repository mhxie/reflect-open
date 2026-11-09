import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createTestCoreServices } from '@reflect/core/testing'
import { queryClient } from '@/lib/query-client.ts'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { useXPostPreload, type XPostPreloadPrivacy } from './use-x-post-preload.ts'

/**
 * Core services whose X post archive reads never answer: only the wait can settle the preload.
 */
function appWithStuckArchive() {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  const loadXPost = vi
    .spyOn(app.embedMedia, 'loadXPost')
    .mockImplementation(async () => await new Promise(() => {}))
  return { app, loadXPost }
}

afterEach(() => {
  queryClient.clear()
})

describe('useXPostPreload', () => {
  it.each<XPostPreloadPrivacy>(['public', 'private', 'pending'])(
    'is ready at once for a note without X posts (%s)',
    async (privacy) => {
      const { app, loadXPost } = appWithStuckArchive()
      const hook = await renderHookInApp(() => useXPostPreload('Plain note\n', privacy), {
        core: app,
      })
      expect(hook.result.current).toBe(true)
      expect(loadXPost).not.toHaveBeenCalled()
    },
  )

  it('waits without fetching while a note with X posts has no verdict yet', async () => {
    const { app, loadXPost } = appWithStuckArchive()
    const hook = await renderHookInApp(
      ({ privacy }: { privacy: XPostPreloadPrivacy } = { privacy: 'pending' }) => {
        return useXPostPreload('![](https://x.com/jack/status/101)\n', privacy)
      },
      { core: app, initialProps: { privacy: 'pending' } },
    )
    expect(hook.result.current).toBe(false)
    expect(loadXPost).not.toHaveBeenCalled()

    await hook.rerender({ privacy: 'private' })
    expect(hook.result.current).toBe(true)
    expect(loadXPost).not.toHaveBeenCalled()
  })

  it('fetches the posts of a public note (control)', async () => {
    const { app, loadXPost } = appWithStuckArchive()
    const hook = await renderHookInApp(
      () => useXPostPreload('![](https://x.com/jack/status/101)\n', 'public'),
      { core: app },
    )
    expect(hook.result.current).toBe(false)
    await vi.waitFor(() => expect(loadXPost).toHaveBeenCalledWith('101'))
  })
})
