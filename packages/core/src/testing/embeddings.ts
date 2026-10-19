import type { MaybePromise } from '@reflect/utils'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { SettingsService } from '../settings/settings-service.ts'
import type { StorageService } from '../ports/storage-service.ts'
import type { NativeActivityService } from '../app/native-activity-service.ts'
import type { GraphRole } from '../graph/graph-session.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import {
  createEmbeddingIndexService,
  type EmbedChunkPayload,
  type EmbedNoteOptions,
  type EmbeddingBackfillOptions,
  type EmbeddingBackfillResult,
  type EmbeddingFollowOptions,
  type EmbeddingIndexService,
} from '../embeddings/embedding-index-service.ts'
import {
  createEmbeddingRuntimeService,
  type EmbeddingRuntimeService,
  type EmbedStatus,
  type EmbedTextRole,
} from '../embeddings/embedding-runtime-service.ts'
import type {
  RetrievalHit,
  RetrievalService,
  RetrieveOptions,
} from '../embeddings/retrieval-service.ts'
import {
  createSemanticSearchService,
  type SemanticIndexProgress,
  type SemanticSearchGraphSource,
  type SemanticSearchService,
} from '../embeddings/semantic-search-service.ts'
import { AppError } from '../errors.ts'
import type { Unlisten } from '../unlisten.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import { createTestDatabaseService } from './database.ts'
import { createTestAssetStoreService, createTestNoteFileService } from './graph.ts'
import { createTestGraphSessionService } from './graph-session.ts'
import { createTestIndexLifecycleService } from './index-lifecycle.ts'
import { createTestIpcBridgeService, type TestIpcBridgeService } from './ipc.ts'
import { createTestClockService } from './clock.ts'
import { createTestLoggerService } from './logger.ts'
import { createTestSettingsService } from './settings.ts'
import { createTestStorageService } from './storage.ts'

export interface TestEmbeddingRuntimeServiceOptions {
  /**
   * The runtime status. Defaults to `ready` with model `all-MiniLM-L6-v2` (384 dims).
   */
  status?: EmbedStatus
  /**
   * The vector for one text. Defaults to a 384-dim unit vector.
   */
  vectors?: (text: string) => number[]
}

/**
 * One `embedTexts` request as the runtime received it.
 */
export interface TestEmbedRequest {
  readonly texts: readonly string[]
  readonly role: EmbedTextRole
  /**
   * The model the caller expects loaded, or `null` for whatever is.
   */
  readonly model: string | null
}

export interface TestEmbeddingRuntimeService extends EmbeddingRuntimeService {
  /**
   * Change the runtime status and emit it as a status event.
   */
  setStatus(status: EmbedStatus): void
  /**
   * The `texts` of every `embedTexts` call, in order.
   */
  embedCalls(): readonly (readonly string[])[]
  /**
   * Every `embedTexts` call with its role and expected model, in order.
   */
  embedRequests(): readonly TestEmbedRequest[]
  /**
   * How many times `ensure` ran.
   */
  ensureCalls(): number
  /**
   * The model each `ensure` asked for (`null`: the runtime's default), in order.
   */
  ensuredModels(): readonly (string | null)[]
}

const DIMENSIONS = 384

function unitVector(): number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0)
  vector[0] = 1
  return vector
}

class TestEmbeddingRuntimeServiceImpl implements TestEmbeddingRuntimeService {
  readonly #inner: EmbeddingRuntimeService
  readonly #ipc: TestIpcBridgeService
  readonly #embedded: TestEmbedRequest[] = []
  readonly #ensured: (string | null)[] = []
  #status: EmbedStatus

