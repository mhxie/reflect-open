import { describe, expect, it } from 'vitest'
import { noteBodyHash } from '../markdown/body-hash.ts'
import { parseNote } from '../markdown/index.ts'
import {
  createTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
  type TestNote,
} from '../testing/database.ts'
import { parseSearchQuery } from './filter-query.ts'
import { cjkColumnText } from './cjk.ts'
import { buildIndexedNote } from './indexed-note.ts'
import { createSearchService, type SearchService } from './search-service.ts'
import { createWikiResolverService } from './wiki-resolver-service.ts'

/**
 * `notes.asset_text_hash` of a note without asset text: the SHA-256 of ''.
 */
const EMPTY_ASSET_TEXT_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

function startOfLocalDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, month! - 1, day!).getTime()
}

function setup(notes: readonly TestNote[]): {
  database: TestDatabaseService
  search: SearchService
} {
  const database = createTestDatabaseService()
  seedNotes(database, notes)
  const wikiResolver = createWikiResolverService({ database })
  return { database, search: createSearchService({ database, wikiResolver }) }
}

async function searchPaths(
  notes: readonly TestNote[],
  query: string,
  options?: Parameters<SearchService['searchWithFilters']>[1],
): Promise<string[]> {
  const hits = await setup(notes).search.searchWithFilters(parseSearchQuery(query), options)
  return hits.map((hit) => hit.path)
}

