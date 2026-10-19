import { sha256Hex } from '@reflect/utils'
import { describe, expect, it, vi } from 'vitest'
import { ReflectError } from '../errors.ts'
import type { FileChange } from '../indexing/file-change-service.ts'
import { hashBytes } from '../indexing/hash.ts'
import type { IndexAppliedEvent } from '../indexing/index-lifecycle-service.ts'
import { createBackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import {
  createTestActivityPort,
  createTestAssetStoreService,
  createTestClockService,
  createTestIndexLifecycleService,
  createTestLoggerService,
  createTestNoteFileService,
} from '../testing/index.ts'
import { createAssetOcrMaintenanceService } from './asset-ocr-maintenance-service.ts'

const PATH = 'secure/scan.png'
const GENERATION = 7
const INDEX_GENERATION = 11
const NOW = 1_000_000

/**
 * The complete cached OCR of `assetPath`, read from bytes `[1, 2]`.
 */
async function completeEntry(
  assetPath: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  return JSON.stringify({
    version: 1,
    status: 'complete',
    deviceOnly: true,
    assetPath,
    sourceHash: await hashBytes(new Uint8Array([1, 2])),
    sourceSize: 2,
    providerId: 'local',
    model: 'vision',
    baseUrl: 'http://localhost:1234/v1',
    pages: 1,
    generatedAt: '2026-10-04T00:00:00.000Z',
    body: 'Private OCR',
    ...extra,
  })
}

function invalidEntry(assetPath: string): string {
  return JSON.stringify({ version: 1, status: 'invalid', deviceOnly: true, assetPath })
}

/**
 * The maintenance service over an attachment `secure/scan.png` (listed with
 * size 2 at `modifiedMs`, bytes `[1, 2]` on disk) whose OCR cache holds `entry`.
 */
async function setup(options: { entry?: string; modifiedMs?: number; listed?: boolean } = {}) {
  const noteFile = createTestNoteFileService()
  if (options.listed !== false) {
    noteFile.set(PATH, 'xx', { modifiedMs: options.modifiedMs ?? 1 })
  }
  const assetStore = createTestAssetStoreService({
    assets: { [PATH]: new Uint8Array([1, 2]) },
    ocrCache: { [await sha256Hex(PATH)]: options.entry ?? (await completeEntry(PATH)) },
  })
  const deviceReads: string[] = []
  const readBytesForDevice = assetStore.readBytesForDevice.bind(assetStore)
  vi.spyOn(assetStore, 'readBytesForDevice').mockImplementation(async (path, generation) => {
    deviceReads.push(path)
    return await readBytesForDevice(path, generation)
  })
  const appliedListeners = new Set<(event: IndexAppliedEvent) => void>()
  const reindexed: Array<readonly string[]> = []
  const indexLifecycle = createTestIndexLifecycleService()
  vi.spyOn(indexLifecycle, 'onApplied').mockImplementation((listener) => {
    appliedListeners.add(listener)
    return () => {
      appliedListeners.delete(listener)
    }
  })
  vi.spyOn(indexLifecycle, 'reindexNotesReferencing').mockImplementation(async (assetPaths) => {
    reindexed.push(assetPaths)
  })
  const activity = createTestActivityPort()
  const clock = createTestClockService({ now: NOW })
  let indexedEvents = 0
  const service = createAssetOcrMaintenanceService({
    assetStore,
    noteFile,
    indexLifecycle,
    reconcilers: createBackgroundReconcilerFactory({ activity }),
    activity,
    clock,
    logger: createTestLoggerService(),
    emitIndexed: () => {
      indexedEvents += 1
    },
  })
  return {
    service,
    noteFile,
    assetStore,
    activity,
    clock,
    deviceReads,
    reindexed,
    indexedEvents: () => indexedEvents,
    emit: (changes: FileChange[]): void => {
      for (const listener of appliedListeners) {
        listener({ generation: INDEX_GENERATION, changes })
      }
    },
    cacheEntry: async (assetPath: string) => assetStore.ocrCache().get(await sha256Hex(assetPath)),
  }
}

describe('AssetOcrMaintenanceService.reconcile', () => {
  it('reindexes a valid cached source on open without regenerating OCR', async () => {
    const { service, assetStore, deviceReads } = await setup()
    const write = vi.spyOn(assetStore, 'writeOcrCache')

    expect(await service.reconcile(GENERATION)).toEqual([PATH])
    expect(write).not.toHaveBeenCalled()
    expect(deviceReads).toEqual([PATH])
  })

  it('invalidates source replacements even when metadata stays unchanged', async () => {
    const { service, assetStore, cacheEntry } = await setup()
    vi.spyOn(assetStore, 'readBytesForDevice').mockResolvedValue(new Uint8Array([3, 4]))

    expect(await service.reconcile(GENERATION, ['scan.png'])).toEqual([PATH])
    expect(await cacheEntry(PATH)).toBe(invalidEntry(PATH))
  })

  it('recovers deleted sources from cache inventory and preserves their privacy marker', async () => {
    const { service, assetStore, cacheEntry } = await setup({ listed: false })
    vi.spyOn(assetStore, 'readBytesForDevice').mockRejectedValue(
      new ReflectError('notFound', 'deleted'),
    )
    const write = vi.spyOn(assetStore, 'writeOcrCache')

    expect(await service.reconcile(GENERATION)).toEqual([PATH])
    expect(write).toHaveBeenCalledTimes(1)
    expect(await cacheEntry(PATH)).toBe(invalidEntry(PATH))
  })

  it('keeps invalidated sources available for reindex retries after reopening', async () => {
    const { service, deviceReads } = await setup({ entry: invalidEntry(PATH) })

    expect(await service.reconcile(GENERATION)).toEqual([PATH])
    expect(deviceReads).toEqual([])
  })

  it('reports only sources it invalidates on a wake scan', async () => {
    const { service, assetStore, deviceReads } = await setup()

    expect(await service.reconcile(GENERATION, undefined, { reindexCached: false })).toEqual([])
    expect(deviceReads).toEqual([PATH])

    vi.spyOn(assetStore, 'readBytesForDevice').mockResolvedValue(new Uint8Array([3, 4]))
    expect(await service.reconcile(GENERATION, undefined, { reindexCached: false })).toEqual([PATH])
  })

  it('does not re-report an already invalidated source on a wake scan', async () => {
    const { service } = await setup({ entry: invalidEntry(PATH) })

    expect(await service.reconcile(GENERATION, undefined, { reindexCached: false })).toEqual([])
  })

  describe('wake scans', () => {
    async function recentlyRead(listedModifiedMs: number) {
      return await setup({
        modifiedMs: listedModifiedMs,
        entry: await completeEntry(PATH, { sourceModifiedMs: NOW - 60_000 }),
      })
    }

    it('skips re-reading a source whose recorded size and mtime still match', async () => {
      const { service, deviceReads } = await recentlyRead(NOW - 60_000)
      const options = { reindexCached: false, trustUnchangedStat: true }

      expect(await service.reconcile(GENERATION, undefined, options)).toEqual([])
      expect(deviceReads).toEqual([])
    })

    it('re-hashes a source whose mtime moved', async () => {
      const { service, assetStore } = await recentlyRead(NOW - 1_000_000)
      vi.spyOn(assetStore, 'readBytesForDevice').mockResolvedValue(new Uint8Array([3, 4]))
      const write = vi.spyOn(assetStore, 'writeOcrCache')
      const options = { reindexCached: false, trustUnchangedStat: true }

      expect(await service.reconcile(GENERATION, undefined, options)).toEqual([PATH])
      expect(write).toHaveBeenCalledTimes(1)
    })

    it('still re-hashes reported changes even when the metadata matches', async () => {
      const { service, assetStore } = await recentlyRead(NOW - 60_000)
      vi.spyOn(assetStore, 'readBytesForDevice').mockResolvedValue(new Uint8Array([3, 4]))

      expect(await service.reconcile(GENERATION, [PATH])).toEqual([PATH])
    })
  })

  it('keeps OCR for an evicted source without reading it', async () => {
    const { service, noteFile, assetStore, deviceReads } = await setup()
    noteFile.evict(PATH)
    const write = vi.spyOn(assetStore, 'writeOcrCache')

    expect(await service.reconcile(GENERATION, undefined, { reindexCached: false })).toEqual([])
    expect(deviceReads).toEqual([])
    expect(write).not.toHaveBeenCalled()
  })

  it('skips an unreadable source and goes on with the rest of the scan', async () => {
    const other = 'secure/other.png'
    const { service, assetStore } = await setup()
    await assetStore.writeOcrCache(await sha256Hex(other), await completeEntry(other), GENERATION)
    vi.spyOn(assetStore, 'readBytesForDevice').mockImplementation(async (path) => {
      if (path === PATH) {
        throw new ReflectError('io', 'the file is not available offline')
      }
      return new Uint8Array([3, 4])
    })

    expect(await service.reconcile(GENERATION, undefined, { reindexCached: false })).toEqual([
      other,
    ])
  })
})

describe('AssetOcrMaintenanceService.openSession', () => {
  it('reindexes every cached source on graph open and tells the index caches', async () => {
    const { service, reindexed, indexedEvents } = await setup()
    const session = service.openSession({
      generation: GENERATION,
      indexGeneration: INDEX_GENERATION,
    })

    session.start()

    await vi.waitFor(() => {
      expect(reindexed).toEqual([[PATH]])
      expect(indexedEvents()).toBe(1)
    })
    session.dispose()
  })

  it('checks an attachment the index reports changed, and its referencing notes', async () => {
    const { service, assetStore, reindexed, emit, cacheEntry } = await setup()
    const session = service.openSession({
      generation: GENERATION,
      indexGeneration: INDEX_GENERATION,
    })
    session.start()
    await vi.waitFor(() => expect(reindexed).toHaveLength(1))
    vi.spyOn(assetStore, 'readBytesForDevice').mockResolvedValue(new Uint8Array([3, 4]))

    emit([{ path: PATH, kind: 'upsert', modifiedMs: 2 }])

    await vi.waitFor(() => expect(reindexed).toEqual([[PATH], [PATH]]))
    expect(await cacheEntry(PATH)).toBe(invalidEntry(PATH))
    session.dispose()
  })

  it('rescans on wake at most every five minutes, trusting unchanged metadata', async () => {
    const { service, activity, clock, deviceReads, reindexed } = await setup()
    const session = service.openSession({
      generation: GENERATION,
      indexGeneration: INDEX_GENERATION,
    })
    session.start()
    await vi.waitFor(() => expect(reindexed).toHaveLength(1))
    expect(deviceReads).toEqual([PATH])

    activity.emitWake()
    await vi.waitFor(() => expect(deviceReads).toHaveLength(2))
    activity.emitWake() // within the interval: no scan
    await clock.advance(5 * 60 * 1000)
    activity.emitWake()

    await vi.waitFor(() => expect(deviceReads).toHaveLength(3))
    session.dispose()
  })
})