  constructor(options?: TestEmbeddingRuntimeServiceOptions) {
    this.#status = options?.status ?? {
      status: 'ready',
      model: 'all-MiniLM-L6-v2',
      dims: DIMENSIONS,
    }
    const vectors = options?.vectors ?? unitVector
    this.#ipc = createTestIpcBridgeService({
      commands: {
        embed_status: () => this.#status,
        embed_ensure: (args) => {
          this.#ensured.push(typeof args['model'] === 'string' ? args['model'] : null)
          return this.#status
        },
        embed_texts: (args) => {
          if (this.#status.status !== 'ready') {
            throw new AppError('unknown', `embedding model is ${this.#status.status}`)
          }
          const model = typeof args['model'] === 'string' ? args['model'] : null
          if (model !== null && model !== this.#status.model) {
            // The native runtime refuses another model's vectors under `model`.
            throw new AppError('invalid', `the loaded embedding model is not ${model}`)
          }
          const texts = Array.isArray(args['texts']) ? args['texts'].map(String) : []
          this.#embedded.push({
            texts,
            role: args['role'] === 'query' ? 'query' : 'passage',
            model,
          })
          return texts.map((text) => vectors(text))
        },
      },
    })
    this.#inner = createEmbeddingRuntimeService({
      ipc: this.#ipc,
      logger: createTestLoggerService(),
    })
  }

  status(): Promise<EmbedStatus> {
    return this.#inner.status()
  }

  ensure(model?: string): Promise<EmbedStatus> {
    return this.#inner.ensure(model)
  }

  awaitTerminalStatus(initial: EmbedStatus): Promise<EmbedStatus> {
    return this.#inner.awaitTerminalStatus(initial)
  }

  retry(model?: string): Promise<EmbedStatus> {
    return this.#inner.retry(model)
  }

  embedTexts(texts: readonly string[], role?: EmbedTextRole, model?: string): Promise<number[][]> {
    return this.#inner.embedTexts(texts, role, model)
  }

  subscribe(listener: (status: EmbedStatus) => void): Unlisten {
    return this.#inner.subscribe(listener)
  }

  lastStatus(): EmbedStatus {
    return this.#inner.lastStatus()
  }

  setStatus(next: EmbedStatus): void {
    this.#status = next
    this.#ipc.emit('embed:status', next)
  }

  embedCalls(): readonly (readonly string[])[] {
    return this.#embedded.map((request) => [...request.texts])
  }

  embedRequests(): readonly TestEmbedRequest[] {
    return [...this.#embedded]
  }

  ensureCalls(): number {
    return this.#ensured.length
  }

  ensuredModels(): readonly (string | null)[] {
    return [...this.#ensured]
  }
}

/**
 * The real {@link EmbeddingRuntimeService} over a scripted runtime. `ensure`
 * answers the current status without loading anything: drive loads with
 * `setStatus`. `embedTexts` rejects unless the status is `ready`, like the
 * native runtime.
 */
export function createTestEmbeddingRuntimeService(
  options?: TestEmbeddingRuntimeServiceOptions,
): TestEmbeddingRuntimeService {
  return new TestEmbeddingRuntimeServiceImpl(options)
}

export interface TestRetrievalServiceOptions {
  /**
   * Answers `retrieve`. Defaults to no hits.
   */
  retrieve?: (query: string, options?: RetrieveOptions) => MaybePromise<RetrievalHit[]>
  /**
   * Answers `relatedNotes`. Defaults to no neighbors.
   */
  relatedNotes?: (path: string, limit?: number) => MaybePromise<RetrievalHit[]>
}

export interface TestRetrievalService extends RetrievalService {
  /**
   * Every `retrieve` call, in order.
   */
  retrieveCalls(): readonly { readonly query: string; readonly options?: RetrieveOptions }[]
  /**
   * Every `relatedNotes` call, in order.
   */
  relatedNotesCalls(): readonly { readonly path: string; readonly limit?: number }[]
}

class TestRetrievalServiceImpl implements TestRetrievalService {
  readonly #options: TestRetrievalServiceOptions | undefined
  readonly #retrieveLog: { query: string; options?: RetrieveOptions }[] = []
  readonly #relatedLog: { path: string; limit?: number }[] = []

  constructor(options?: TestRetrievalServiceOptions) {
    this.#options = options
  }

  async retrieve(query: string, retrieveOptions?: RetrieveOptions): Promise<RetrievalHit[]> {
    this.#retrieveLog.push(
      retrieveOptions === undefined ? { query } : { query, options: retrieveOptions },
    )
    return (await this.#options?.retrieve?.(query, retrieveOptions)) ?? []
  }

  async relatedNotes(path: string, limit?: number): Promise<RetrievalHit[]> {
    this.#relatedLog.push(limit === undefined ? { path } : { path, limit })
    return (await this.#options?.relatedNotes?.(path, limit)) ?? []
  }

  retrieveCalls(): readonly { readonly query: string; readonly options?: RetrieveOptions }[] {
    return [...this.#retrieveLog]
  }

  relatedNotesCalls(): readonly { readonly path: string; readonly limit?: number }[] {
    return [...this.#relatedLog]
  }
}

/**
 * A scripted {@link RetrievalService}: the real one needs the vector
 * extension of the Node test database, which browser tests do not have.
 */
export function createTestRetrievalService(
  options?: TestRetrievalServiceOptions,
): TestRetrievalService {
  return new TestRetrievalServiceImpl(options)
}

/**

 * One recorded `embed_apply`: the complete new chunk set of a note.

 */
export interface TestEmbeddingApply {
  readonly path: string
  readonly chunks: readonly EmbedChunkPayload[]
  readonly generation: number
}

/**

 * One recorded `embed_remove`.

 */
export interface TestEmbeddingRemove {
  readonly path: string
  readonly generation: number
}

/**
 * One recorded `embed_prepare_index`: the vector table fitted to a model.
 */
export interface TestEmbeddingPrepare {
  readonly model: string
  readonly dims: number
  readonly generation: number
}

/**

 * The services a test embedding index runs on; each defaults to a fresh test double.

 */
export interface TestEmbeddingIndexServiceOptions {
  embeddingRuntime?: EmbeddingRuntimeService
  noteFile?: NoteFileService
  assetStore?: AssetStoreService
  /**
   * Read lazily, so the default (Node only) costs nothing until a note is embedded.
   */
  database?: DatabaseService
  indexLifecycle?: IndexLifecycleService
  logger?: LoggerService
  clock?: ClockService
  /**
   * Write applied and removed chunk sets into `database` as the native
   * writer does, so later passes and retrieval read them back. Needs a
   * database that accepts writes (the Node test database). Defaults to
   * `false`: writes are only recorded.
   */
  storeChunks?: boolean
  /**
   * Answers `backfill` calls in place of the real pass; a `follow` still runs the real one.
   */
  backfill?: (options: EmbeddingBackfillOptions) => Promise<EmbeddingBackfillResult>
  /**
   * Called before a chunk set is written. A returned `Error`
   * rejects the write with it, unrecorded.
   */
  failApply?: (apply: TestEmbeddingApply) => Error | undefined
  /**
   * What `embed_prepare_index` answers: whether it reset the table. Defaults to `false`.
   */
  prepareResets?: boolean
}

export interface TestEmbeddingIndexService extends EmbeddingIndexService {
  /**
   * Every chunk set that `embed_apply` wrote, in order.
   */
  applied(): readonly TestEmbeddingApply[]
  /**
   * Every `embed_remove`, in order, including the one an emptied note causes.
   */
  removed(): readonly TestEmbeddingRemove[]
  /**
   * Every `embed_prepare_index`, in order, including the one a `follow` runs.
   */
  prepares(): readonly TestEmbeddingPrepare[]
  /**
   * The `generation` and `modelId` of every `backfill` call, in order. The
   * backfill a `follow` starts is not a call.
   */
  backfills(): readonly { readonly generation: number; readonly modelId: string }[]
  /**
   * The `generation` and `modelId` of every `follow` call, in order.
   */
  follows(): readonly { readonly generation: number; readonly modelId: string }[]
}

interface StoredChunkRow {
  id: number
  content_hash: string
}

/**
 * A boolean as SQLite stores it.
 */
function sqliteFlag(value: boolean): number {
  return value ? 1 : 0
}

/**

 * `apply_chunks` of the native writer, over `database`.

 */
async function storeChunks(
  database: DatabaseService,
  path: string,
  chunks: readonly EmbedChunkPayload[],
): Promise<void> {
  const notes = (await database.runQuery('SELECT 1 FROM notes WHERE path = ?', [path])) as unknown[]
  if (notes.length === 0) {
    await dropChunks(database, path)
    return
  }
  const existing = (await database.runQuery(
    'SELECT id, content_hash FROM embedding_chunks WHERE note_path = ? ORDER BY pos_from',
    [path],
  )) as StoredChunkRow[]
  for (const chunk of chunks) {
    if (chunk.vector === null) {
      const at = existing.findIndex((row) => row.content_hash === chunk.contentHash)
      const row = existing[at]
      if (row === undefined) {
        throw new AppError('parse', `unchanged chunk has no stored row (hash ${chunk.contentHash})`)
      }
      existing.splice(at, 1)
      await database.runQuery(
        `UPDATE embedding_chunks
         SET heading = ?, pos_from = ?, pos_to = ?, model_id = ?, is_private = ?, source_hash = ?,
             asset_text_hash = ?
         WHERE id = ?`,
        [
          chunk.heading,
          chunk.posFrom,
          chunk.posTo,
          chunk.modelId,
          sqliteFlag(chunk.isPrivate),
          chunk.sourceHash,
          chunk.assetTextHash,
          row.id,
        ],
      )
      continue
    }
    const inserted = (await database.runQuery(
      `INSERT INTO embedding_chunks
         (note_path, heading, pos_from, pos_to, text, content_hash, model_id, is_private,
          source_hash, asset_text_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      [
        path,
        chunk.heading,
        chunk.posFrom,
        chunk.posTo,
        chunk.text,
        chunk.contentHash,
        chunk.modelId,
        sqliteFlag(chunk.isPrivate),
        chunk.sourceHash,
        chunk.assetTextHash,
      ],
    )) as { id: number }[]
    await database.runQuery('INSERT INTO embedding_vectors(rowid, embedding) VALUES (?, ?)', [
      BigInt(inserted[0]!.id),
      JSON.stringify(chunk.vector),
    ])
  }
  for (const row of existing) {
    await database.runQuery('DELETE FROM embedding_vectors WHERE rowid = ?', [row.id])
    await database.runQuery('DELETE FROM embedding_chunks WHERE id = ?', [row.id])
  }
}

/**

 * `remove_chunks` of the native writer, over `database`.

 */
async function dropChunks(database: DatabaseService, path: string): Promise<void> {
  await database.runQuery(
    'DELETE FROM embedding_vectors WHERE rowid IN (SELECT id FROM embedding_chunks WHERE note_path = ?)',
    [path],
  )
  await database.runQuery('DELETE FROM embedding_chunks WHERE note_path = ?', [path])
}

class TestEmbeddingIndexServiceImpl implements TestEmbeddingIndexService {
  readonly #inner: EmbeddingIndexService
  readonly #backfillOverride: TestEmbeddingIndexServiceOptions['backfill']
  readonly #applyLog: TestEmbeddingApply[] = []
  readonly #removeLog: TestEmbeddingRemove[] = []
  readonly #prepareLog: TestEmbeddingPrepare[] = []
  readonly #backfillLog: { generation: number; modelId: string }[] = []
  readonly #followLog: { generation: number; modelId: string }[] = []

  constructor(options?: TestEmbeddingIndexServiceOptions) {
    const database = options?.database ?? createTestDatabaseService()
    this.#backfillOverride = options?.backfill
    const ipc = createTestIpcBridgeService({
      commands: {
        embed_apply: async (args) => {
          const apply = args as unknown as TestEmbeddingApply
          const failure = options?.failApply?.(apply)
          if (failure !== undefined) {
            throw failure
          }
          this.#applyLog.push(apply)
          if (options?.storeChunks === true) {
            await storeChunks(database, apply.path, apply.chunks)
          }
          return null
        },
        embed_remove: async (args) => {
          const remove = args as unknown as TestEmbeddingRemove
          this.#removeLog.push(remove)
          if (options?.storeChunks === true) {
            await dropChunks(database, remove.path)
          }
          return null
        },
        embed_prepare_index: (args) => {
          this.#prepareLog.push(args as unknown as TestEmbeddingPrepare)
          return options?.prepareResets ?? false
        },
      },
    })
    this.#inner = createEmbeddingIndexService({
      ipc,
      embeddingRuntime: options?.embeddingRuntime ?? createTestEmbeddingRuntimeService(),
      noteFile: options?.noteFile ?? createTestNoteFileService(),
      assetStore: options?.assetStore ?? createTestAssetStoreService(),
      database,
      indexLifecycle: options?.indexLifecycle ?? createTestIndexLifecycleService({ database }),
      logger: options?.logger ?? createTestLoggerService(),
      clock: options?.clock ?? createTestClockService(),
    })
  }

  embedNote(options: EmbedNoteOptions): Promise<number> {
    return this.#inner.embedNote(options)
  }

  removeNote(path: string, generation: number): Promise<void> {
    return this.#inner.removeNote(path, generation)
  }

  prepareIndex(model: string, dims: number, generation: number): Promise<boolean> {
    return this.#inner.prepareIndex(model, dims, generation)
  }

  backfill(backfillOptions: EmbeddingBackfillOptions): Promise<EmbeddingBackfillResult> {
    this.#backfillLog.push({
      generation: backfillOptions.generation,
      modelId: backfillOptions.modelId,
    })
    return this.#backfillOverride?.(backfillOptions) ?? this.#inner.backfill(backfillOptions)
  }

  follow(followOptions: EmbeddingFollowOptions): Unlisten {
    this.#followLog.push({ generation: followOptions.generation, modelId: followOptions.modelId })
    return this.#inner.follow(followOptions)
  }

  applied(): readonly TestEmbeddingApply[] {
    return [...this.#applyLog]
  }

  removed(): readonly TestEmbeddingRemove[] {
    return [...this.#removeLog]
  }

  prepares(): readonly TestEmbeddingPrepare[] {
    return [...this.#prepareLog]
  }

  backfills(): readonly { readonly generation: number; readonly modelId: string }[] {
    return [...this.#backfillLog]
  }

  follows(): readonly { readonly generation: number; readonly modelId: string }[] {
    return [...this.#followLog]
  }
}

/**
 * The real {@link EmbeddingIndexService} over test doubles, recording every
 * native chunk write.
 */
export function createTestEmbeddingIndexService(
  options?: TestEmbeddingIndexServiceOptions,
): TestEmbeddingIndexService {
  return new TestEmbeddingIndexServiceImpl(options)
}

/**

 * The services a test semantic search runs on; each defaults to a fresh test double.

 */
export interface TestSemanticSearchServiceOptions {
  embeddingRuntime?: EmbeddingRuntimeService
  embeddingIndex?: EmbeddingIndexService
  retrieval?: RetrievalService
  settings?: SettingsService
  storage?: StorageService
  /**
   * Holds the native activity around a backfill; defaults to running the work as is.
   */
  nativeActivity?: NativeActivityService
  role?: GraphRole
  indexLifecycle?: IndexLifecycleService
  graphSession?: SemanticSearchGraphSource
  logger?: LoggerService
}

export interface TestSemanticSearchService extends SemanticSearchService {
  /**
   * How many `start` calls have not been stopped yet.
   */
  running(): number
  /**
   * Report `progress` as the running backfill's position (`null`: none runs)
   * and notify subscribers, as a backfill would. The next position a real
   * backfill publishes replaces it.
   */
  setIndexProgress(progress: SemanticIndexProgress | null): void
}

class TestSemanticSearchServiceImpl implements TestSemanticSearchService {
  readonly #inner: SemanticSearchService
  readonly #listeners = new Set<() => void>()
  // What `setIndexProgress` reported, until the inner service publishes again.
  #reported: { readonly progress: SemanticIndexProgress | null } | null = null
  #running = 0

  constructor(inner: SemanticSearchService) {
    this.#inner = inner
    // Subscribed first, so every other listener already reads the real position.
    inner.subscribe(() => {
      this.#reported = null
    })
  }

  readonly subscribe = (listener: () => void): Unlisten => {
    // Wrapped for identity, so one function added twice detaches independently.
    const deliver = (): void => {
      listener()
    }
    this.#listeners.add(deliver)
    const unlisten = this.#inner.subscribe(deliver)
    return () => {
      this.#listeners.delete(deliver)
      unlisten()
    }
  }

  readonly getIndexProgress = (): SemanticIndexProgress | null =>
    this.#reported === null ? this.#inner.getIndexProgress() : this.#reported.progress

  setIndexProgress(progress: SemanticIndexProgress | null): void {
    this.#reported = { progress }
    this.#notify()
  }

  start(): Unlisten {
    const stop = this.#inner.start()
    this.#running += 1
    let stopped = false
    return () => {
      if (!stopped) {
        stopped = true
        this.#running -= 1
      }
      stop()
    }
  }

  ensureModel(): Promise<EmbedStatus> {
    return this.#inner.ensureModel()
  }

  retryFailedModel(): Promise<void> {
    return this.#inner.retryFailedModel()
  }

  similarNotes(path: string): Promise<RetrievalHit[]> {
    return this.#inner.similarNotes(path)
  }

  dispose(): void {
    this.#inner.dispose()
  }

  running(): number {
    return this.#running
  }

  #notify(): void {
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

/**

 * The real {@link SemanticSearchService} over test doubles.

 */
export function createTestSemanticSearchService(
  options?: TestSemanticSearchServiceOptions,
): TestSemanticSearchService {
  const embeddingRuntime = options?.embeddingRuntime ?? createTestEmbeddingRuntimeService()
  const indexLifecycle = options?.indexLifecycle ?? createTestIndexLifecycleService()
  const logger = options?.logger ?? createTestLoggerService()
  return new TestSemanticSearchServiceImpl(
    createSemanticSearchService({
      embeddingRuntime,
      embeddingIndex:
        options?.embeddingIndex ??
        createTestEmbeddingIndexService({ embeddingRuntime, indexLifecycle, logger }),
      retrieval: options?.retrieval ?? createTestRetrievalService(),
      settings: options?.settings ?? createTestSettingsService(),
      storage: options?.storage ?? createTestStorageService(),
      nativeActivity: options?.nativeActivity ?? { run: (_reason, work) => work() },
      role: options?.role ?? 'main',
      indexLifecycle,
      graphSession:
        options?.graphSession ?? createTestGraphSessionService({ indexLifecycle, logger }),
      logger,
    }),
  )
}
