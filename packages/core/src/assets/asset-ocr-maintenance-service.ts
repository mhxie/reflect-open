import { errorMessage, isAppError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { assetReferenceMatches } from '../indexing/asset-refs.ts'
import { hashBytes, matchesTrustedMtime } from '../indexing/hash.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { ActivityPort } from '../ports/activity-port.ts'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { BackgroundReconcilerFactory } from '../reconcile/background-reconciler.ts'
import { localOcrAssetTypeFor } from './asset-description-helpers.ts'
import {
  cachedAssetOcrPaths,
  invalidateLocalAssetOcr,
  readAssetOcrState,
} from './asset-ocr-cache.ts'

/**
 * The least time between wake-triggered full scans: focus fires on every
 * switch back to the app, and a scan reads every cache entry.
 */
const WAKE_SCAN_INTERVAL_MS = 5 * 60 * 1000

/**
 * How {@link AssetOcrMaintenanceService.reconcile} reports what needs reindexing.
 */
export interface ReconcileAssetOcrOptions {
  /**
   * Report every cached source, valid or invalid, so notes referencing them
   * are reindexed (graph open, or a retry after a failed reindex). Defaults
   * to true for a full scan. Otherwise only sources this pass invalidates
   * are reported.
   */
  readonly reindexCached?: boolean
  /**
   * Skip re-reading a source whose size and modification time still match
   * what the cache recorded when its bytes were read (wake scans). Off for
   * graph open and for reported changes, which always re-hash: a replacement
   * that keeps its metadata is caught there.
   */
  readonly trustUnchangedStat?: boolean
}

/**
 * The maintenance lifecycle for one graph session. `dispose()` is terminal.
 */
export interface AssetOcrMaintenanceSession {
  /**
   * Attach the triggers (index-applied, wake) and run the graph-open scan.
   */
  start(): void
  /**
   * Tear down triggers and abort an in-flight pass at its next gate.
   */
  dispose(): void
}

export interface AssetOcrMaintenanceSessionOptions {
  /**
   * The open graph's generation; every pass's reads and writes pin to it.
   */
  generation: number
  /**
   * The open graph's index generation, or `null` when its index failed to open.
   */
  indexGeneration: number | null
}

export interface AssetOcrMaintenanceServiceDeps {
  readonly assetStore: AssetStoreService
  readonly noteFile: NoteFileService
  readonly indexLifecycle: IndexLifecycleService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly activity: ActivityPort
  readonly clock: ClockService
  readonly logger: LoggerService
  /**
   * Tells the holders of index-backed caches that a pass re-indexed notes
   * directly (not through the watcher).
   */
  readonly emitIndexed: () => void
}

/**
 * Keeps existing local OCR honest without generating any: when an
 * attachment's bytes change (or it is deleted), its cached OCR is marked
 * invalid and the notes referencing it are re-indexed, so search never folds
 * text that no longer describes the file. Runs on graph open, on wake, and on
 * attachment changes, even while automatic OCR is off.
 */
export interface AssetOcrMaintenanceService {
  /**
   * Check existing OCR sources after open/wake or file changes, without
   * generating new OCR. Scans `changed` (attachment paths or bare names), or
   * every cached source when omitted. Returns the asset paths whose
   * referencing notes need reindexing.
   */
  reconcile(
    generation: number,
    changed?: readonly string[],
    options?: ReconcileAssetOcrOptions,
  ): Promise<string[]>
  /**
   * Build the maintenance lifecycle for one graph session.
   */
  openSession(options: AssetOcrMaintenanceSessionOptions): AssetOcrMaintenanceSession
}

interface AssetOcrMaintenanceSessionDeps {
  readonly indexLifecycle: IndexLifecycleService
  readonly reconcilers: BackgroundReconcilerFactory
  readonly activity: ActivityPort
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly emitIndexed: () => void
  readonly reconcile: (
    generation: number,
    changed: readonly string[] | undefined,
    options: ReconcileAssetOcrOptions,
  ) => Promise<string[]>
}

class AssetOcrMaintenanceSessionImpl implements AssetOcrMaintenanceSession {
  readonly #deps: AssetOcrMaintenanceSessionDeps
  readonly #options: AssetOcrMaintenanceSessionOptions
  readonly #loop: ReturnType<BackgroundReconcilerFactory['create']>
  /**
   * Attachments reported changed and not yet checked.
   */
  readonly #changed = new Set<string>()
  #started = false
  /**
   * The next pass scans every cached source (graph open, a wake, or a retry).
   */
  #fullScan = true
  /**
   * Open (and a retry after a failed reindex) reindexes every cached source;
   * a wake scan reindexes only what it invalidates.
   */
  #reindexCached = true
  /**
   * Wake scans trust an unchanged size and mtime; open and retries re-hash.
   */
  #trustUnchangedStat = false
  #lastWakeScan = -Infinity
  /**
   * Last logged failure, so a retry that fails the same way logs once.
   */
  #loggedError: string | null = null

  constructor(deps: AssetOcrMaintenanceSessionDeps, options: AssetOcrMaintenanceSessionOptions) {
    this.#deps = deps
    this.#options = options
    this.#loop = deps.reconcilers.create({ pass: (isStale) => this.#pass(isStale) })
  }

  start(): void {
    const { indexLifecycle, activity } = this.#deps
    const { indexGeneration } = this.#options
    if (this.#started || this.#loop.isStale()) {
      return
    }
    this.#started = true
    this.#loop.onDispose(
      indexLifecycle.onApplied((event) => {
        if (event.generation !== indexGeneration || event.changes === null) {
          return
        }
        for (const change of event.changes) {
          if (localOcrAssetTypeFor(change.path) !== null) {
            this.#changed.add(change.path)
          }
        }
        if (this.#changed.size > 0) {
          this.#loop.schedule()
        }
      }),
    )
    this.#loop.onDispose(
      activity.subscribeWake(() => {
        this.#wake()
      }),
    )
    this.#loop.schedule()
  }

  dispose(): void {
    this.#loop.dispose()
  }

  #wake(): void {
    const now = this.#deps.clock.now()
    // A failed pass (`#fullScan` still set) retries on the next wake regardless.
    if (!this.#fullScan) {
      if (now - this.#lastWakeScan < WAKE_SCAN_INTERVAL_MS) {
        return
      }
      this.#trustUnchangedStat = true
    }
    this.#lastWakeScan = now
    this.#fullScan = true
    this.#loop.schedule()
  }

  async #pass(isStale: () => boolean): Promise<void | 'stop'> {
    const { indexLifecycle, logger, emitIndexed, reconcile } = this.#deps
    const { generation, indexGeneration } = this.#options
    const batch = [...this.#changed]
    const scanAll = this.#fullScan
    const reindexAll = this.#reindexCached
    const trustStat = this.#trustUnchangedStat
    this.#fullScan = false
    this.#reindexCached = false
    this.#trustUnchangedStat = false
    for (const path of batch) {
      this.#changed.delete(path)
    }
    try {
      const invalidated = await reconcile(generation, scanAll ? undefined : batch, {
        reindexCached: scanAll && reindexAll,
        trustUnchangedStat: scanAll && trustStat,
      })
      if (isStale()) {
        return
      }
      const affected = [...new Set([...batch, ...invalidated])]
      if (affected.length > 0 && indexGeneration !== null) {
        await indexLifecycle.reindexNotesReferencing(affected, {
          generation: indexGeneration,
          fileGeneration: generation,
        })
        if (!isStale()) {
          emitIndexed()
        }
      }
      this.#loggedError = null
    } catch (cause) {
      for (const path of batch) {
        this.#changed.add(path)
      }
      this.#fullScan = true
      this.#reindexCached = true
      const message = errorMessage(cause)
      if (!isStale() && this.#loggedError !== message) {
        this.#loggedError = message
        logger.warn('Local OCR maintenance failed:', message)
      }
      return 'stop'
    }
  }
}