describe('searchWithFilters', () => {
  it('starts tag-only recall searches from the folded tag key', async () => {
    const { search } = setup([
      { path: 'notes/work.md', markdown: '# Work\nWeekly agenda. #work\n', mtime: 2000 },
      { path: 'notes/home.md', markdown: '# Home\nChores. #home\n', mtime: 3000 },
      { path: 'templates/work.md', markdown: '# Work template\n#Work\n', mtime: 4000 },
    ])

    await expect(search.searchWithFilters(parseSearchQuery('#Work'))).resolves.toEqual([
      {
        path: 'notes/work.md',
        title: 'Work',
        displayTitle: null,
        lang: null,
        highlightedTitle: 'Work',
        dailyDate: null,
        snippet: null,
        preview: 'Weekly agenda. #work',
        summary: '',
        mtime: 2000,
        isPinned: false,
        hasConflict: false,
        isPrivate: false,
        hasDeviceOnlyContent: false,
        assetTextHash: EMPTY_ASSET_TEXT_HASH,
      },
    ])
  })

  it('requires every additional tag filter', async () => {
    const paths = await searchPaths(
      [
        { path: 'notes/work.md', markdown: '# Work\n#Work\n' },
        { path: 'notes/both.md', markdown: '# Both\n#work #HOME\n' },
        { path: 'notes/home.md', markdown: '# Home\n#home\n' },
      ],
      '#Work #Home',
    )

    expect(paths).toEqual(['notes/both.md'])
  })

  it('applies non-tag filters on the tag-first recall path', async () => {
    const { search } = setup([
      {
        path: 'daily/2026-01-02.md',
        markdown: '---\npinned: true\n---\nStandup notes. #work\n',
        mtime: startOfLocalDay('2026-01-02'),
      },
      {
        path: 'daily/2025-12-30.md',
        markdown: '---\npinned: true\n---\nOld standup. #work\n',
        mtime: startOfLocalDay('2025-12-30'),
      },
      {
        path: 'daily/2026-01-03.md',
        markdown: 'Unpinned. #work\n',
        mtime: startOfLocalDay('2026-01-03'),
      },
      {
        path: 'notes/pinned.md',
        markdown: '---\npinned: true\n---\n# Pinned\n#work\n',
        mtime: startOfLocalDay('2026-01-03'),
      },
    ])

    const hits = await search.searchWithFilters(
      parseSearchQuery('#Work is:daily is:pinned updated:>2026-01-01'),
    )

    expect(hits).toEqual([
      {
        path: 'daily/2026-01-02.md',
        title: '2026-01-02',
        displayTitle: null,
        lang: null,
        highlightedTitle: '2026-01-02',
        dailyDate: '2026-01-02',
        snippet: null,
        preview: 'Standup notes. #work',
        summary: '',
        mtime: startOfLocalDay('2026-01-02'),
        isPinned: true,
        hasConflict: false,
        isPrivate: false,
        hasDeviceOnlyContent: false,
        assetTextHash: EMPTY_ASSET_TEXT_HASH,
      },
    ])
  })

  it('ranks exact, then prefix title matches ahead of body hits on text search', async () => {
    const { database, search } = setup([
      { path: 'notes/body.md', markdown: '# Animals\nA quokka lives here.\n', mtime: 9000 },
      { path: 'notes/habitat.md', markdown: '# Quokka Habitat\nIslands.\n', mtime: 8000 },
      { path: 'notes/quokka.md', markdown: '# Quokka\nQuokka facts.\n', mtime: 3000 },
      { path: 'notes/other.md', markdown: '# Other\nNothing here.\n', mtime: 9500 },
    ])

    const hits = await search.searchWithFilters(parseSearchQuery('quokka'))

    expect(hits.map((hit) => hit.path)).toEqual([
      'notes/quokka.md',
      'notes/habitat.md',
      'notes/body.md',
    ])
    expect(hits[0]).toMatchObject({
      title: 'Quokka',
      highlightedTitle: '\u{1}Quokka\u{2}',
      preview: 'Quokka facts.',
      isPinned: false,
    })
    expect(hits[2]!.highlightedTitle).toBe('Animals')
    expect(hits[2]!.snippet).toContain('\u{1}quokka\u{2}')
    // Text results never carry the AI summary.
    expect(hits.map((hit) => hit.summary)).toEqual(['', '', ''])

    const [query] = database.getQueries()
    // Ranking weighs the title, body and CJK columns; a second bm25 over the
    // body alone tells whether the body matched (where a snippet highlights).
    expect(query?.sql).toContain('bm25(search_fts, 0, 10.0, 1.0, 1.0)')
    expect(query?.sql).toContain('bm25(search_fts, 0, 0.0, 1.0, 0.0)')
    expect(query?.params).toContain('(title : "quokka"* OR body : "quokka"* OR cjk : "quokka"*)')
  })

  it('breaks ties between equal title matches by pinning, then recency', async () => {
    const paths = await searchPaths(
      [
        { path: 'notes/new.md', markdown: '# Plan new\n', mtime: 3000 },
        { path: 'notes/old.md', markdown: '# Plan old\n', mtime: 1000 },
        { path: 'notes/pinned.md', markdown: '---\npinned: true\n---\n# Plan pinned\n', mtime: 0 },
      ],
      'plan',
    )

    expect(paths).toEqual(['notes/pinned.md', 'notes/new.md', 'notes/old.md'])
  })

  it('shows a `//` title by its first segment on the recall feeds', async () => {
    const { search } = setup([
      {
        path: 'notes/tim-maccaw-dad.md',
        markdown: '---\npinned: true\n---\n# Tim MacCaw // Dad\n#Family\n',
      },
    ])

    const [recall] = await search.searchWithFilters(parseSearchQuery('is:pinned'))
    const [tagged] = await search.searchWithFilters(parseSearchQuery('#Family'))

    expect(recall).toMatchObject({ title: 'Tim MacCaw // Dad', highlightedTitle: 'Tim MacCaw' })
    expect(tagged).toMatchObject({ title: 'Tim MacCaw // Dad', highlightedTitle: 'Tim MacCaw' })
  })

  it('highlights the first segment of a `//` title on text search', async () => {
    const { search } = setup([
      { path: 'notes/tim-maccaw-dad.md', markdown: '# Tim MacCaw // Dad\n' },
    ])

    const [hit] = await search.searchWithFilters(parseSearchQuery('tim'))

    expect(hit).toMatchObject({
      title: 'Tim MacCaw // Dad',
      highlightedTitle: '\u{1}Tim\u{2} MacCaw',
    })
  })

  it('shows a `//` title plain when only an alias segment matched', async () => {
    const { search } = setup([
      { path: 'notes/tim-maccaw-dad.md', markdown: '# Tim MacCaw // Dad\n' },
    ])

    const [hit] = await search.searchWithFilters(parseSearchQuery('dad'))

    expect(hit).toMatchObject({ title: 'Tim MacCaw // Dad', highlightedTitle: 'Tim MacCaw' })
  })

  it('keeps a tokenizer-only FTS highlight inside the first segment of a `//` title', async () => {
    const { search } = setup([{ path: 'notes/cafe.md', markdown: '# Café // Alias\n' }])

    const [hit] = await search.searchWithFilters(parseSearchQuery('cafe'))

    expect(hit).toMatchObject({ title: 'Café // Alias', highlightedTitle: '\u{1}Café\u{2}' })
  })

  it('folds the exact-title key the way titles were indexed', async () => {
    const paths = await searchPaths(
      [
        { path: 'notes/notes.md', markdown: '# Quokka Habitat Notes\n', mtime: 2000 },
        { path: 'notes/exact.md', markdown: '# quokka habitat\n', mtime: 1000 },
      ],
      'Quokka Habitat',
    )

    expect(paths).toEqual(['notes/exact.md', 'notes/notes.md'])
  })

  it('caps the recall feed at 12 by default and leaves it uncapped when limit is null', async () => {
    const notes = Array.from({ length: 13 }, (_, index) => ({
      path: `notes/pin-${index}.md`,
      markdown: `---\npinned: true\n---\n# Pin ${index}\n`,
    }))

    await expect(searchPaths(notes, 'is:pinned')).resolves.toHaveLength(12)
    await expect(searchPaths(notes, 'is:pinned', { limit: null })).resolves.toHaveLength(13)
  })

  it('orders the recall feed by recency, or pinned-first when asked (the All list order)', async () => {
    const notes: TestNote[] = [
      { path: 'daily/2026-01-01.md', markdown: 'Oldest\n', mtime: 1000 },
      { path: 'daily/2026-01-02.md', markdown: '---\npinned: true\n---\nBare pin\n', mtime: 2000 },
      { path: 'daily/2026-01-03.md', markdown: 'Newest\n', mtime: 3000 },
      { path: 'daily/2026-01-04.md', markdown: '---\npinned: 0\n---\nFirst pin\n', mtime: 500 },
      { path: 'notes/note.md', markdown: '# Not a daily\n', mtime: 9000 },
    ]

    await expect(searchPaths(notes, 'is:daily', { limit: null })).resolves.toEqual([
      'daily/2026-01-03.md',
      'daily/2026-01-02.md',
      'daily/2026-01-01.md',
      'daily/2026-01-04.md',
    ])
    await expect(
      searchPaths(notes, 'is:daily', { limit: null, pinnedFirst: true }),
    ).resolves.toEqual([
      'daily/2026-01-04.md',
      'daily/2026-01-02.md',
      'daily/2026-01-03.md',
      'daily/2026-01-01.md',
    ])
  })

  it('orders the tag-first recall path pinned-first when asked', async () => {
    const paths = await searchPaths(
      [
        { path: 'notes/new.md', markdown: '# New\n#work\n', mtime: 3000 },
        {
          path: 'notes/pinned.md',
          markdown: '---\npinned: true\n---\n# Pinned\n#work\n',
          mtime: 1,
        },
      ],
      '#Work',
      { limit: null, pinnedFirst: true },
    )

    expect(paths).toEqual(['notes/pinned.md', 'notes/new.md'])
  })

  const LINKED: TestNote[] = [
    { path: 'notes/alpha-1.md', markdown: '# Alpha\n' },
    { path: 'notes/alpha-2.md', markdown: '# Alpha\n' },
    { path: 'notes/hub.md', markdown: '# Hub\n[[Alpha]] and [[notes/beta]]\n#work\n' },
    { path: 'notes/hub-2.md', markdown: '# Hub 2\n[[notes/alpha-2]]\n#work\n' },
    { path: 'notes/beta.md', markdown: '# Beta\n#work\n' },
  ]

  it('resolves links: tokens by title before filtering', async () => {
    await expect(searchPaths(LINKED, 'links:Alpha')).resolves.toEqual(['notes/hub.md'])
  })

  it('matches nothing when a link token does not resolve', async () => {
    await expect(searchPaths(LINKED, 'links:Missing')).resolves.toEqual([])
    await expect(searchPaths(LINKED, 'linked-from:Missing')).resolves.toEqual([])
  })

  it('filters by a picker-exact link target without resolving titles', async () => {
    const { database, search } = setup(LINKED)
    const parsed = parseSearchQuery('')
    parsed.filters.linksToPath = 'notes/alpha-2.md'

    const hits = await search.searchWithFilters(parsed)

    expect(hits.map((hit) => hit.path)).toEqual(['notes/hub-2.md'])
    expect(database.getQueries()).toHaveLength(1)
  })

  it('filters by a picker-exact link source without resolving titles', async () => {
    const { database, search } = setup(LINKED)
    const parsed = parseSearchQuery('')
    parsed.filters.linkedFromPath = 'notes/hub.md'

    const hits = await search.searchWithFilters(parsed)

    expect(hits.map((hit) => hit.path).toSorted()).toEqual(['notes/alpha-1.md', 'notes/beta.md'])
    expect(database.getQueries()).toHaveLength(1)
  })

  it('lets an exact path win over a title target (duplicate titles cannot retarget)', async () => {
    const { database, search } = setup(LINKED)
    const parsed = parseSearchQuery('links:Alpha')
    parsed.filters.linksToPath = 'notes/alpha-2.md'

    const hits = await search.searchWithFilters(parsed)

    expect(hits.map((hit) => hit.path)).toEqual(['notes/hub-2.md'])
    expect(database.getQueries()).toHaveLength(1)
  })

  it('applies picker-exact link targets on the tag-first recall path', async () => {
    const { search } = setup(LINKED)
    const parsed = parseSearchQuery('#Work')
    parsed.filters.linkedFromPath = 'notes/hub.md'

    const hits = await search.searchWithFilters(parsed)

    expect(hits.map((hit) => hit.path)).toEqual(['notes/beta.md'])
  })

  it('restricts the population to regular notes with notesOnly', async () => {
    const notes: TestNote[] = [
      { path: 'notes/pinned.md', markdown: '---\npinned: true\n---\n# Pinned\n', mtime: 1 },
      { path: 'daily/2026-01-01.md', markdown: '---\npinned: true\n---\nDay\n', mtime: 2 },
    ]

    await expect(
      searchPaths(notes, 'is:pinned', { limit: null, notesOnly: true }),
    ).resolves.toEqual(['notes/pinned.md'])
  })

  it('lets an explicit daily filter win over notesOnly', async () => {
    const notes: TestNote[] = [
      { path: 'notes/note.md', markdown: '# Note\n', mtime: 1 },
      { path: 'daily/2026-01-01.md', markdown: 'Day\n', mtime: 2 },
    ]

    await expect(searchPaths(notes, 'is:daily', { limit: null, notesOnly: true })).resolves.toEqual(
      ['daily/2026-01-01.md'],
    )
  })

  it('reads privacy flags in the same snapshot as the search snippet', async () => {
    const database = createTestDatabaseService()
    const markdown = '---\nprivate: true\n---\n# Scan\n![](assets/scan.png)\n'
    database.applyProjection(
      buildIndexedNote(parseNote({ path: 'notes/scan.md', source: markdown }), {
        fileHash: 'hash-scan',
        mtime: 2000,
        source: markdown,
        assetText: 'Private OCR',
        hasDeviceOnlyContent: true,
      }),
    )
    const search = createSearchService({
      database,
      wikiResolver: createWikiResolverService({ database }),
    })

    const hits = await search.searchWithFilters(parseSearchQuery('OCR'))

    expect(hits[0]).toMatchObject({
      snippet: expect.stringContaining('\u{1}OCR\u{2}'),
      isPrivate: true,
      hasDeviceOnlyContent: true,
      assetTextHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    })
    expect(hits[0]?.assetTextHash).not.toBe(EMPTY_ASSET_TEXT_HASH)
    const queries = database.getQueries()
    expect(queries).toHaveLength(1)
    expect(queries[0]?.sql).toContain('"is_private"')
    expect(queries[0]?.sql).toContain('"has_device_only_content"')
    expect(queries[0]?.sql).toContain('"asset_text_hash"')
  })

  const SUMMARIZED = `---\naiSummary:\n  text: What the agenda covers.\n  hash: HASH\n---\n# Work\nWeekly agenda. #work\n`

  /**
   * A note whose `aiSummary` block summarizes its current body.
   */
  function summarizedNote(): TestNote {
    const body = '# Work\nWeekly agenda. #work\n'
    return {
      path: 'notes/work.md',
      markdown: SUMMARIZED.replace('HASH', noteBodyHash(body)),
      mtime: 2000,
    }
  }

  it.each([
    ['#Work', 'What the agenda covers.'],
    ['', 'What the agenda covers.'],
    // A title-only match has no snippet either; the row must not fall back to AI text.
    ['work', ''],
  ])('carries the AI summary on the no-text feed only (%j)', async (query, summary) => {
    const { search } = setup([summarizedNote()])

    const hits = await search.searchWithFilters(parseSearchQuery(query))

    expect(hits[0]).toMatchObject({ preview: 'Weekly agenda. #work', summary })
  })

  it.each(['#Work', '', 'work'])(
    'preserves Private and conflict metadata for %j using one bulk query',
    async (query) => {
      const { database, search } = setup([
        {
          path: 'notes/work.md',
          markdown:
            '---\nprivate: true\n---\n# Work\nWeekly agenda. #work\n<<<<<<< ours\nA\n=======\nB\n>>>>>>> theirs\n',
          mtime: 2000,
        },
      ])

      const hits = await search.searchWithFilters(parseSearchQuery(query))

      expect(hits).toHaveLength(1)
      expect(hits[0]).toMatchObject({ path: 'notes/work.md', isPrivate: true, hasConflict: true })
      const queries = database.getQueries()
      expect(queries).toHaveLength(1)
      expect(queries[0]?.sql).toContain('"notes"."is_private"')
      expect(queries[0]?.sql).toContain('"notes"."has_conflict"')
    },
  )
})

