import { sha256Hex } from '@reflect/utils'
import { z } from 'zod'
import type { ClockService } from '../ports/clock-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'
import { isLocalOnlyPath, type LocalOnlyFolders } from '../graph/local-only.ts'
import type { LocalNoteRead, NoteFileService } from '../graph/note-file-service.ts'
import { isNotePath, isTemplatePath } from '../graph/paths.ts'
import {
  createAssetDescriptionText,
  foldAssetDescriptionBodies,
  type AssetDescriptionText,
} from '../indexing/asset-description-text.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import { parseNote } from '../markdown/index.ts'
import { chunkAssetDescriptions, chunkNote, type NoteChunk } from './chunk.ts'
import type { EmbeddingRuntimeService } from './embedding-runtime-service.ts'

/**
 * The incremental embedding pass (Plan 09): chunk a note, diff chunk hashes
 * against the stored rows, embed only what changed, and apply as one
 * generation-pinned write. TS owns this orchestration (Rust supplies
 * `embed_texts` + the table writes), mirroring the indexing pipeline.
 *
 * A note's chunk set also carries its referenced assets' description bodies
 * (Plan 20 → semantic leg), mirroring the FTS fold — so a meaning-level query
 * about an image or PDF's contents surfaces the referencing note on the
 * semantic side of hybrid retrieval, not just on keyword matches.
 */

export interface EmbedNoteOptions {
  path: string
  /**
   * The index generation the chunk write carries.
   */
  generation: number
  /**
   * The file generation the note and asset description reads carry.
   */
  fileGeneration: number
  /**
   * The model recorded per vector (from the runtime's `ready` status).
   */
  modelId: string
  /**
   * The graph's local-only folders: a chunk of a note inside one is private.
   */
  localOnly: LocalOnlyFolders
  /**
   * Pre-loaded content (the watcher path has it); read from disk if absent.
   */
  content?: string
}

/**
 * Bump when {@link passageText} changes shape: every stored vector then
 * re-embeds, because the hash of what it was computed from no longer matches.
 */
export const PASSAGE_VERSION = 1

/**
 * Passages per `embedTexts` call: the runtime's own batch size (`MODEL_BATCH_SIZE`).
 */
const EMBED_CALL_SIZE = 8

/**
 * The text a chunk is embedded as: the note's title and the chunk's heading
 * ahead of its own text, so a chunk deep in a note still says what the note
 * is about. The stored chunk text (the hit's snippet) stays the raw chunk.
 */
export function passageText(title: string, chunk: Pick<NoteChunk, 'heading' | 'text'>): string {
  const context = [title.trim(), chunk.heading?.trim() ?? ''].filter(Boolean).join(' › ')
  return context === '' ? chunk.text : `${context}\n\n${chunk.text}`
}

/**
 * One chunk in the `embed_apply` payload; `vector` only for new/changed.
 */
export interface EmbedChunkPayload {
  heading: string | null
  posFrom: number
  posTo: number
  text: string
  /**
   * The hash of what the vector was computed from: the versioned passage text.
   */
  contentHash: string
  modelId: string
  vector: number[] | null
  /**
   * Privacy of the source snapshot, retained even if a later note projection is public.
   */
  isPrivate: boolean
  /**
   * The exact Markdown snapshot this chunk came from (`notes.file_hash`).
   */
  sourceHash: string
  /**
   * The folded attachment text snapshot this chunk came from (`notes.asset_text_hash`).
   */
  assetTextHash: string
}

/**
 * How a backfill ended: every note visited, stopped by `signal`, or the note list unreadable.
 */
export type EmbeddingBackfillResult = 'completed' | 'aborted' | 'failed'

export interface EmbeddingBackfillOptions {
  generation: number
  fileGeneration: number
  modelId: string
  /**
   * The graph's local-only folders (see {@link EmbedNoteOptions.localOnly}).
   */
  localOnly: LocalOnlyFolders
  onProgress?: (done: number, total: number) => void
  /**
   * Abort between notes (e.g. graph switch).
   */
  signal?: AbortSignal
}

/**
 * What {@link EmbeddingIndexService.follow} keeps embedded.
 */
