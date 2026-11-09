import { sha256Hex } from '@reflect/utils'
import { describe, expect, it } from 'vitest'
import { NO_LOCAL_ONLY_FOLDERS } from '../graph/local-only.ts'
import { literalSearchQuery } from '../indexing/filter-query.ts'
import {
  createNodeTestDatabaseService,
  createTestEmbeddingIndexService,
  createTestEmbeddingRuntimeService,
  createTestGraphSessionService,
  createTestLoggerService,
  createTestNoteFileService,
  seedNotes,
  type TestDatabaseQuery,
  type TestDatabaseService,
  type TestNote,
  type TestOpenGraph,
} from '../testing/index.ts'
import { createSearchService } from '../indexing/search-service.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import type { EmbedStatus } from './embedding-runtime-service.ts'
import {
  bestChunkPerNote,
  createRetrievalService,
  fuseRanked,
  mergeNearestFirst,
  withMatchedBy,
  type ChunkHitRow,
  type RetrievalHit,
} from './retrieval-service.ts'

const MODEL = 'all-MiniLM-L6-v2'
const GEMMA = 'embeddinggemma-300m'
const DIMENSIONS = 384

/**
 * A unit vector at `degrees` in the plane of the first two axes.
 */
function direction(degrees: number): number[] {
  const vector = Array.from({ length: DIMENSIONS }, () => 0)
  const radians = (degrees * Math.PI) / 180
  vector[0] = Math.cos(radians)
  vector[1] = Math.sin(radians)
  return vector
}

/**
 * Topics as directions, first match wins: texts about nearby topics embed to
 * nearby vectors, and `gardening` is past the noise cutoff of all others.
 */
const TOPICS: ReadonlyArray<{ word: string; degrees: number }> = [
  { word: 'secret', degrees: 10 },
  { word: 'rust', degrees: 0 },
  { word: 'compiler', degrees: 20 },
  { word: 'gardening', degrees: 120 },
]

function embed(text: string): number[] {
  const topic = TOPICS.find(({ word }) => text.toLowerCase().includes(word))
  return direction(topic?.degrees ?? 180)
}

const NOTES: readonly TestNote[] = [
  { path: 'notes/rust.md', markdown: '# Rust\n\nRust has a borrow checker.\n' },
  { path: 'notes/compilers.md', markdown: '# Compilers\n\nA compiler lowers source to code.\n' },
  { path: 'notes/garden.md', markdown: '# Garden\n\nGardening needs patience.\n' },
  {
    path: 'notes/secret.md',
    markdown: '---\nprivate: true\n---\n\n# Secret\n\nA private rust project.\n',
  },
]

/**
 * Notes for the any-term leg: only the exact note holds every word of {@link SENTENCE}.
 */
const WOMBAT_NOTES: readonly TestNote[] = [
  {
    path: 'notes/exact.md',
    markdown: '# Exact\n\nA sentence about wombat formats and their storage.\n',
  },
  {
    path: 'notes/related.md',
    markdown: '---\nprivate: true\n---\n\n# Related\n\nWombat storage hints.\n',
  },
  { path: 'notes/other.md', markdown: '# Other\n\nNothing in common.\n' },
]

const SENTENCE = 'a sentence about wombat formats and their storage'

/**
 * Index `notes` as the native indexer stamps them: each row's `file_hash` is
 * the hash of its Markdown, which an embedded chunk's `source_hash` must match.
 */
async function seedIndexed(database: TestDatabaseService, notes: readonly TestNote[]) {
  seedNotes(database, notes)
  for (const note of notes) {
    await database.runQuery('UPDATE notes SET file_hash = ? WHERE path = ?', [
      await sha256Hex(note.markdown),
      note.path,
    ])
  }
}

/**
 * The queries `database` ran while `work` did.
 */
async function queriesDuring(
  database: TestDatabaseService,
  work: () => Promise<unknown>,
): Promise<TestDatabaseQuery[]> {
  const before = database.getQueries().length
  await work()
  return database.getQueries().slice(before)
}

/**
 * Whether the any-term leg ran: it is the one query ordered by raw bm25.
 */
function ranAnyTerm(database: TestDatabaseService): boolean {
  return database.getQueries().some((query) => query.sql.includes('ORDER BY bm25('))
}