/**
 * One note whose search row holds exactly `title` and `body`.
 */
interface SearchRow {
  readonly path: string
  readonly title: string
  readonly body: string
  readonly mtime: number
}

/**
 * A search over `rows`, each note projected from `# title\nbody`, its search
 * row then holding the title and the body alone (with the body's CJK column),
 * so a body match never comes from the heading line.
 */
async function searchRows(rows: readonly SearchRow[]): Promise<SearchService> {
  const { database, search } = setup(
    rows.map((row) => ({
      path: row.path,
      markdown: `# ${row.title}\n${row.body}\n`,
      mtime: row.mtime,
    })),
  )
  for (const row of rows) {
    await database.runQuery('DELETE FROM search_fts WHERE path = ?', [row.path])
    await database.runQuery('INSERT INTO search_fts(path, title, body, cjk) VALUES (?, ?, ?, ?)', [
      row.path,
      row.title,
      row.body,
      `${cjkColumnText(row.title)} ${cjkColumnText(row.body)}`.trim(),
    ])
  }
  return search
}

describe('searchWithFilters over a CJK clause', () => {
  const body = '我们下周去東京旅行，今天看了Transformer的论文。还有我和小王一起吃饭，然后回家写周记'

  function cjkSearch(): Promise<SearchService> {
    return searchRows([
      { path: 'notes/week.md', title: '周记', body, mtime: 1 },
      { path: 'notes/kyoto.md', title: '京都', body: 'plain english body', mtime: 1 },
    ])
  }

  it('marks the run in the body when only the cjk column matched', async () => {
    const [hit] = await (await cjkSearch()).searchWithFilters(parseSearchQuery('東京'))
    expect(hit?.snippet).toBe('我们下周去\u{1}東京\u{2}旅行，今天看了Transformer的论…')
  })

  it('marks the first of the longest runs with context on both sides', async () => {
    const [hit] = await (await cjkSearch()).searchWithFilters(parseSearchQuery('吃饭 小王一起'))
    expect(hit?.snippet).toBe(
      '…了Transformer的论文。还有我和\u{1}小王一起\u{2}吃饭，然后回家写周记',
    )
  })

  it('keeps no snippet when the run sits only in the title', async () => {
    const [hit] = await (await cjkSearch()).searchWithFilters(parseSearchQuery('京都'))
    expect(hit).toMatchObject({ path: 'notes/kyoto.md', snippet: null })
  })
})

