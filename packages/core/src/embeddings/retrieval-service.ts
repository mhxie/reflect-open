import { sql } from 'kysely'
import { AppError } from '../errors.ts'
import type { GraphSessionSource } from '../graph/graph-session.ts'
import type { LocalOnlyFolders } from '../graph/local-only.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import { literalSearchQuery } from '../indexing/filter-query.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START } from '../indexing/search.ts'
import { buildFtsAnyMatch, isSentenceLike } from '../indexing/search-query.ts'
import type { SearchService } from '../indexing/search-service.ts'
import { isPrivateNote } from '../privacy/privacy-service.ts'
import type { EmbeddingRuntimeService } from './embedding-runtime-service.ts'
import { semanticModel } from './models.ts'
import type { RetrievalHit } from './retrieval-hit.ts'

/**
 * The shared retrieval contract (Plan 09): one `retrieve()` for search and AI.
 * Lexical = FTS (title-boosted, every term; a sentence-long query fills up with
 * notes sharing the most of its words); semantic = embed the query, KNN over
 * chunks of the same model and the note's current snapshot, drop neighbors
 * past the model's noise cutoff, dedupe to best chunk per note; hybrid =
 * reciprocal rank fusion of the two (deterministic, no tuned weights). Private
 * notes stay locally recallable — `excludePrivateContent` strips their
 * *content* for callers that ship hits to external services (Plan 10),
 * enforced again at the AI boundary.
 */

export type { RetrievalHit } from './retrieval-hit.ts'

export interface RetrieveOptions {
  limit?: number
  mode?: 'semantic' | 'lexical' | 'hybrid'
  /**
   * AI callers set true: private hits keep title/flag but lose content.
   */
  excludePrivateContent?: boolean
  /**
   * Replace the embedding model's noise cutoff (its catalog
   * `maxCosineDistance`) with this cosine distance; `2` keeps every neighbor.
   * For calibrating a model, not for everyday callers.
   */
  maxDistance?: number
}

/**
 * Nearest chunks fetched per query. Several chunks of one note often crowd
 * the top, and {@link bestChunkPerNote} keeps one per note, so the candidate
 * pool must run well past the note count a caller asks for.
 */
const KNN_CANDIDATES = 100

/**
 * Nearest chunks per seed vector in {@link RetrievalService.relatedNotes}, which runs one query per seed.
 */
const RELATED_KNN_CANDIDATES = 24

export interface ChunkHitRow {
  path: string
  title: string
  displayTitle?: string | null
  lang?: string | null
  heading: string | null
  text: string
  isPrivate: number
  hasDeviceOnlyContent?: number
  assetTextHash?: string
  /**
   * The model that embedded the chunk; its catalog entry holds the noise cutoff.
   */
  modelId: string
  distance: number
}

export interface BestChunkOptions {
  /**
   * Drop this note: the seed note itself when the query came from its stored vectors.
   */
  excludePath?: string
  /**
   * Overrides each row's model cutoff (see {@link RetrieveOptions.maxDistance}).
   */
  maxDistance?: number
}

/**
 * A note's indexed snapshot as every retrieval leg reads it, flags already decoded.
 */
interface NoteSnapshot {
  path: string
  title: string
  displayTitle?: string | null | undefined
  lang?: string | null | undefined
  isPrivate: boolean
  hasDeviceOnlyContent: boolean
  assetTextHash?: string | undefined
}

/**
 * Build a hit from one leg's snapshot; optional flags appear only when set.
 */
function retrievalHit(
  note: NoteSnapshot,
  match: Pick<RetrievalHit, 'score' | 'snippet' | 'heading'>,
): RetrievalHit {
  return {
    path: note.path,
    title: note.title,
    displayTitle: note.displayTitle,
    lang: note.lang,
    ...match,
    isPrivate: note.isPrivate,
    ...(note.hasDeviceOnlyContent ? { hasDeviceOnlyContent: true } : {}),
    ...(note.assetTextHash === undefined ? {} : { assetTextHash: note.assetTextHash }),
  }
}

/**
 * Collapse KNN chunk rows (ordered nearest-first) into one hit per note —
 * the best chunk wins. Rows past their model's `maxCosineDistance` are
 * dropped rather than padded in (the `embedding_vectors` table's metric is
 * cosine, migration 0003, so vec0 distances threshold directly). The score is
 * cosine similarity for callers that want magnitudes.
 */
