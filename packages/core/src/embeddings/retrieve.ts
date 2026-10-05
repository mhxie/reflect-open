import { sql } from 'kysely'
import { ReflectError } from '../errors.ts'
import { db } from '../indexing/db.ts'
import { searchWithFilters } from '../indexing/filtered-search.ts'
import { literalSearchQuery } from '../indexing/filter-query.ts'
import { HIGHLIGHT_END, HIGHLIGHT_START } from '../indexing/search.ts'
import { buildFtsAnyMatch, isSentenceLike } from '../indexing/search-query.ts'
import { embedStatus, embedTexts } from './commands.ts'
import { semanticModel } from './models.ts'

/**
 * The shared retrieval contract (Plan 09): one `retrieve()` for search and AI.
 * Lexical = FTS (title-boosted); semantic = embed the query, KNN over chunks,
 * drop neighbors past the noise cutoff, dedupe to best chunk per note;
 * hybrid = reciprocal rank fusion of the two
 * (deterministic, no tuned weights). Private notes stay locally recallable —
 * `excludePrivateContent` strips their *content* for callers that ship hits to
 * external services (Plan 10), enforced again at the AI boundary.
 */

export interface RetrievalHit {
  path: string
  title: string
  score: number
  /** Chunk text (semantic) or highlight-markered FTS snippet (lexical). */
  snippet: string
  heading: string | null
  isPrivate: boolean
  hasConflict: boolean
  /** Hybrid only: which leg found the note — wording, meaning, or both. */
  matchedBy?: 'lexical' | 'semantic' | 'both'
}

export interface RetrieveOptions {
  limit?: number
  mode?: 'semantic' | 'lexical' | 'hybrid'
  /** AI callers set true: private hits keep title/flag but lose content. */
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

/** Nearest chunks per seed vector in {@link relatedNotes}, which runs one query per seed. */
const RELATED_KNN_CANDIDATES = 24

export interface ChunkHitRow {
  path: string
  title: string
  heading: string | null
  text: string
  isPrivate: number
  hasConflict: number
  /** The model that embedded the chunk; its catalog entry holds the noise cutoff. */
  modelId: string
  distance: number
}

export interface BestChunkOptions {
  /** Drop this note: the seed note itself when the query came from its stored vectors. */
  excludePath?: string
  /** Overrides each row's model cutoff (see {@link RetrieveOptions.maxDistance}). */
  maxDistance?: number
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
    byNote.set(row.path, {
      path: row.path,
      title: row.title,
      score: 1 - row.distance,
      snippet: row.text.trim(),
      heading: row.heading,
      isPrivate: row.isPrivate !== 0,
      hasConflict: row.hasConflict !== 0,
    })
  }
  return [...byNote.values()].slice(0, limit)
}

async function semanticHits(
  query: string,
  limit: number,
  maxDistance: number | undefined,
): Promise<RetrievalHit[]> {
  const status = await embedStatus()
  if (status.status !== 'ready') {
    throw new ReflectError('io', 'embedding model is not loaded')
  }
  const [vector] = await embedTexts([query], 'query')
  const result = await sql<ChunkHitRow>`
    SELECT c.note_path AS path, n.title, c.heading, c.text,
           n.is_private AS isPrivate, n.has_conflict AS hasConflict, c.model_id AS modelId, v.distance
    FROM embedding_vectors v
    JOIN embedding_chunks c ON c.id = v.rowid
    JOIN notes n ON n.path = c.note_path
    WHERE v.embedding MATCH ${JSON.stringify(vector)} AND k = ${KNN_CANDIDATES}
    ORDER BY v.distance
  `.execute(db)
  // Right after a model switch, until the table is refitted, it still holds
  // the previous model's vectors; at the same width they compare without error
  // but mean nothing to this query.
  const sameModel = result.rows.filter((row) => row.modelId === status.model)
  return bestChunkPerNote(sameModel, limit, maxDistance === undefined ? {} : { maxDistance })
}

async function lexicalHits(query: string, limit: number): Promise<RetrievalHit[]> {
  // Literal on purpose: retrieve() receives raw text (often from AI callers,
  // Plan 10) where palette filter tokens like "is:daily" inside a sentence
  // must stay search terms, not become constraints.
  const everyTerm = await everyTermHits(query, limit)
  if (everyTerm.length >= limit || !isSentenceLike(query)) {
    return everyTerm
  }
  // A sentence rarely has every term in one note: fill the rest with the
  // notes that share the most, and rarest, of its words. A few keywords stay
  // strict, where a partial match is mostly noise.
  const anyTerm = await anyTermHits(
    query,
    limit - everyTerm.length,
    new Set(everyTerm.map((hit) => hit.path)),
  )
  // Scores stay rank order; raw bm25 scores are not comparable across legs.
  return [...everyTerm, ...anyTerm].map((hit, index) => ({ ...hit, score: 1 / (1 + index) }))
}

/** The palette's search: every term must match, title matches first. */
async function everyTermHits(query: string, limit: number): Promise<RetrievalHit[]> {
  const hits = await searchWithFilters(literalSearchQuery(query), { limit })
  if (hits.length === 0) {
    return []
  }
  const flags = await db
    .selectFrom('notes')
    .where(
      'path',
      'in',
      hits.map((hit) => hit.path),
    )
    .select(['path', 'isPrivate', 'hasConflict'])
    .execute()
  const flagsByPath = new Map(flags.map((row) => [row.path, row]))
  return hits.map((hit) => ({
    path: hit.path,
    title: hit.title,
    score: 0,
    snippet: hit.snippet ?? '',
    heading: null,
    isPrivate: (flagsByPath.get(hit.path)?.isPrivate ?? 0) !== 0,
    hasConflict: (flagsByPath.get(hit.path)?.hasConflict ?? 0) !== 0,
  }))
}