export interface EmbeddingFollowOptions {
  generation: number
  fileGeneration: number
  modelId: string
  /**
   * The width of `modelId`'s vectors: the table is refitted to it before the backfill.
   */
  dims: number
  /**
   * The graph's local-only folders (see {@link EmbedNoteOptions.localOnly}).
   */
  localOnly: LocalOnlyFolders
  /**
   * Called with the backfill's position after each note (see
   * {@link EmbeddingBackfillOptions.onProgress}), never once the follow has stopped.
   */
  onProgress?: (done: number, total: number) => void
  /**
   * Runs the backfill (`backfill`) and resolves with its outcome, e.g. inside
   * a native activity that keeps a hidden window's pass from being throttled.
   * Without it the backfill runs as is.
   */
  runBackfill?: (
    backfill: () => Promise<EmbeddingBackfillResult>,
  ) => Promise<EmbeddingBackfillResult>
}

/**
 * Keeps each note's chunk vectors current (Plan 09).
 */
export interface EmbeddingIndexService {
  /**
   * Bring one note's embeddings up to date. Returns the number of chunks that
   * were (re)embedded — 0 means the hash-skip caught everything.
   */
  embedNote(options: EmbedNoteOptions): Promise<number>
  /**
   * Drop a deleted note's chunks + vectors (generation-pinned).
   */
  removeNote(path: string, generation: number): Promise<void>
  /**
   * Fit the vector table to the loaded model before embedding into it:
   * another model's vectors are dropped and the table recreated at `dims`
   * (index-generation-pinned). Resolves `true` when it reset anything.
   */
  prepareIndex(model: string, dims: number, generation: number): Promise<boolean>
  /**
   * Backfill every indexed note (initial enable, repair). Serialized; the
   * hash-skip makes re-runs cheap. Reports per-note progress. One note's
   * failure is logged and the pass goes on; the pass never rejects.
   */
  backfill(options: EmbeddingBackfillOptions): Promise<EmbeddingBackfillResult>
  /**
   * Keep the index at `generation` embedded with `modelId`, reading files at
   * `fileGeneration`, until the returned function is called: the vector table
   * refitted to the model (a model switch drops the other model's vectors),
   * one backfill, then every applied index batch (changed notes re-embed,
   * removed notes drop their vectors). The work runs on one serial queue that
   * outlives each call, so passes never interleave; work still queued when the
   * follow stops is skipped.
   *
   * The trigger is the post-apply signal, not the raw watcher stream.
   * Ordering: `embed_apply` drops chunks for paths without a `notes` row, so
   * embedding a brand-new note off the raw file event could race its index
   * apply and lose the chunks until the next backfill; post-apply, the row is
   * always there. Coverage: asset description writes re-index their
   * referencing notes *outside* the watcher pipeline and emit the same
   * signal, and those notes must re-embed for the description text to reach
   * semantic search.
   */
  follow(options: EmbeddingFollowOptions): Unlisten
}

const voidSchema = z.null()

export interface EmbeddingIndexServiceDeps {
  readonly ipc: IpcBridgeService
  readonly embeddingRuntime: EmbeddingRuntimeService
  readonly noteFile: NoteFileService
  readonly assetStore: AssetStoreService
  readonly database: DatabaseService
  readonly indexLifecycle: IndexLifecycleService
  readonly logger: LoggerService
  readonly clock: ClockService
}

/**
 * What one backfill pass did, for its summary log line.
 */
interface BackfillCounts {
  notes: number
  done: number
  notesEmbedded: number
  chunksEmbedded: number
  failed: number
}

class EmbeddingIndexServiceImpl implements EmbeddingIndexService {
  readonly #deps: EmbeddingIndexServiceDeps
  readonly #assetDescriptionText: AssetDescriptionText
  #queue: Promise<void> = Promise.resolve()

