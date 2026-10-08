import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { setBridge } from '@reflect/core'
import { renderHook } from 'vitest-browser-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWikiTrustReport } from './use-wiki-trust-report.ts'

const fileChanged = vi.hoisted(() => vi.fn())
vi.mock('@/providers/sync-provider.tsx', () => ({ useSyncContext: () => ({ fileChanged }) }))
vi.mock('@/hooks/use-bridge-ready.ts', () => ({ useBridgeReady: () => true }))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: { wikiTrustDisplay: 'off', wikiTrustReportPath: '.harness/wiki-trust.json' },
  }),
}))

const VALID = JSON.stringify({
  format: 'reflect-wiki-trust',
  version: 1,
  generated_at: '2026-10-08T09:00:00Z',
  harness: { name: 'test' },
  notes: {},
})

/** The report file: absent when null. */
let file: { stamp: string; contents: string } | null
let client: QueryClient

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  fileChanged.mockClear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  file = { stamp: '1:1', contents: VALID }
  setBridge({
    invoke: async (command, args) => {
      if (command !== 'wiki_trust_report_read' || file === null) return null
      const known = (args as { knownStamp: string | null }).knownStamp
      return { stamp: file.stamp, contents: known === file.stamp ? null : file.contents }
    },
    listen: async () => () => {},
  })
})

async function poll(): Promise<void> {
  await client.refetchQueries({ queryKey: ['wiki-trust'] })
}

describe('useWikiTrustReport and backup', () => {
  it('tells backup once per new version or deletion, never for an unchanged file', async () => {
    const { result } = await renderHook(() => useWikiTrustReport(true), { wrapper })
    await vi.waitFor(() => expect(result.current.status).toBe('ready'))
    // The first read is what backup already has.
    expect(fileChanged).not.toHaveBeenCalled()
    await poll()
    expect(fileChanged).not.toHaveBeenCalled()

    file = { stamp: '2:2', contents: VALID }
    await poll()
    expect(fileChanged).toHaveBeenCalledTimes(1)

    // A rejected report counts once, not on every poll.
    file = { stamp: '3:3', contents: '{' }
    await poll()
    await poll()
    await vi.waitFor(() => expect(result.current.status).toBe('invalid'))
    expect(fileChanged).toHaveBeenCalledTimes(2)

    file = null
    await poll()
    await poll()
    await vi.waitFor(() => expect(result.current.status).toBe('missing'))
    expect(fileChanged).toHaveBeenCalledTimes(3)
  })
})