/**
 * A retrieval service over a graph of `notes` ({@link NOTES} by default),
 * embedded through the real pipeline with `modelId`.
 */
async function setup(options?: {
  status?: EmbedStatus
  embedded?: boolean
  notes?: readonly TestNote[]
  modelId?: string
  graph?: TestOpenGraph | null
}) {
  const notes = options?.notes ?? NOTES
  const modelId = options?.modelId ?? MODEL
  const database = createNodeTestDatabaseService()
  await seedIndexed(database, notes)
  const noteFile = createTestNoteFileService({
    files: Object.fromEntries(notes.map((note) => [note.path, note.markdown])),
  })
  const logger = createTestLoggerService()
  if (options?.embedded !== false) {
    const index = createTestEmbeddingIndexService({
      database,
      noteFile,
      embeddingRuntime: createTestEmbeddingRuntimeService({
        vectors: embed,
        status: { status: 'ready', model: modelId, dims: DIMENSIONS },
      }),
      storeChunks: true,
    })
    await expect(
      index.backfill({
        generation: 1,
        fileGeneration: 1,
        modelId,
        localOnly: NO_LOCAL_ONLY_FOLDERS,
      }),
    ).resolves.toBe('completed')
  }
  const runtime = createTestEmbeddingRuntimeService({
    vectors: embed,
    ...(options?.status === undefined ? {} : { status: options.status }),
  })
  const search = createSearchService({
    database,
    wikiResolver: createWikiResolverService({ database }),
  })
  const retrieval = createRetrievalService({
    database,
    search,
    embeddingRuntime: runtime,
    graphSession: createTestGraphSessionService({
      graph: options?.graph === undefined ? {} : options.graph,
    }),
    logger,
  })
  return { retrieval, search, runtime, logger, database }
}