/** Notes matching any word or CJK pair of `query`, best bm25 first, skipping `exclude`. */
async function anyTermHits(
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
    snippet: string
    isPrivate: number
    hasConflict: number
  }>`
    SELECT search_fts.path AS path, n.title AS title,
           snippet(search_fts, 2, ${HIGHLIGHT_START}, ${HIGHLIGHT_END}, '…', 10) AS snippet,
           n.is_private AS isPrivate, n.has_conflict AS hasConflict
    FROM search_fts
    JOIN notes n ON n.path = search_fts.path
    WHERE search_fts MATCH ${match} AND n.kind != 'template'
    ORDER BY bm25(search_fts, 0, 10.0, 1.0, 1.0)
    LIMIT ${limit + exclude.size}
  `.execute(db)
  return result.rows
    .filter((row) => !exclude.has(row.path))
    .slice(0, limit)
    .map((row) => ({
      path: row.path,
      title: row.title,
      score: 0,
      snippet: row.snippet,
      heading: null,
      isPrivate: row.isPrivate !== 0,
      hasConflict: row.hasConflict !== 0,
    }))
}

/** Reciprocal rank fusion: order-based, scale-free, deterministic. */
export function fuseRanked(lists: RetrievalHit[][], limit: number): RetrievalHit[] {
  const K = 60 // the standard RRF damping constant
  const fused = new Map<string, { hit: RetrievalHit; score: number }>()
  for (const list of lists) {
    for (const [index, hit] of list.entries()) {
      const entry = fused.get(hit.path)
      const score = 1 / (K + index + 1)
      if (entry) {
        entry.score += score
        // Prefer a snippet-bearing form when one side lacks content.
        if (entry.hit.snippet === '' && hit.snippet !== '') {
          entry.hit = { ...hit }
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

/** Fused hits tagged with the leg(s) that found each one ({@link RetrievalHit.matchedBy}). */
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

/** Strip private notes' content while keeping the hit + flag. */
function withPrivacy(hits: RetrievalHit[], excludePrivateContent: boolean): RetrievalHit[] {
  if (!excludePrivateContent) {
    return hits
  }
  return hits.map((hit) => (hit.isPrivate ? { ...hit, snippet: '', heading: null } : hit))
}

export async function retrieve(query: string, options?: RetrieveOptions): Promise<RetrievalHit[]> {
  const limit = options?.limit ?? 12
  const mode = options?.mode ?? 'hybrid'
  const excludePrivateContent = options?.excludePrivateContent ?? false
  const maxDistance = options?.maxDistance

  let hits: RetrievalHit[]
  if (mode === 'lexical') {
    hits = await lexicalHits(query, limit)
  } else if (mode === 'semantic') {
    hits = await semanticHits(query, limit, maxDistance)
  } else {
    // Hybrid degrades, never breaks: a failing semantic leg (embed error, vec
    // query error — even while the runtime claims ready) must not take
    // lexical search down with it. A failing lexical leg is a real error and
    // throws.
    const [lexical, semantic] = await Promise.all([
      lexicalHits(query, limit),
      semanticHits(query, limit, maxDistance).catch((cause): RetrievalHit[] => {
        console.error('semantic leg failed; serving lexical only:', cause)
        return []
      }),
    ])
    hits = withMatchedBy(fuseRanked([lexical, semantic], limit), lexical, semantic)
  }
  return withPrivacy(hits.slice(0, limit), excludePrivateContent)
}

/**
 * KNN result lists from several seed vectors, merged nearest-first so
 * {@link bestChunkPerNote} keeps each note's best distance across seeds.
 */
export function mergeNearestFirst(lists: ReadonlyArray<readonly ChunkHitRow[]>): ChunkHitRow[] {
  return lists.flat().sort((a, b) => a.distance - b.distance)
}

/**
 * Seed-vector cap for {@link relatedNotes}: one KNN query runs per seed, so
 * a pathological note (a huge import) must not turn every sidebar refetch
 * into hundreds of queries. Sixteen seeds cover ~16k chars of note text —
 * past any real daily note — before later topics stop influencing neighbors.
 */
const MAX_RELATED_SEEDS = 16

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
 * yet embedded). Candidates past the model's noise cutoff are dropped rather
 * than padded in, so a sparse graph shows few (or no) neighbors instead of
 * wrong ones.
 */
export async function relatedNotes(path: string, limit = 10): Promise<RetrievalHit[]> {
  const seeds = await sql<{ vec: string }>`
    SELECT vec_to_json(v.embedding) AS vec
    FROM embedding_chunks c
    JOIN embedding_vectors v ON v.rowid = c.id
    WHERE c.note_path = ${path}
    ORDER BY c.pos_from
    LIMIT ${MAX_RELATED_SEEDS}
  `.execute(db)
  if (seeds.rows.length === 0) {
    return []
  }
  const neighborLists = await Promise.all(
    seeds.rows.map(async (seed) => {
      const result = await sql<ChunkHitRow>`
        SELECT c.note_path AS path, n.title, c.heading, c.text,
               n.is_private AS isPrivate, n.has_conflict AS hasConflict, c.model_id AS modelId, v.distance
        FROM embedding_vectors v
        JOIN embedding_chunks c ON c.id = v.rowid
        JOIN notes n ON n.path = c.note_path
        WHERE v.embedding MATCH ${seed.vec} AND k = ${RELATED_KNN_CANDIDATES}
          AND n.is_private = 0
        ORDER BY v.distance
      `.execute(db)
      return result.rows
    }),
  )
  return bestChunkPerNote(mergeNearestFirst(neighborLists), limit, { excludePath: path })
}