export function bestChunkPerNote(
  rows: readonly ChunkHitRow[],
  limit: number,
  options: BestChunkOptions = {},
): RetrievalHit[] {
  const byNote = new Map<string, RetrievalHit>()
  for (const row of rows) {
    if (row.distance > (options.maxDistance ?? semanticModel(row.modelId).maxCosineDistance)) {
      continue
    }
    if (row.path === options.excludePath || byNote.has(row.path)) {
      continue
    }
    byNote.set(
      row.path,
      retrievalHit(
        {
          ...row,
          isPrivate: row.isPrivate !== 0,
          hasDeviceOnlyContent:
            row.hasDeviceOnlyContent !== undefined && row.hasDeviceOnlyContent !== 0,
        },
        { score: 1 - row.distance, snippet: row.text.trim(), heading: row.heading },
      ),
    )
  }
  return [...byNote.values()].slice(0, limit)
}

/**
 * The standard reciprocal-rank-fusion damping constant.
 */
const RRF_K = 60

/**
 * Reciprocal rank fusion: order-based, scale-free, deterministic. A note's
 * privacy and device-only provenance survive from either leg, and hits of one
 * note from different attachment-text snapshots fuse as device-only.
 */
export function fuseRanked(lists: RetrievalHit[][], limit: number): RetrievalHit[] {
  const fused = new Map<string, { hit: RetrievalHit; score: number }>()
  for (const list of lists) {
    for (const [index, hit] of list.entries()) {
      const entry = fused.get(hit.path)
      const score = 1 / (RRF_K + index + 1)
      if (entry) {
        entry.score += score
        const isPrivate = entry.hit.isPrivate || hit.isPrivate
        const deviceOnly =
          entry.hit.hasDeviceOnlyContent ||
          hit.hasDeviceOnlyContent ||
          (entry.hit.assetTextHash !== undefined &&
            hit.assetTextHash !== undefined &&
            entry.hit.assetTextHash !== hit.assetTextHash)
        // Prefer a snippet-bearing form when one side lacks content.
        if (entry.hit.snippet === '' && hit.snippet !== '') {
          entry.hit = { ...hit }
        }
        entry.hit.isPrivate = isPrivate
        if (deviceOnly) {
          entry.hit.hasDeviceOnlyContent = true
        }
      } else {
        fused.set(hit.path, { hit: { ...hit }, score })
      }
    }
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ hit, score }) => ({ ...hit, score }))
}

/**
 * Fused hits tagged with the leg(s) that found each one ({@link RetrievalHit.matchedBy}).
 */
export function withMatchedBy(
  fused: readonly RetrievalHit[],
  lexical: readonly RetrievalHit[],
  semantic: readonly RetrievalHit[],
): RetrievalHit[] {
  const lexicalPaths = new Set(lexical.map((hit) => hit.path))
  const semanticPaths = new Set(semantic.map((hit) => hit.path))
  return fused.map((hit) => ({
    ...hit,
    matchedBy: !semanticPaths.has(hit.path)
      ? 'lexical'
      : lexicalPaths.has(hit.path)
        ? 'both'
        : 'semantic',
  }))
}

/**
 * Strip private notes' content while keeping the hit + flag. `localOnly` is
 * the open graph's local-only folders; with no graph open (`null`) every hit
 * counts as private.
 */
function withPrivacy(
  localOnly: LocalOnlyFolders | null,
  hits: RetrievalHit[],
  excludePrivateContent: boolean,
): RetrievalHit[] {
  if (!excludePrivateContent) {
    return hits
  }
  return hits.map((hit) => {
    return localOnly === null || isPrivateNote(localOnly, hit)
      ? { ...hit, snippet: '', heading: null }
      : hit
  })
}

/**
 * KNN result lists from several seed vectors, merged nearest-first so
 * {@link bestChunkPerNote} keeps each note's best distance across seeds.
 */
export function mergeNearestFirst(lists: ReadonlyArray<readonly ChunkHitRow[]>): ChunkHitRow[] {
  return lists.flat().sort((a, b) => a.distance - b.distance)
}

/**
 * Seed-vector cap for {@link RetrievalService.relatedNotes}: one KNN query runs per seed, so
 * a pathological note (a huge import) must not turn every sidebar refetch
 * into hundreds of queries. Sixteen seeds cover ~16k chars of note text —
 * past any real daily note — before later topics stop influencing neighbors.
 */
const MAX_RELATED_SEEDS = 16

/**
 * The one retrieval contract that search and AI share (Plan 09).
 */
