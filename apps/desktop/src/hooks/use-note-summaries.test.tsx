import { describe, expect, it, vi } from 'vitest'
import { createGraphServices, type GraphInfo, type GraphLifecycleFlags } from '@reflect/core'
import { createTestBackupService, createTestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useNoteSummaries } from './use-note-summaries.ts'

/**
 * The graph `renderInApp` opens when given none.
 */
const GRAPH: GraphInfo = {
  root: '/graphs/test',
  name: 'test',
  generation: 1,
  localOnlyFolders: [],
  localOnlyEditableFolders: [],
}

/**
 * Only the lifecycles every session runs: no backup.
 */
const NO_LIFECYCLES: GraphLifecycleFlags = {
  backup: false,
  icloudSync: false,
  capture: false,
  assetDescription: false,
  assetOcrMaintenance: false,
  icloudDownload: false,
  metadataWatch: false,
}

describe('useNoteSummaries', () => {
  it('catches up with the graph’s backup before a pass summarizes', async () => {
    const backup = createTestBackupService({ state: { phase: 'disconnected' } })
    const app = createTestCoreServices({ backup })
    const openSession = vi.spyOn(app.noteSummaries, 'openSession')

    await renderHookInApp(() => useNoteSummaries(GRAPH), { app })

    expect(openSession).toHaveBeenCalledTimes(1)
    const [options] = openSession.mock.calls[0] ?? []
    await options?.catchUp?.()
    expect(backup.calls()).toContainEqual({ method: 'catchUp' })
  })

  it('still summarizes a graph without a backup: there is nothing to catch up with', async () => {
    const app = createTestCoreServices({
      createGraphServices: (session, deps) => createGraphServices(session, deps, NO_LIFECYCLES),
    })
    const openSession = vi.spyOn(app.noteSummaries, 'openSession')

    await renderHookInApp(() => useNoteSummaries(GRAPH), { app })

    expect(openSession).toHaveBeenCalledTimes(1)
    const [options] = openSession.mock.calls[0] ?? []
    expect(options?.catchUp?.()).toBeUndefined()
  })
})
