import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import { createFanOut, listenNow, type FanOut, type IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'

/**
 * Event name the Rust watcher emits tracked-file changes on.
 */
export const FILE_CHANGES_EVENT = 'index:changed'

/**
 * Event name the Rust watcher emits when only a full reconcile can tell what
 * changed: a visible folder was created, renamed, or removed, and no platform
 * enumerates its descendants per file. Carries no payload.
 */
export const RECONCILE_EVENT = 'index:reconcile'

const fileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['upsert', 'remove']),
  /**
   * The file's last-modified time (epoch ms), present on upserts. The re-index
   * path stamps `notes.mtime` from it; removes (and older payloads) omit it.
   */
  modifiedMs: z.number().optional(),
  /**
   * Set by a write that kept the file's modification time (the AI summary
   * block): the indexed mtime still matches, so the re-index path reads the
   * file anyway. The watcher never sets it.
   */
  reread: z.boolean().optional(),
})
const fileChangesSchema = z.array(fileChangeSchema)
const voidSchema = z.null()

/**
 * A single tracked change.
 */
export type FileChange = z.infer<typeof fileChangeSchema>

/**
 * Where a batch came from. Most consumers ignore it; the ones that must tell
 * this device's own writes from everything else (the sync engine's dirty
 * mark, the iCloud shadow base) branch on it instead of guessing from
 * timing or content.
 *
 * - `external`: observed on disk by the Rust watcher or the iCloud metadata
 *   query: another app, another device, or an echo of our own write.
 * - `own-write`: a write this app just made (the mobile write echo, a
 *   conflict resolution).
 * - `pull`: files a Git pull wrote.
 * - `icloud-sweep`: files the iCloud conflict sweep wrote.
 */
export type FileChangeSource = 'external' | 'own-write' | 'pull' | 'icloud-sweep'

/**
 * One delivery on the file-change stream.
 */
export interface FileChangeBatch {
  changes: FileChange[]
  source: FileChangeSource
}

/**
 * One stream of "files changed" for the open graph: the native watcher's
 * events merged with batches produced in-process, each tagged with its
 * {@link FileChangeSource}.
 */
export interface FileChangeService {
  /**
   * Receive every batch: the watcher's {@link FILE_CHANGES_EVENT} (validated,
   * tagged `external`) and every batch passed to {@link emit}. All
   * subscribers share one native registration.
   */
  subscribe(listener: (batch: FileChangeBatch) => void): Unlisten
  /**
   * Receive the watcher's coarse reconcile demands. The listener should run
   * the ordinary full index refresh; the pass is content-hash gated, so
   * over-asking costs a listing, not a re-parse.
   */
  subscribeReconcile(listener: () => void): Unlisten
  /**
   * Receive the paths of this device's own note and asset writes as they
   * land, on every platform and whatever `echoOwnWrites` says: a note embed
   * showing a note written here reloads without waiting for the watcher.
   */
  subscribeOwnWrites(listener: (paths: readonly string[]) => void): Unlisten
  /**
   * Fan an in-process batch to every {@link subscribe} listener, exactly as
   * if the watcher had reported it. Writes a sync pull applies must reach
   * open editors and the index even before the watcher runs.
   */
  emit(batch: FileChangeBatch): void
  /**
   * Report changes a write command just made, after the write has landed.
   * Own-write listeners always hear the paths; the change stream hears the
   * batch (tagged `own-write`) only when `echoOwnWrites` is on, and otherwise
   * only its `reread` changes, whose kept modification time makes the
   * watcher's own report of the write read as already indexed.
   */
  reportOwnWrite(changes: readonly FileChange[]): void
  /**
   * Start (or restart) the native watcher for the active graph.
   */
  startWatcher(): MaybePromise<void>
  /**
   * Stop the native watcher.
   */
  stopWatcher(): MaybePromise<void>
}

export interface FileChangeServiceDeps {
  readonly ipc: IpcBridgeService
  readonly logger: LoggerService
  /**
   * Echo own writes onto the change stream. Hosts without a file watcher
   * (mobile) turn it on, so the derived layer sees local writes the way the
   * desktop watcher reports them.
   */
  readonly echoOwnWrites: boolean
}

class FileChangeServiceImpl implements FileChangeService {
  readonly #deps: FileChangeServiceDeps
  readonly #ownWriteListeners = new Set<(paths: readonly string[]) => void>()
  readonly #batches: FanOut<FileChangeBatch>

  constructor(deps: FileChangeServiceDeps) {
    this.#deps = deps
    // Every subscriber shares one native registration; the payload is parsed once.
    this.#batches = createFanOut<FileChangeBatch>((emit) => {
      return this.#listenNative(FILE_CHANGES_EVENT, (payload) => {
        const parsed = fileChangesSchema.safeParse(payload)
        if (parsed.success) {
          emit({ changes: parsed.data, source: 'external' })
        } else {
          // The Rust and TS event contract drifted: loud beats silently stale
          // indexes and editors.
          deps.logger.error(`invalid ${FILE_CHANGES_EVENT} payload:`, parsed.error)
        }
      })
    })
  }

  subscribe(listener: (batch: FileChangeBatch) => void): Unlisten {
    return this.#batches.subscribe(listener)
  }

  subscribeReconcile(listener: () => void): Unlisten {
    return this.#listenNative(RECONCILE_EVENT, () => {
      listener()
    })
  }

  subscribeOwnWrites(listener: (paths: readonly string[]) => void): Unlisten {
    const deliver = (paths: readonly string[]): void => {
      listener(paths)
    }
    this.#ownWriteListeners.add(deliver)
    return () => {
      this.#ownWriteListeners.delete(deliver)
    }
  }

  emit(batch: FileChangeBatch): void {
    this.#batches.emit(batch)
  }

  reportOwnWrite(changes: readonly FileChange[]): void {
    const { logger, echoOwnWrites } = this.#deps
    const paths = changes.map((change) => change.path)
    for (const listener of this.#ownWriteListeners) {
      try {
        listener(paths)
      } catch (error) {
        // One failing observer must not break the echo for everyone.
        logger.error('own-write observer failed:', error)
      }
    }
    const echoed = echoOwnWrites ? [...changes] : changes.filter((change) => change.reread === true)
    if (echoed.length > 0) {
      this.#batches.emit({ changes: echoed, source: 'own-write' })
    }
  }

  async startWatcher(): Promise<void> {
    await this.#deps.ipc.call('watch_start', {}, voidSchema)
  }

  async stopWatcher(): Promise<void> {
    await this.#deps.ipc.call('watch_stop', {}, voidSchema)
  }

  #listenNative(event: string, handler: (payload: unknown) => void): Unlisten {
    const { ipc, logger } = this.#deps
    return listenNow(
      () => ipc.listen(event, handler),
      (cause) => {
        logger.warn(`failed to listen for "${event}"`, cause)
      },
    )
  }
}

export function createFileChangeService(deps: FileChangeServiceDeps): FileChangeService {
  return new FileChangeServiceImpl(deps)
}