export interface RetrievalService {
  /**
   * The notes matching `query`. `lexical` is FTS, `semantic` is KNN over the
   * chunk vectors of the loaded model, and `hybrid` (the default) fuses both,
   * tagging each hit with the leg that found it; a failing semantic leg
   * degrades `hybrid` to lexical. At most `limit` hits (default 12). Semantic
   * search needs the runtime `ready`; only chunks embedded from a note's
   * current Markdown and attachment-text snapshot match. With
   * `excludePrivateContent`, the content of every hit that must stay on the
   * device (flagged, device-only, or inside one of the open graph's
   * local-only folders) is stripped.
   */
  retrieve(query: string, options?: RetrieveOptions): Promise<RetrievalHit[]>
  /**
   * Semantic neighbors of an existing note, seeded by its own **stored** chunk
   * vectors — no re-embedding, no pane-provided seed text: the embedding sync
   * keeps chunks current on every save, so a call always reads the note as it
   * was last embedded. Callers own their own refresh cadence (the desktop panel
   * computes once per note per session); this is a read, and a costly one.
   * Every chunk seeds its own
   * KNN pass (capped at {@link MAX_RELATED_SEEDS}) and the lists merge
   * nearest-first, so a multi-topic note — a daily note above all — surfaces
   * neighbors for anything written in it, not just its lead paragraph.
   * Returns [] when the note has no vectors yet (model never enabled, or not
   * yet embedded). Candidates past the model's noise cutoff are dropped
   * rather than padded in, so a sparse graph shows few (or no) neighbors
   * instead of wrong ones.
   */
  relatedNotes(path: string, limit?: number): Promise<RetrievalHit[]>
}

export interface RetrievalServiceDeps {
  readonly database: DatabaseService
  readonly search: SearchService
  readonly embeddingRuntime: EmbeddingRuntimeService
  readonly graphSession: GraphSessionSource
  readonly logger: LoggerService
}

class RetrievalServiceImpl implements RetrievalService {
  readonly #deps: RetrievalServiceDeps

  constructor(deps: RetrievalServiceDeps) {
    this.#deps = deps
  }