class AssetOcrMaintenanceServiceImpl implements AssetOcrMaintenanceService {
  readonly #deps: AssetOcrMaintenanceServiceDeps

  constructor(deps: AssetOcrMaintenanceServiceDeps) {
    this.#deps = deps
  }

  async reconcile(
    generation: number,
    changed?: readonly string[],
    options: ReconcileAssetOcrOptions = {},
  ): Promise<string[]> {
    const { assetStore, noteFile, clock } = this.#deps
    const reindexCached = options.reindexCached ?? changed === undefined
    const trustUnchangedStat = options.trustUnchangedStat ?? false
    const references = changed ?? (await cachedAssetOcrPaths(assetStore, generation))
    const catalog = await noteFile.listAttachments(generation)
    const paths = [
      ...new Set(
        references.flatMap((reference) =>
          reference.includes('/')
            ? reference
            : catalog
                .filter((file) => assetReferenceMatches(reference, file.path))
                .map((file) => file.path),
        ),
      ),
    ]
    const metaByPath = new Map(catalog.map((file) => [file.path, file]))
    const invalidated: string[] = []
    for (const path of paths) {
      if (localOcrAssetTypeFor(path) === null) {
        continue
      }
      const cached = await readAssetOcrState(assetStore, path, generation)
      if (cached === null) {
        continue
      }
      if (cached.status === 'invalid') {
        if (reindexCached) {
          invalidated.push(path)
        }
        continue
      }
      if (reindexCached) {
        invalidated.push(path)
      }
      const meta = metaByPath.get(path)
      if (meta?.placeholder === true) {
        // iCloud-evicted: verifying would force a download. The OCR stays until
        // the file is local again, when its change event re-checks it.
        continue
      }
      if (
        trustUnchangedStat &&
        meta?.size === cached.sourceSize &&
        matchesTrustedMtime(cached.sourceModifiedMs, meta.modifiedMs, clock.now())
      ) {
        continue
      }
      let currentHash: string | null
      try {
        currentHash = await hashBytes(await assetStore.readBytesForDevice(path, generation))
      } catch (cause) {
        if (!isAppError(cause)) {
          throw cause
        }
        // Offline or otherwise unreadable right now: leave it for a later scan
        // rather than abort the rest of this one.
        if (cause.kind === 'io') {
          continue
        }
        if (
          cause.kind === 'notFound' ||
          cause.kind === 'traversal' ||
          cause.kind === 'unsupported'
        ) {
          currentHash = null
        } else {
          throw cause
        }
      }
      if (currentHash !== cached.sourceHash) {
        await invalidateLocalAssetOcr(assetStore, path, generation)
        if (!invalidated.includes(path)) {
          invalidated.push(path)
        }
      }
    }
    return invalidated
  }

  openSession(options: AssetOcrMaintenanceSessionOptions): AssetOcrMaintenanceSession {
    const { indexLifecycle, reconcilers, activity, clock, logger, emitIndexed } = this.#deps
    return new AssetOcrMaintenanceSessionImpl(
      {
        indexLifecycle,
        reconcilers,
        activity,
        clock,
        logger,
        emitIndexed,
        reconcile: (generation, changed, reconcileOptions) =>
          this.reconcile(generation, changed, reconcileOptions),
      },
      options,
    )
  }
}

export function createAssetOcrMaintenanceService(
  deps: AssetOcrMaintenanceServiceDeps,
): AssetOcrMaintenanceService {
  return new AssetOcrMaintenanceServiceImpl(deps)
}