describe('retrieve', () => {
  it('lexical mode ranks FTS matches and carries the snippet and the private flag', async () => {
    const { retrieval, runtime } = await setup()

    const hits = await retrieval.retrieve('borrow checker', { mode: 'lexical' })

    expect(hits.map((hit) => hit.path)).toEqual(['notes/rust.md'])
    expect(hits[0]).toMatchObject({ title: 'Rust', score: 1, heading: null, isPrivate: false })
    expect(hits[0]!.snippet).toContain('borrow')
    expect(runtime.embedCalls()).toEqual([]) // no vector work on the lexical leg
  })

  it('lexical mode treats filter tokens as plain search terms', async () => {
    const { retrieval } = await setup()

    // As a palette filter `is:daily` would exclude every note here.
    const hits = await retrieval.retrieve('is:daily rust', { mode: 'lexical' })

    expect(hits).toEqual([])
  })

  it('keeps device-only snippet provenance without a second index read', async () => {
    const { retrieval, search, database } = await setup({ embedded: false })
    await database.runQuery('UPDATE notes SET has_device_only_content = 1 WHERE path = ?', [
      'notes/rust.md',
    ])

    const hits = await retrieval.retrieve('borrow checker', { mode: 'lexical', limit: 1 })

    expect(hits[0]).toMatchObject({ path: 'notes/rust.md', hasDeviceOnlyContent: true })
    expect(hits[0]!.snippet).toContain('borrow')
    // The flags ride on the palette search's own hits: retrieval reads nothing more.
    const palette = await queriesDuring(database, () => {
      return search.searchWithFilters(literalSearchQuery('borrow checker'), { limit: 1 })
    })
    const retrieved = await queriesDuring(database, () => {
      return retrieval.retrieve('borrow checker', { mode: 'lexical', limit: 1 })
    })
    expect(retrieved.map((query) => query.sql)).toEqual(palette.map((query) => query.sql))
  })

  it('fills a sentence-long query with any-term matches after the every-term ones', async () => {
    const { retrieval, database } = await setup({ embedded: false, notes: WOMBAT_NOTES })

    const hits = await retrieval.retrieve(SENTENCE, { mode: 'lexical', limit: 3 })

    // The every-term hit leads and isn't repeated; the rest rank by bm25.
    expect(hits.map((hit) => [hit.path, hit.isPrivate])).toEqual([
      ['notes/exact.md', false],
      ['notes/related.md', true],
    ])
    expect(hits.map((hit) => hit.score)).toEqual([1, 0.5])
    expect(ranAnyTerm(database)).toBe(true)
  })

  it('skips the any-term leg when every term already filled the limit', async () => {
    const { retrieval, database } = await setup({ embedded: false, notes: WOMBAT_NOTES })

    const hits = await retrieval.retrieve(SENTENCE, { mode: 'lexical', limit: 1 })

    expect(hits.map((hit) => hit.path)).toEqual(['notes/exact.md'])
    expect(ranAnyTerm(database)).toBe(false)
  })

  it('keeps a few keywords strict: no partial matches fill the list', async () => {
    const { retrieval, database } = await setup({ embedded: false, notes: WOMBAT_NOTES })

    const hits = await retrieval.retrieve('wombat formats', { mode: 'lexical', limit: 3 })

    expect(hits.map((hit) => hit.path)).toEqual(['notes/exact.md'])
    expect(ranAnyTerm(database)).toBe(false)
  })

  it('preserves Private metadata from both lexical legs', async () => {
    const { retrieval, database } = await setup({ embedded: false, notes: WOMBAT_NOTES })
    await database.runQuery('UPDATE notes SET is_private = 1 WHERE path = ?', ['notes/exact.md'])

    const hits = await retrieval.retrieve(SENTENCE, { mode: 'lexical', limit: 3 })

    expect(hits.map(({ path, isPrivate }) => ({ path, isPrivate }))).toEqual([
      { path: 'notes/exact.md', isPrivate: true },
      { path: 'notes/related.md', isPrivate: true },
    ])
  })

  it('semantic mode returns the nearest notes and drops neighbors past the cutoff', async () => {
    const { retrieval, runtime } = await setup()

    const hits = await retrieval.retrieve('the rust language', { mode: 'semantic' })

    // The compilers note is a 20° neighbor; gardening (120°) is noise.
    expect(hits.map((hit) => hit.path)).toEqual([
      'notes/rust.md',
      'notes/secret.md',
      'notes/compilers.md',
    ])
    expect(hits[0]!.score).toBeCloseTo(1, 5)
    expect(hits[2]!.score).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 3)
    expect(hits[0]).toMatchObject({ title: 'Rust', heading: 'Rust', isPrivate: false })
    expect(hits[0]!.snippet).toContain('Rust has a borrow checker.')
    expect(runtime.embedCalls()).toEqual([['the rust language']])
  })

  it('embeds the semantic query as a query, with the model the status named', async () => {
    const { retrieval, runtime } = await setup()

    await retrieval.retrieve('where did we land on pricing', { mode: 'semantic' })

    expect(runtime.embedRequests()).toEqual([
      { texts: ['where did we land on pricing'], role: 'query', model: MODEL },
    ])
  })

  it('ignores vectors another model wrote, until the table is refitted', async () => {
    const gemma: EmbedStatus = { status: 'ready', model: GEMMA, dims: DIMENSIONS }
    const stale = await setup({ status: gemma })
    await expect(
      stale.retrieval.retrieve('the rust language', { mode: 'semantic' }),
    ).resolves.toEqual([])

    const refitted = await setup({ modelId: GEMMA, status: gemma })
    const hits = await refitted.retrieval.retrieve('the rust language', {
      mode: 'semantic',
      maxDistance: 2,
    })
    expect(hits.map((hit) => hit.path)).toContain('notes/rust.md')
  })

  it('matches only chunks embedded from the note as it is indexed now', async () => {
    const { retrieval, database } = await setup()
    await database.runQuery("UPDATE notes SET file_hash = 'edited-since' WHERE path = ?", [
      'notes/rust.md',
    ])

    const hits = await retrieval.retrieve('the rust language', { mode: 'semantic' })

    expect(hits.map((hit) => hit.path)).toEqual(['notes/secret.md', 'notes/compilers.md'])
  })

  it('caps the hits at `limit`', async () => {
    const { retrieval } = await setup()

    const hits = await retrieval.retrieve('the rust language', { mode: 'semantic', limit: 1 })

    expect(hits.map((hit) => hit.path)).toEqual(['notes/rust.md'])
  })

  it('an explicit maxDistance replaces the model cutoff', async () => {
    const { retrieval } = await setup()

    // Every note but the garden one is past the cutoff from gardening.
    const hits = await retrieval.retrieve('gardening', { mode: 'semantic', maxDistance: 2 })

    expect(hits.map((hit) => hit.path)).toContain('notes/rust.md')
  })

  it('strips the content of private hits on request, keeping the hit and its flag', async () => {
    const { retrieval } = await setup()

    const hits = await retrieval.retrieve('the rust language', {
      mode: 'semantic',
      excludePrivateContent: true,
    })

    const secret = hits.find((hit) => hit.path === 'notes/secret.md')
    expect(secret).toMatchObject({ title: 'Secret', snippet: '', heading: null, isPrivate: true })
    expect(hits.find((hit) => hit.path === 'notes/rust.md')!.snippet).not.toBe('')
  })

  it('strips a note inside a local-only folder by its path, whatever the index says', async () => {
    const { retrieval } = await setup({
      embedded: false,
      notes: [{ path: 'finance/secure/plan.md', markdown: '# Plan\n\nA rust budget.\n' }],
      graph: { localOnlyFolders: ['secure'] },
    })

    const hits = await retrieval.retrieve('rust budget', {
      mode: 'lexical',
      excludePrivateContent: true,
    })

    expect(hits).toMatchObject([
      { path: 'finance/secure/plan.md', isPrivate: false, snippet: '', heading: null },
    ])
  })

  it('strips every hit when no graph is open', async () => {
    const { retrieval } = await setup({ embedded: false, graph: null })

    const hits = await retrieval.retrieve('borrow checker', {
      mode: 'lexical',
      excludePrivateContent: true,
    })

    expect(hits).toMatchObject([{ path: 'notes/rust.md', snippet: '' }])
  })

  it('hybrid mode (the default) fuses both legs: a note on both lists ranks first', async () => {
    const { retrieval } = await setup()

    const hits = await retrieval.retrieve('compiler')

    // FTS finds only the compilers note; KNN adds its semantic neighbors.
    expect(hits.map((hit) => [hit.path, hit.matchedBy])).toEqual([
      ['notes/compilers.md', 'both'],
      ['notes/secret.md', 'semantic'],
      ['notes/rust.md', 'semantic'],
    ])
    expect(hits[0]!.score).toBeCloseTo(2 / 61, 10)
  })

  it('hybrid mode serves lexical hits and logs when the semantic leg fails', async () => {
    const { retrieval, logger } = await setup({ status: { status: 'uninitialized' } })

    const hits = await retrieval.retrieve('borrow checker')

    expect(hits.map((hit) => [hit.path, hit.matchedBy])).toEqual([['notes/rust.md', 'lexical']])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'semantic leg failed; serving lexical only:',
    ])
  })

  it('semantic mode rejects when the model is not ready', async () => {
    const { retrieval, runtime } = await setup({ status: { status: 'uninitialized' } })

    await expect(retrieval.retrieve('rust', { mode: 'semantic' })).rejects.toThrow(
      'embedding model is not loaded',
    )
    expect(runtime.embedCalls()).toEqual([])
  })
})