describe('searchWithFilters ranking over a real index', () => {
  // Both titles hold the term at a word start (the all-terms title tier);
  // only the older note's body holds it too.
  const ROWS: SearchRow[] = [
    { path: 'notes/new.md', title: 'Big Alpha', body: 'nothing to see here', mtime: 2000 },
    { path: 'notes/old.md', title: 'Old Alpha', body: 'alpha and alpha again', mtime: 1000 },
    { path: 'notes/body.md', title: 'Gamma', body: 'one alpha', mtime: 3000 },
  ]

  it('keeps bm25 for a title match whose body matched too, and 0 for a title-only match', async () => {
    const hits = await (await searchRows(ROWS)).searchWithFilters(parseSearchQuery('alpha'))
    // The body match's negative bm25 sorts ahead of the title-only row's 0,
    // although the title-only note is newer.
    expect(hits.map((hit) => [hit.path, hit.snippet])).toEqual([
      ['notes/old.md', '\u{1}alpha\u{2} and \u{1}alpha\u{2} again'],
      ['notes/new.md', null],
      ['notes/body.md', 'one \u{1}alpha\u{2}'],
    ])
  })

  it('snippets exactly the ranked page under a limit', async () => {
    const hits = await (
      await searchRows(ROWS)
    ).searchWithFilters(parseSearchQuery('alpha'), {
      limit: 1,
    })
    expect(hits.map((hit) => [hit.path, hit.snippet, hit.highlightedTitle])).toEqual([
      ['notes/old.md', '\u{1}alpha\u{2} and \u{1}alpha\u{2} again', 'Old \u{1}Alpha\u{2}'],
    ])
  })
})
