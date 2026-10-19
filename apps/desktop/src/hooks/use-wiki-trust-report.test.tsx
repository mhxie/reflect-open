import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import {
  createTestBackupService,
  createTestCoreServices,
  type TestBackupService,
  type TestCoreServices,
} from '@reflect/core/testing'
import { act } from '@/test-utils/act.ts'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useWikiTrustReport } from './use-wiki-trust-report.ts'

const VALID = JSON.stringify({
  format: 'reflect-wiki-trust',
  version: 1,
  generated_at: '2026-10-08T09:00:00Z',
  harness: { name: 'test' },
  notes: {},
})

const SETTINGS = {
  wikiTrustDisplay: 'off',
  wikiTrustReportPath: '.harness/wiki-trust.json',
} as const

/** The report file: absent when null. */
let file: { stamp: string; contents: string } | null
/** Holds report reads until it resolves, when a test sets it. */
let readGate: Promise<void> | null

/**
 * Core services whose bridge answers `wiki_trust_report_read` from `file`, with
 * `backup` as the graph's backup service (none when it is null).
 */
function appWith(backup: TestBackupService | null): TestCoreServices {
  const app: TestCoreServices =
    backup === null ? createTestCoreServices() : createTestCoreServices({ backup })
  app.ipc.onCommand('wiki_trust_report_read', async (args) => {
    await readGate
    if (file === null) return null
    const known = args['knownStamp']
    return { stamp: file.stamp, contents: known === file.stamp ? null : file.contents }
  })
  return app
}

/**
 * How often the hook told `backup` that a graph file changed.
 */
function changes(backup: TestBackupService): number {
  return backup.calls().filter((call) => call.method === 'fileChanged').length
}

async function poll(client: QueryClient): Promise<void> {
  await act(async () => {
    await client.refetchQueries({ queryKey: ['wiki-trust'] })
  })
}

beforeEach(() => {
  readGate = null
  file = { stamp: '1:1', contents: VALID }
})

describe('useWikiTrustReport and backup', () => {
  it('tells backup once per new version or deletion, never for an unchanged file', async () => {
    const backup = createTestBackupService()
    const { result, queryClient } = await renderHookInApp(() => useWikiTrustReport(true), {
      app: appWith(backup),
      settings: SETTINGS,
    })
    await vi.waitFor(() => expect(result.current.status).toBe('ready'))
    // The first version seen may be one backup has not committed.
    expect(changes(backup)).toBe(1)
    await poll(queryClient)
    expect(changes(backup)).toBe(1)

    file = { stamp: '2:2', contents: VALID }
    await poll(queryClient)
    expect(changes(backup)).toBe(2)

    // A rejected report counts once, not on every poll.
    file = { stamp: '3:3', contents: '{' }
    await poll(queryClient)
    await poll(queryClient)
    await vi.waitFor(() => expect(result.current.status).toBe('invalid'))
    expect(changes(backup)).toBe(3)

    file = null
    await poll(queryClient)
    await poll(queryClient)
    await vi.waitFor(() => expect(result.current.status).toBe('missing'))
    expect(changes(backup)).toBe(4)
  })
})

describe('useWikiTrustReport and a backup that starts mid-read', () => {
  it('tells the backup running when the report arrives', async () => {
    const backup = createTestBackupService()
    const app = appWith(backup)
    let release = (): void => {}
    readGate = new Promise((resolve) => (release = resolve))
    // The graph opens without its services, so no backup runs yet.
    const { result } = await renderHookInApp(() => useWikiTrustReport(true), {
      app,
      settings: SETTINGS,
      graphState: { services: null },
    })
    await vi.waitFor(() =>
      expect(app.ipc.calls().map((call) => call.command)).toContain('wiki_trust_report_read'),
    )
    // The graph's services (with its backup) start while the read is out.
    await act(() => {
      app.graphSession.setGraph({})
    })
    release()
    await vi.waitFor(() => expect(result.current.status).toBe('ready'))
    expect(changes(backup)).toBe(1)
  })
})

describe('useWikiTrustReport with an idle observer', () => {
  it('still refetches on window focus for the active one', async () => {
    // Display is off, so the first observer idles; the second always watches.
    const { result } = await renderHookInApp(
      // The idle observer renders last, so its options are the query's latest.
      () => ({ watching: useWikiTrustReport(true), idle: useWikiTrustReport() }),
      { app: appWith(null), settings: SETTINGS },
    )
    await vi.waitFor(() => expect(result.current.watching.status).toBe('ready'))
    expect(result.current.idle.status).toBe('off')
    file = null
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(result.current.watching.status).toBe('missing'))
  })
})