describe('relatedNotes', () => {
  it('returns the neighbors of the stored vectors, without the note itself or private notes', async () => {
    const { retrieval, runtime } = await setup()

    const hits = await retrieval.relatedNotes('notes/rust.md')

    expect(hits.map((hit) => hit.path)).toEqual(['notes/compilers.md'])
    expect(hits[0]!.score).toBeCloseTo(Math.cos((20 * Math.PI) / 180), 3)
    expect(runtime.embedCalls()).toEqual([]) // seeded by stored vectors, never re-embedded
  })

  it('returns nothing for a note whose neighbors are all past the cutoff', async () => {
    const { retrieval } = await setup()

    await expect(retrieval.relatedNotes('notes/garden.md')).resolves.toEqual([])
  })

  it('returns nothing for a note that has no vectors yet', async () => {
    const { retrieval } = await setup({ embedded: false })

    await expect(retrieval.relatedNotes('notes/rust.md')).resolves.toEqual([])
  })

  it('seeds only from chunks of the note as it is indexed now', async () => {
    const { retrieval, database } = await setup()
    await database.runQuery("UPDATE notes SET file_hash = 'edited-since' WHERE path = ?", [
      'notes/rust.md',
    ])

    await expect(retrieval.relatedNotes('notes/rust.md')).resolves.toEqual([])
  })

  it('caps the neighbors at `limit`', async () => {
    const { retrieval } = await setup()

    // The compilers note neighbors both rust notes; the private one never shows.
    await expect(retrieval.relatedNotes('notes/compilers.md', 1)).resolves.toHaveLength(1)
    await expect(retrieval.relatedNotes('notes/compilers.md', 0)).resolves.toEqual([])
  })
})