  async retrieve(query: string, options?: RetrieveOptions): Promise<RetrievalHit[]> {
    const localOnly = this.#deps.graphSession.getState().session?.localOnly ?? null
    const limit = options?.limit ?? 12
    const mode = options?.mode ?? 'hybrid'
    const excludePrivateContent = options?.excludePrivateContent ?? false
    const maxDistance = options?.maxDistance

    let hits: RetrievalHit[]
    if (mode === 'lexical') {
      hits = await this.#lexicalHits(query, limit)
    } else if (mode === 'semantic') {
      hits = await this.#semanticHits(query, limit, maxDistance)
    } else {
      // Hybrid degrades, never breaks: a failing semantic leg (embed error, vec
      // query error — even while the runtime claims ready) must not take
      // lexical search down with it. A failing lexical leg is a real error and
      // throws.
      const [lexical, semantic] = await Promise.all([
        this.#lexicalHits(query, limit),
        this.#semanticHits(query, limit, maxDistance).catch((cause): RetrievalHit[] => {
          this.#deps.logger.error('semantic leg failed; serving lexical only:', cause)
          return []
        }),
      ])
      hits = withMatchedBy(fuseRanked([lexical, semantic], limit), lexical, semantic)
    }
    return withPrivacy(localOnly, hits.slice(0, limit), excludePrivateContent)
  }

  async relatedNotes(path: string, limit = 10): Promise<RetrievalHit[]> {
    const { database } = this.#deps
    const seeds = await sql<{ vec: string }>`
      SELECT vec_to_json(v.embedding) AS vec
      FROM embedding_chunks c
      JOIN embedding_vectors v ON v.rowid = c.id
      JOIN notes n ON n.path = c.note_path
      WHERE c.note_path = ${path}
        AND c.source_hash = n.file_hash AND c.asset_text_hash = n.asset_text_hash
      ORDER BY c.pos_from
      LIMIT ${MAX_RELATED_SEEDS}
    `.execute(database.db)
    if (seeds.rows.length === 0) {
      return []
    }
    const neighborLists = await Promise.all(
      seeds.rows.map(async (seed) => {
        const result = await sql<ChunkHitRow>`
          SELECT c.note_path AS path, n.title, n.display_title AS displayTitle, n.lang, c.heading, c.text,
                 (n.is_private OR c.is_private) AS isPrivate, n.has_device_only_content AS hasDeviceOnlyContent, n.asset_text_hash AS assetTextHash, c.model_id AS modelId, v.distance
          FROM embedding_vectors v
          JOIN embedding_chunks c ON c.id = v.rowid
          JOIN notes n ON n.path = c.note_path
          WHERE v.embedding MATCH ${seed.vec} AND k = ${RELATED_KNN_CANDIDATES}
            AND c.source_hash = n.file_hash AND c.asset_text_hash = n.asset_text_hash
            AND n.is_private = 0
          ORDER BY v.distance
        `.execute(database.db)
        return result.rows
      }),
    )
    return bestChunkPerNote(mergeNearestFirst(neighborLists), limit, { excludePath: path })
  }

  async #semanticHits(
    query: string,
    limit: number,
    maxDistance: number | undefined,
  ): Promise<RetrievalHit[]> {
    const { database, embeddingRuntime } = this.#deps
    const status = await embeddingRuntime.status()
    if (status.status !== 'ready') {
      throw new AppError('io', 'embedding model is not loaded')
    }
    const [vector] = await embeddingRuntime.embedTexts([query], 'query', status.model)
    const result = await sql<ChunkHitRow>`
      SELECT c.note_path AS path, n.title, n.display_title AS displayTitle, n.lang, c.heading, c.text,
             (n.is_private OR c.is_private) AS isPrivate, n.has_device_only_content AS hasDeviceOnlyContent, n.asset_text_hash AS assetTextHash, c.model_id AS modelId, v.distance
      FROM embedding_vectors v
      JOIN embedding_chunks c ON c.id = v.rowid
      JOIN notes n ON n.path = c.note_path
      WHERE v.embedding MATCH ${JSON.stringify(vector)} AND k = ${KNN_CANDIDATES}
        AND c.source_hash = n.file_hash AND c.asset_text_hash = n.asset_text_hash
      ORDER BY v.distance
    `.execute(database.db)
    // Right after a model switch, until the table is refitted, it still holds
    // the previous model's vectors; at the same width they compare without error
    // but mean nothing to this query.
    const sameModel = result.rows.filter((row) => row.modelId === status.model)
    return bestChunkPerNote(sameModel, limit, maxDistance === undefined ? {} : { maxDistance })
  }

  async #lexicalHits(query: string, limit: number): Promise<RetrievalHit[]> {
    // Literal on purpose: retrieve() receives raw text (often from AI callers,
    // Plan 10) where palette filter tokens like "is:daily" inside a sentence
    // must stay search terms, not become constraints.
    const everyTerm = await this.#everyTermHits(query, limit)
    if (everyTerm.length >= limit || !isSentenceLike(query)) {
      return everyTerm
    }
    // A sentence rarely has every term in one note: fill the rest with the
    // notes that share the most, and rarest, of its words. A few keywords stay
    // strict, where a partial match is mostly noise.
    const anyTerm = await this.#anyTermHits(
      query,
      limit - everyTerm.length,
      new Set(everyTerm.map((hit) => hit.path)),
    )
    // Scores stay rank order; raw bm25 scores are not comparable across legs.
    return [...everyTerm, ...anyTerm].map((hit, index) => ({ ...hit, score: 1 / (1 + index) }))
  }

  /**
   * The palette's search: every term must match, title matches first. The
   * hits carry their privacy flags from the same index snapshot as the snippet.
   */
  async #everyTermHits(query: string, limit: number): Promise<RetrievalHit[]> {
    const hits = await this.#deps.search.searchWithFilters(literalSearchQuery(query), { limit })
    return hits.map((hit, index) => {
      return retrievalHit(hit, {
        score: 1 / (1 + index), // FTS rank order; raw bm25 scores are not exposed
        snippet: hit.snippet ?? '',
        heading: null,
      })
    })
  }

  /**
   * Notes matching any word or CJK pair of `query`, best bm25 first, skipping `exclude`.
   */
  async #anyTermHits(
    query: string,
    limit: number,
    exclude: ReadonlySet<string>,
  ): Promise<RetrievalHit[]> {
    const match = buildFtsAnyMatch(query)
    if (match === null) {
      return []
    }
    const result = await sql<{
      path: string
      title: string
      displayTitle: string | null
      lang: string | null
      snippet: string
      isPrivate: number
      hasDeviceOnlyContent: number
      assetTextHash: string
    }>`
      SELECT search_fts.path AS path, n.title AS title, n.display_title AS displayTitle, n.lang,
             snippet(search_fts, 2, ${HIGHLIGHT_START}, ${HIGHLIGHT_END}, '…', 10) AS snippet,
             n.is_private AS isPrivate, n.has_device_only_content AS hasDeviceOnlyContent, n.asset_text_hash AS assetTextHash
      FROM search_fts
      JOIN notes n ON n.path = search_fts.path
      WHERE search_fts MATCH ${match} AND n.kind != 'template'
      ORDER BY bm25(search_fts, 0, 10.0, 1.0, 1.0)
      LIMIT ${limit + exclude.size}
    `.execute(this.#deps.database.db)
    return result.rows
      .filter((row) => !exclude.has(row.path))
      .slice(0, limit)
      .map((row) => {
        return retrievalHit(
          {
            ...row,
            isPrivate: row.isPrivate !== 0,
            hasDeviceOnlyContent: row.hasDeviceOnlyContent !== 0,
          },
          { score: 0, snippet: row.snippet, heading: null },
        )
      })
  }
}

export function createRetrievalService(deps: RetrievalServiceDeps): RetrievalService {
  return new RetrievalServiceImpl(deps)
}
