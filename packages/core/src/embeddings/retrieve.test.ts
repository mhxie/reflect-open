import { afterEach, describe, expect, it } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import {
  bestChunkPerNote,
  type ChunkHitRow,
  fuseRanked,
  mergeNearestFirst,
  type RetrievalHit,
  retrieve,
  withMatchedBy,
} from './retrieve.ts'

function hit(path: string, overrides?: Partial<RetrievalHit>): RetrievalHit {
  return {
    path,
    title: path,
    score: 0,
    snippet: `about ${path}`,
    heading: null,
    isPrivate: false,
    hasConflict: false,
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
    hasConflict: 0,
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
    const hits = bestChunkPerNote([row('notes/p.md', 0.1, { isPrivate: 1, hasConflict: 1 })], 12)
    expect(hits[0]!.snippet).toBe('about notes/p.md')
    expect(hits[0]!.isPrivate).toBe(true)
    expect(hits[0]!.hasConflict).toBe(true)
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
    const fused = fuseRanked([[hit('p', { isPrivate: true, hasConflict: true })]], 5)
    expect(fused[0]!.isPrivate).toBe(true)
    expect(fused[0]!.hasConflict).toBe(true)
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

describe('retrieve', () => {
  afterEach(() => {
    setBridge(null)
  })

  /** A bridge whose `db_query` answers by query shape; records every call. */
  function fakeIndex(answers: {
    everyTerm: object[]
    anyTerm: object[]
    knn?: object[]
    loadedModel?: string
  }): Array<[string, unknown]> {
    const calls: Array<[string, unknown]> = []
    setBridge({
      invoke: async (command, args) => {
        calls.push([command, args])
        if (command === 'embed_status') {
          return answers.loadedModel === undefined
            ? { status: 'ready', model: 'all-MiniLM-L6-v2', dims: 384 }
            : { status: 'ready', model: answers.loadedModel, dims: 384 }
        }
        if (command === 'embed_texts') {
          return [[0.1, 0.2]]
        }
        const sql = String(args['sql'] ?? '')
        if (sql.includes('materialized')) {
          return answers.everyTerm.map((entry) => ({
            is_private: 0,
            has_device_only_content: 0,
            ...entry,
          }))
        }
        if (sql.includes('bm25(search_fts, 0, 10.0, 1.0, 1.0)')) {
          return answers.anyTerm
        }
        if (sql.includes('embedding_vectors v')) {
          return answers.knn ?? []
        }
        return []
      },
      listen: async () => () => {},
    })
    return calls
  }

  const EXACT = {
    path: 'notes/exact.md',
    title: 'Exact',
    daily_date: null,
    preview: '',
    mtime: 1,
    is_pinned: 0,
    is_private: 0,
    has_conflict: 0,
    fts_highlighted_title: 'Exact',
    snippet: 'every term',
  }

  it('keeps device-only snippet provenance without a second index read', async () => {
    const snippet = '\u{1}exact\u{2} OCR'
    const calls = fakeIndex({
      everyTerm: [{ ...EXACT, snippet, has_device_only_content: 1 }],
      anyTerm: [],
    })
    const hits = await retrieve('exact', { mode: 'lexical', limit: 1 })
    expect(hits[0]).toMatchObject({ snippet, hasDeviceOnlyContent: true })
    expect(calls.filter(([command]) => command === 'db_query')).toHaveLength(1)
  })

  it('fills a sentence-long query with any-term matches after the every-term ones', async () => {
    const calls = fakeIndex({
      everyTerm: [EXACT],
      anyTerm: [
        { path: 'notes/exact.md', title: 'Exact', snippet: '', isPrivate: 0 },
        {
          path: 'notes/related.md',
          title: 'Related',
          snippet: 'some terms',
          isPrivate: 1,
          hasConflict: 0,
        },
      ],
    })
    const hits = await retrieve('a sentence about wombat formats and their storage', {
      mode: 'lexical',
      limit: 3,
    })
    // The every-term hit leads and isn't repeated; the rest rank by bm25.
    expect(hits.map((hit) => [hit.path, hit.isPrivate])).toEqual([
      ['notes/exact.md', false],
      ['notes/related.md', true],
    ])
    expect(hits.map((hit) => hit.score)).toEqual([1, 0.5])
    const anyTerm = calls.find(([, args]) =>
      String((args as { sql?: string }).sql).includes('bm25(search_fts, 0, 10.0, 1.0, 1.0)'),
    )
    expect(anyTerm).toBeDefined()
  })

  it('skips the any-term leg when every term already filled the limit', async () => {
    const calls = fakeIndex({ everyTerm: [EXACT], anyTerm: [] })
    await retrieve('exact', { mode: 'lexical', limit: 1 })
    expect(
      calls.some(([, args]) => String((args as { sql?: string }).sql).includes('ORDER BY bm25')),
    ).toBe(false)
  })

  it('keeps a few keywords strict: no partial matches fill the list', async () => {
    const calls = fakeIndex({
      everyTerm: [EXACT],
      anyTerm: [
        {
          path: 'notes/related.md',
          title: 'Related',
          snippet: 'some',
          isPrivate: 0,
          hasConflict: 0,
        },
      ],
    })
    const hits = await retrieve('wombat formats', { mode: 'lexical', limit: 3 })
    expect(hits.map((hit) => hit.path)).toEqual(['notes/exact.md'])
    expect(
      calls.some(([, args]) => String((args as { sql?: string }).sql).includes('ORDER BY bm25')),
    ).toBe(false)
  })

  it('ignores vectors another model wrote, until the table is refitted', async () => {
    const knnRow = {
      path: 'notes/near.md',
      title: 'Near',
      heading: null,
      text: 'near',
      isPrivate: 0,
      hasConflict: 0,
      distance: 0.1,
    }
    fakeIndex({
      everyTerm: [],
      anyTerm: [],
      loadedModel: 'embeddinggemma-300m',
      knn: [{ ...knnRow, modelId: 'all-MiniLM-L6-v2' }],
    })
    expect(await retrieve('notes about storage', { mode: 'semantic' })).toEqual([])

    fakeIndex({
      everyTerm: [],
      anyTerm: [],
      loadedModel: 'embeddinggemma-300m',
      knn: [{ ...knnRow, modelId: 'embeddinggemma-300m' }],
    })
    const hits = await retrieve('notes about storage', { mode: 'semantic', maxDistance: 2 })
    expect(hits.map((hit) => hit.path)).toEqual(['notes/near.md'])
  })

  it('embeds the semantic query as a query, not a passage', async () => {
    const calls = fakeIndex({ everyTerm: [], anyTerm: [] })
    await retrieve('where did we land on pricing', { mode: 'semantic' })
    expect(calls.find(([command]) => command === 'embed_texts')?.[1]).toEqual({
      texts: ['where did we land on pricing'],
      role: 'query',
    })
  })

  it('preserves Private and conflict metadata from both lexical legs', async () => {
    fakeIndex({
      everyTerm: [{ ...EXACT, is_private: 1, has_conflict: 1 }],
      anyTerm: [
        {
          path: 'notes/related.md',
          title: 'Related',
          snippet: 'related terms',
          isPrivate: 1,
          hasConflict: 1,
        },
      ],
    })
    const hits = await retrieve('a sentence about wombat formats and their storage', {
      mode: 'lexical',
      limit: 3,
    })
    expect(
      hits.map(({ path, isPrivate, hasConflict }) => ({ path, isPrivate, hasConflict })),
    ).toEqual([
      { path: EXACT.path, isPrivate: true, hasConflict: true },
      { path: 'notes/related.md', isPrivate: true, hasConflict: true },
    ])
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
    hasConflict: false,
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