function hit(path: string, overrides?: Partial<RetrievalHit>): RetrievalHit {
  return {
    path,
    title: path,
    score: 0,
    snippet: `about ${path}`,
    heading: null,
    isPrivate: false,
    ...overrides,
  }
}

function row(path: string, distance: number, overrides?: Partial<ChunkHitRow>): ChunkHitRow {
  return {
    path,
    title: path,
    heading: null,
    text: ` about ${path} `,
    isPrivate: 0,
    modelId: 'all-MiniLM-L6-v2',
    distance,
    ...overrides,
  }
}

describe('bestChunkPerNote', () => {
  it('drops neighbors past the cosine noise cutoff (gibberish queries find nothing)', () => {
    const rows = [row('notes/a.md', 0.84), row('notes/b.md', 0.92)]
    expect(bestChunkPerNote(rows, 12)).toEqual([])
  })

  it('keeps near matches while dropping the noisy tail', () => {
    const rows = [row('notes/match.md', 0.3), row('notes/noise.md', 0.75)]
    const hits = bestChunkPerNote(rows, 12)
    expect(hits.map((hit) => hit.path)).toEqual(['notes/match.md'])
  })

  it('collapses to the best chunk per note, scored as cosine similarity', () => {
    const rows = [
      row('notes/a.md', 0.2, { text: 'best chunk' }),
      row('notes/a.md', 0.4, { text: 'worse chunk' }),
    ]
    const hits = bestChunkPerNote(rows, 12)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet).toBe('best chunk')
    expect(hits[0]!.score).toBeCloseTo(0.8)
  })

  it('excludes the seed note and respects the limit', () => {
    const rows = [row('notes/self.md', 0.0), row('notes/a.md', 0.1), row('notes/b.md', 0.2)]
    const hits = bestChunkPerNote(rows, 1, { excludePath: 'notes/self.md' })
    expect(hits.map((hit) => hit.path)).toEqual(['notes/a.md'])
  })

  it('an explicit maxDistance replaces the model cutoff', () => {
    const rows = [row('notes/near.md', 0.3), row('notes/far.md', 0.95)]
    const everything = bestChunkPerNote(rows, 12, { maxDistance: 2 })
    expect(everything.map((hit) => hit.path)).toEqual(['notes/near.md', 'notes/far.md'])
    const strict = bestChunkPerNote(rows, 12, { maxDistance: 0.2 })
    expect(strict).toEqual([])
  })

  it("cuts each row at its own model's cutoff", () => {
    const rows = [
      row('notes/gemma-near.md', 0.6, { modelId: 'embeddinggemma-300m' }),
      row('notes/gemma-far.md', 0.66, { modelId: 'embeddinggemma-300m' }),
      row('notes/minilm.md', 0.66),
    ]
    expect(bestChunkPerNote(rows, 12).map((hit) => hit.path)).toEqual([
      'notes/gemma-near.md',
      'notes/minilm.md',
    ])
  })

  it('a chunk from a model no longer offered uses the default model cutoff', () => {
    const rows = [
      row('notes/a.md', 0.6, { modelId: 'retired-model' }),
      row('notes/b.md', 0.75, { modelId: 'retired-model' }),
    ]
    expect(bestChunkPerNote(rows, 12).map((hit) => hit.path)).toEqual(['notes/a.md'])
  })

  it('trims snippets and converts the private flag', () => {
    const hits = bestChunkPerNote([row('notes/p.md', 0.1, { isPrivate: 1 })], 12)
    expect(hits[0]!.snippet).toBe('about notes/p.md')
    expect(hits[0]!.isPrivate).toBe(true)
  })
})