  constructor(deps: EmbeddingIndexServiceDeps) {
    this.#deps = deps
    this.#assetDescriptionText = createAssetDescriptionText({
      noteFile: deps.noteFile,
      assetStore: deps.assetStore,
    })
  }

  async embedNote(options: EmbedNoteOptions): Promise<number> {
    const { embeddingRuntime, noteFile, database } = this.#deps
    const { path, generation, fileGeneration, modelId, localOnly } = options
    if (isTemplatePath(path)) {
      return 0 // templates are boilerplate — never embedded, never retrieved
    }
    let content = options.content
    let sourceLocalOnly = false
    if (content === undefined) {
      let read: LocalNoteRead
      try {
        read = await noteFile.readLocal(path, fileGeneration)
      } catch {
        return 0 // deleted between event and read; the remove path handles it
      }
      if (read.kind === 'evicted') {
        // iCloud-evicted: reading would force an on-demand download, and the
        // backfill sweeping a whole evicted graph would turn into thousands of
        // serial blocking downloads. The pre-eviction vectors stay valid (rows
        // survive eviction) until a model switch refits the table. A note that
        // re-materializes with new content re-embeds in the index-applied
        // follow-up; unchanged, it waits for the next backfill (one per open).
        return 0
      }
      content = read.content
      sourceLocalOnly = read.localOnly
    }

    const parsed = parseNote({ path, source: content })
    const gathered = await this.#assetDescriptionText.gatherBodies(
      parsed.assets.map((asset) => asset.path),
      { notePath: path, fileGeneration, localOnly },
    )
    if (gathered.evicted.length > 0) {
      // A referenced sidecar is iCloud-evicted. `embed_apply` replaces the
      // note's *entire* chunk set, so applying without that sidecar's body
      // would silently drop its previously embedded chunks — and sidecars are
      // untracked by the watcher, so nothing would ever restore them. Skip the
      // whole note this pass; the stored vectors stay valid until the sidecar
      // is local again.
      return 0
    }
    const chunks = [
      ...(await chunkNote(path, content, parsed)),
      ...(await chunkAssetDescriptions(gathered.bodies, content.length + 1)),
    ]
    if (chunks.length === 0) {
      await this.removeNote(path, generation)
      return 0
    }

    // What each chunk is embedded as, hashed: the stored hash tracks the input
    // its vector came from, so a renamed note or heading re-embeds too.
    const passages = chunks.map((chunk) => passageText(parsed.title, chunk))
    const passageHashes = await Promise.all(
      passages.map((passage) => sha256Hex(`${PASSAGE_VERSION}\n${passage}`)),
    )
    // Stored hash+model pairs, **counted**: duplicate identical sections mean
    // several chunks can share one hash, and only as many may skip embedding as
    // there are stored rows to pair with (apply_chunks pairs one row per
    // skipped chunk — an unmatched skip is a loud error). A model change makes
    // every chunk "new", so a model switch re-embeds with no extra bookkeeping.
    const existing = await database.db
      .selectFrom('embeddingChunks')
      .where('notePath', '=', path)
      .select(['contentHash', 'modelId'])
      .execute()
    const available = new Map<string, number>()
    for (const row of existing) {
      const key = `${row.modelId} ${row.contentHash}`
      available.set(key, (available.get(key) ?? 0) + 1)
    }

    const skip = passageHashes.map((hash) => {
      const key = `${modelId} ${hash}`
      const remaining = available.get(key) ?? 0
      if (remaining > 0) {
        available.set(key, remaining - 1)
        return true
      }
      return false
    })
    const toEmbed = passages.filter((_, i) => skip[i] !== true)
    const vectors: number[][] = []
    // One call per few chunks: the model serves one call at a time, so a search
    // typed during a long note's re-embed waits for a batch, not the whole note.
    // Naming the model makes the runtime refuse if another one loaded since
    // `modelId` was read.
    for (let at = 0; at < toEmbed.length; at += EMBED_CALL_SIZE) {
      vectors.push(
        ...(await embeddingRuntime.embedTexts(
          toEmbed.slice(at, at + EMBED_CALL_SIZE),
          'passage',
          modelId,
        )),
      )
    }
    let vectorAt = 0
    const sourceHash = await sha256Hex(content)
    const assetTextHash = await sha256Hex(foldAssetDescriptionBodies(gathered.bodies))
    const isPrivate =
      sourceLocalOnly ||
      parsed.frontmatter.private ||
      isLocalOnlyPath(localOnly, path) ||
      gathered.bodies.some((entry) => entry.deviceOnly === true)

    const payload: EmbedChunkPayload[] = chunks.map((chunk, i) => ({
      heading: chunk.heading,
      posFrom: chunk.posFrom,
      posTo: chunk.posTo,
      text: chunk.text,
      contentHash: passageHashes[i]!,
      modelId,
      sourceHash,
      assetTextHash,
      isPrivate,
      // A non-skipped chunk always has a freshly-embedded vector: `vectors` is
      // exactly as long as the non-skipped chunks, consumed in order here.
      vector: skip[i] === true ? null : vectors[vectorAt++]!,
    }))
    await this.#applyChunks(path, payload, generation)
    return toEmbed.length
  }

  async removeNote(path: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('embed_remove', { path, generation }, voidSchema)
  }

  async prepareIndex(model: string, dims: number, generation: number): Promise<boolean> {
    return await this.#deps.ipc.call(
      'embed_prepare_index',
      { model, dims, generation },
      z.boolean(),
    )
  }

  async backfill(options: EmbeddingBackfillOptions): Promise<EmbeddingBackfillResult> {
    const { clock, logger } = this.#deps
    const started = clock.monotonicNow()
    const counts: BackfillCounts = {
      notes: 0,
      done: 0,
      notesEmbedded: 0,
      chunksEmbedded: 0,
      failed: 0,
    }
    let outcome: EmbeddingBackfillResult
    try {
      outcome = await this.#backfillNotes(options, counts)
    } catch {
      outcome = 'failed'
    }
    logger.info('embedding backfill finished', {
      outcome,
      modelId: options.modelId,
      generation: options.generation,
      ...counts,
      elapsedMs: clock.monotonicNow() - started,
    })
    return outcome
  }

  follow(options: EmbeddingFollowOptions): Unlisten {
    const { indexLifecycle, logger } = this.#deps
    const { generation, fileGeneration, modelId, dims, localOnly, onProgress, runBackfill } =
      options
    const stopped = new AbortController()

    this.#queue = this.#queue
      .then(async () => {
        if (stopped.signal.aborted) {
          return
        }
        // A model switch first refits the vector table to the new width.
        await this.prepareIndex(modelId, dims, generation)
        if (stopped.signal.aborted) {
          return
        }
        const backfill = (): Promise<EmbeddingBackfillResult> => {
          return this.backfill({
            generation,
            fileGeneration,
            modelId,
            localOnly,
            signal: stopped.signal,
            ...(onProgress === undefined
              ? {}
              : {
                  // The note in flight when the follow stops still lands; its
                  // position is no longer this follow's to report.
                  onProgress: (done: number, total: number) => {
                    if (!stopped.signal.aborted) {
                      onProgress(done, total)
                    }
                  },
                }),
          })
        }
        await (runBackfill === undefined ? backfill() : runBackfill(backfill))
      })
      .catch((cause: unknown) => {
        // A rejection here must not poison the queue (later change items
        // chain off this promise) nor masquerade as a per-change failure.
        logger.error('embedding backfill failed:', cause)
      })

    const unlisten = indexLifecycle.onApplied((event) => {
      if (stopped.signal.aborted || event.generation !== generation || event.changes === null) {
        return // torn down, a delayed emit from a superseded index session, or a sync pass
      }
      for (const change of event.changes) {
        if (!isNotePath(change.path)) {
          continue // asset-file changes ride the same batches — never embedded
        }
        this.#queue = this.#queue
          .then(() => {
            if (stopped.signal.aborted) {
              return
            }
            return change.kind === 'remove'
              ? this.removeNote(change.path, generation)
              : this.embedNote({
                  path: change.path,
                  generation,
                  fileGeneration,
                  modelId,
                  localOnly,
                }).then(() => {})
          })
          .catch((cause: unknown) => {
            logger.error(`embedding sync failed for ${change.path}:`, cause)
          })
      }
    })

    return () => {
      stopped.abort()
      unlisten()
    }
  }

  /**
   * Replace a note's chunk set (hash-diff applied in Rust; generation-pinned).
   * Rust drops a set whose source hashes no longer match the note's row.
   */
  async #applyChunks(path: string, chunks: EmbedChunkPayload[], generation: number): Promise<void> {
    await this.#deps.ipc.call('embed_apply', { path, chunks, generation }, voidSchema)
  }

  async #backfillNotes(
    options: EmbeddingBackfillOptions,
    counts: BackfillCounts,
  ): Promise<'completed' | 'aborted'> {
    const { database, logger } = this.#deps
    const { generation, fileGeneration, modelId, localOnly, onProgress, signal } = options
    const rows = await database.db
      .selectFrom('notes')
      .where('kind', '!=', 'template')
      .select('path')
      .orderBy('path')
      .execute()
    counts.notes = rows.length
    for (const row of rows) {
      if (signal?.aborted === true) {
        return 'aborted'
      }
      try {
        const chunks = await this.embedNote({
          path: row.path,
          generation,
          fileGeneration,
          modelId,
          localOnly,
        })
        if (chunks > 0) {
          counts.notesEmbedded += 1
          counts.chunksEmbedded += chunks
        }
      } catch (cause) {
        counts.failed += 1
        logger.error(`embedding backfill failed for ${row.path}:`, cause)
      }
      counts.done += 1
      onProgress?.(counts.done, rows.length)
    }
    return 'completed'
  }
}

export function createEmbeddingIndexService(
  deps: EmbeddingIndexServiceDeps,
): EmbeddingIndexService {
  return new EmbeddingIndexServiceImpl(deps)
}
