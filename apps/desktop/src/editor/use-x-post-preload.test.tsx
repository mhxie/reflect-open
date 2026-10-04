import { renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { queryClient } from '@/lib/query-client.ts'
import { useXPostPreload, type XPostPreloadPrivacy } from './use-x-post-preload.ts'

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))

let commands: string[]

beforeEach(() => {
  commands = []
  setBridge({
    invoke: async (command) => {
      commands.push(command)
      // An archive read that never answers: only the wait can settle it.
      return await new Promise(() => {})
    },
    listen: async () => () => {},
  })
})

afterEach(() => {
  setBridge(null)
  queryClient.clear()
})

describe('useXPostPreload', () => {
  it.each<XPostPreloadPrivacy>(['public', 'private', 'pending'])(
    'is ready at once for a note without X posts (%s)',
    async (privacy) => {
      const hook = await renderHook(() => useXPostPreload('Plain note\n', privacy))
      expect(hook.result.current).toBe(true)
      expect(commands).toEqual([])
      await hook.unmount()
    },
  )

  it('waits without fetching while a note with X posts has no verdict yet', async () => {
    const hook = await renderHook(
      ({ privacy }: { privacy: XPostPreloadPrivacy } = { privacy: 'pending' }) =>
        useXPostPreload('![](https://x.com/jack/status/101)\n', privacy),
      { initialProps: { privacy: 'pending' } },
    )
    expect(hook.result.current).toBe(false)
    expect(commands).toEqual([])

    await hook.rerender({ privacy: 'private' })
    expect(hook.result.current).toBe(true)
    expect(commands).toEqual([])
    await hook.unmount()
  })
})