describe('mergeNearestFirst (multi-seed related notes)', () => {
  it('interleaves seed lists by distance so every seed contributes', () => {
    const fromLeadChunk = [row('notes/morning.md', 0.3), row('notes/noise.md', 0.6)]
    const fromLaterChunk = [row('notes/afternoon.md', 0.4)]
    const merged = mergeNearestFirst([fromLeadChunk, fromLaterChunk])
    expect(merged.map((entry) => entry.path)).toEqual([
      'notes/morning.md',
      'notes/afternoon.md',
      'notes/noise.md',
    ])
  })

  it('a neighbor found only by a later seed survives bestChunkPerNote', () => {
    const fromLeadChunk = [row('notes/self.md', 0.0)]
    const fromLaterChunk = [row('notes/self.md', 0.0), row('notes/afternoon.md', 0.4)]
    const merged = mergeNearestFirst([fromLeadChunk, fromLaterChunk])
    const hits = bestChunkPerNote(merged, 10, { excludePath: 'notes/self.md' })
    expect(hits.map((hit) => hit.path)).toEqual(['notes/afternoon.md'])
  })

  it('a note hit by several seeds keeps its best distance', () => {
    const fromLeadChunk = [row('notes/both.md', 0.5, { text: 'far chunk' })]
    const fromLaterChunk = [row('notes/both.md', 0.2, { text: 'near chunk' })]
    const hits = bestChunkPerNote(mergeNearestFirst([fromLeadChunk, fromLaterChunk]), 10)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.snippet).toBe('near chunk')
    expect(hits[0]!.score).toBeCloseTo(0.8)
  })
})

describe('fuseRanked (reciprocal rank fusion)', () => {
  it('a note ranked in both lists beats single-list notes', () => {
    const lexical = [hit('notes/both.md'), hit('notes/lex-only.md')]
    const semantic = [hit('notes/sem-only.md'), hit('notes/both.md')]
    const fused = fuseRanked([lexical, semantic], 10)
    expect(fused[0]!.path).toBe('notes/both.md')
    expect(fused).toHaveLength(3)
  })

  it('preserves single-list order and respects the limit', () => {
    const lexical = [hit('a'), hit('b'), hit('c')]
    const fused = fuseRanked([lexical], 2)
    expect(fused.map((entry) => entry.path)).toEqual(['a', 'b'])
  })

  it('fills an empty snippet from the other list and is deterministic', () => {
    const semantic = [hit('a', { snippet: '' })]
    const lexical = [hit('a', { snippet: 'lexical snippet' })]
    const fused = fuseRanked([semantic, lexical], 5)
    expect(fused[0]!.snippet).toBe('lexical snippet')
    expect(fuseRanked([semantic, lexical], 5)).toEqual(fused)
  })

  it('keeps the private flag through fusion', () => {
    const fused = fuseRanked([[hit('p', { isPrivate: true })]], 5)
    expect(fused[0]!.isPrivate).toBe(true)
  })

  it('retains device-only provenance across lexical and semantic legs', () => {
    const fused = fuseRanked(
      [[hit('p')], [hit('p', { isPrivate: true, hasDeviceOnlyContent: true })]],
      5,
    )
    expect(fused[0]).toMatchObject({ isPrivate: true, hasDeviceOnlyContent: true })
  })

  it('restricts snippets fused from different attachment-text snapshots', () => {
    expect(
      fuseRanked(
        [
          [hit('p', { assetTextHash: 'a'.repeat(64) })],
          [hit('p', { assetTextHash: 'b'.repeat(64) })],
        ],
        5,
      )[0],
    ).toMatchObject({ hasDeviceOnlyContent: true })
  })
})

describe('withMatchedBy', () => {
  const hit = (path: string) => ({
    path,
    title: path,
    score: 0,
    snippet: '',
    heading: null,
    isPrivate: false,
  })

  it('tags each fused hit with the leg that found it', () => {
    const lexical = [hit('a.md'), hit('b.md')]
    const semantic = [hit('b.md'), hit('c.md')]

    const tagged = withMatchedBy([hit('b.md'), hit('a.md'), hit('c.md')], lexical, semantic)

    expect(tagged.map((entry) => [entry.path, entry.matchedBy])).toEqual([
      ['b.md', 'both'],
      ['a.md', 'lexical'],
      ['c.md', 'semantic'],
    ])
  })
})
