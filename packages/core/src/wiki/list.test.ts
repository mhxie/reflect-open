import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { DEFAULT_WIKI_LANGUAGES, type WikiLanguage } from './languages.ts'
import { hasWikiEntries, listWikiEntries, wikiCopies } from './list.ts'

// A fake bridge answers `db_query` from the compiled SQL and `note_read_local`
// from in-memory files, so the tests exercise the real queries and reads.
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

const LANGUAGES = DEFAULT_WIKI_LANGUAGES

const ENTRY = [
  '# Spacing Effect',
  '',
  '> Spread practice out.',
  '',
  '## Summary',
  '',
  'Spaced sessions beat cramming.',
  '',
  '## Claims',
  '',
  '### [C1] Spacing improves retention',
  '',
  'Body.',
  '',
  '```anchors',
  '@anchor: doi:10.1037/0033-2909.132.3.354 | valid_at: 2026-01-02',
  '@pass: reviewer | status: verified | at: 2026-01-02',
  '```',
  '',
  '## Revision Log',
  '',
  '- 2026-01-02: Initial draft.',
].join('\n')

const TRANSLATION = [
  '# Spacing Effect',
  '',
  '> 本文为 [[Spacing Effect]] 的中文版本。',
  '',
  '## Summary',
  '',
  '间隔练习胜过集中练习。',
  '',
  '## Revision Log',
  '',
  '- 2026-01-03: 翻译。',
].join('\n')

interface Fixture {
  notes: { path: string; title: string; mtime: number; file_hash: string }[]
  citedBy: { target_path: string | null; cited_by: number }[]
  tags: { note_path: string; tag: string }[]
  files: Record<string, string>
  /** Paths whose bytes are not on this device (iCloud-evicted). */
  evicted: Set<string>
}

let fixture: Fixture

function serve(): void {
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read_local') {
      const path = String(args['path'])
      if (fixture.evicted.has(path)) {
        return { kind: 'evicted' }
      }
      const content = fixture.files[path]
      if (content === undefined) {
        throw { kind: 'notFound', message: 'gone' }
      }
      return { kind: 'content', content }
    }
    if (command !== 'db_query') {
      return null
    }
    const query = String(args['sql'])
    const params = (args['params'] as unknown[] | undefined) ?? []
    if (query.includes('count(distinct')) {
      return fixture.citedBy
    }
    if (query.includes('from "tags"')) {
      return fixture.tags
    }
    if (query.includes('"file_hash"')) {
      return fixture.notes
    }
    if (query.includes('"notes"."path" in')) {
      return fixture.notes
        .filter((note) => params.includes(note.path))
        .map(({ path }) => ({ path }))
    }
    if (query.includes('limit')) {
      return fixture.notes.slice(0, 1).map(({ path }) => ({ path }))
    }
    return []
  })
}

function readsOf(path: string): number {
  return mockInvoke.mock.calls.filter(
    ([command, args]) => command === 'note_read_local' && args['path'] === path,
  ).length
}

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
  fixture = {
    notes: [
      {
        path: 'wiki-cn/memory/Spacing Effect.md',
        title: 'Spacing Effect (中文)',
        mtime: 3,
        file_hash: 'cn',
      },
      { path: 'wiki/index.md', title: 'Wiki Index', mtime: 1, file_hash: 'index' },
      { path: 'wiki/memory/Spacing Effect.md', title: 'Spacing Effect', mtime: 2, file_hash: 'h1' },
    ],
    citedBy: [
      { target_path: 'wiki/memory/Spacing Effect.md', cited_by: 4 },
      { target_path: null, cited_by: 9 },
    ],
    tags: [
      { note_path: 'wiki/memory/Spacing Effect.md', tag: 'learning' },
      { note_path: 'wiki/memory/Spacing Effect.md', tag: 'memory' },
    ],
    files: {
      'wiki/index.md': '# Wiki Index\n\n## Entries\n\n- [[Spacing Effect]]\n',
      'wiki/memory/Spacing Effect.md': ENTRY,
      'wiki-cn/memory/Spacing Effect.md': TRANSLATION,
    },
    evicted: new Set(),
  }
  serve()
})

afterEach(() => {
  setBridge(null)
})

describe('listWikiEntries', () => {
  it('lists source-language notes with topic, translations, inbound links, tags, and claims', async () => {
    const entries = await listWikiEntries({
      generation: 1,
      asOf: '2026-03-01',
      languages: LANGUAGES,
    })

    expect(entries.map((entry) => entry.path)).toEqual([
      'wiki/index.md',
      'wiki/memory/Spacing Effect.md',
    ])
    const [index, spacing] = entries
    expect(index).toMatchObject({ topic: null, citedBy: 0, tags: [] })
    expect(index?.translations.size).toBe(0)
    expect(index?.summary?.claims).toBe(0)
    expect(spacing).toMatchObject({
      title: 'Spacing Effect',
      topic: 'memory',
      mtime: 2,
      state: 'local',
      preview: 'Spaced sessions beat cramming.',
      revised: '2026-01-02',
      citedBy: 4,
      tags: ['learning', 'memory'],
    })
    expect(spacing?.translations.get('wiki-cn')).toEqual({
      path: 'wiki-cn/memory/Spacing Effect.md',
      title: 'Spacing Effect (中文)',
      mtime: 3,
      state: 'local',
      // Past the copy's note on its source.
      preview: '间隔练习胜过集中练习。',
      revised: '2026-01-03',
    })
    expect(spacing?.summary).toMatchObject({
      preview: 'Spaced sessions beat cramming.',
      claims: 1,
      sources: 1,
      verifiedClaims: 1,
      lastRevised: '2026-01-02',
    })
  })

  it('takes its folders from the language list', async () => {
    const languages: WikiLanguage[] = [
      { label: '简体中文', folder: 'wiki-cn' },
      { label: 'English', folder: 'wiki' },
    ]
    fixture.files['wiki-cn/memory/Spacing Effect.md'] = '# Spacing Effect (中文)\n'

    const entries = await listWikiEntries({ generation: 2, asOf: '2026-03-01', languages })

    expect(entries.map((entry) => [entry.path, entry.translations.get('wiki')?.path])).toEqual([
      ['wiki-cn/memory/Spacing Effect.md', 'wiki/memory/Spacing Effect.md'],
    ])
  })

  it('counts inbound links without the hub indexes or the translations', async () => {
    await listWikiEntries({ generation: 1, asOf: '2026-03-01', languages: LANGUAGES })

    const citedByCall = mockInvoke.mock.calls.find(([, args]) =>
      String(args['sql']).includes('count(distinct'),
    )
    // Folders match as exact prefixes, so `_` or `%` in a folder name is literal.
    expect(citedByCall?.[1]['params']).toEqual(
      expect.arrayContaining(['wiki/', '%/index.md', 'wiki-cn/']),
    )
    expect(citedByCall?.[1]['params']).not.toContain('wiki/%')
  })

  it('re-reads only entries whose indexed hash changed, and everything in a new graph session', async () => {
    // The summary cache is module state: a generation no other test uses starts it empty.
    const options = { generation: 11, asOf: '2026-03-01', languages: LANGUAGES }
    await listWikiEntries(options)
    await listWikiEntries(options)
    expect(readsOf('wiki/memory/Spacing Effect.md')).toBe(1)
    expect(readsOf('wiki-cn/memory/Spacing Effect.md')).toBe(1)

    fixture.notes = fixture.notes.map((note) =>
      note.path === 'wiki/memory/Spacing Effect.md' ? { ...note, file_hash: 'h2' } : note,
    )
    await listWikiEntries(options)
    expect(readsOf('wiki/memory/Spacing Effect.md')).toBe(2)
    expect(readsOf('wiki/index.md')).toBe(1)

    await listWikiEntries({ ...options, generation: 12 })
    expect(readsOf('wiki/index.md')).toBe(2)
  })

  it('lists an evicted or vanished entry without a summary', async () => {
    fixture.evicted.add('wiki/memory/Spacing Effect.md')
    delete fixture.files['wiki/index.md']

    const entries = await listWikiEntries({
      generation: 3,
      asOf: '2026-03-01',
      languages: LANGUAGES,
    })

    expect(entries.map((entry) => entry.summary)).toEqual([null, null])
    expect(entries.map((entry) => entry.state)).toEqual(['unreadable', 'evicted'])
  })

  it('marks a file it cannot read on its own row instead of failing the list', async () => {
    const serveDefault = mockInvoke.getMockImplementation()
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'note_read_local' && args['path'] === 'wiki/index.md') {
        throw { kind: 'io', message: 'stream did not contain valid UTF-8' }
      }
      return await serveDefault?.(command, args)
    })

    const entries = await listWikiEntries({
      generation: 4,
      asOf: '2026-03-01',
      languages: LANGUAGES,
    })

    expect(entries.map((entry) => [entry.path, entry.state])).toEqual([
      ['wiki/index.md', 'unreadable'],
      ['wiki/memory/Spacing Effect.md', 'local'],
    ])
  })
})

describe('wikiCopies', () => {
  it('lists each language with its copy of the entry, or null where it has none', async () => {
    fixture.notes.push({
      path: 'wiki/memory/Retrieval.md',
      title: 'Retrieval',
      mtime: 1,
      file_hash: 'r',
    })

    await expect(wikiCopies('wiki-cn/memory/Spacing Effect.md', LANGUAGES)).resolves.toEqual([
      { language: LANGUAGES[0], path: 'wiki/memory/Spacing Effect.md' },
      { language: LANGUAGES[1], path: 'wiki-cn/memory/Spacing Effect.md' },
    ])
    await expect(wikiCopies('wiki/memory/Retrieval.md', LANGUAGES)).resolves.toEqual([
      { language: LANGUAGES[0], path: 'wiki/memory/Retrieval.md' },
      { language: LANGUAGES[1], path: null },
    ])
  })

  it('is empty for a note outside the wiki', async () => {
    await expect(wikiCopies('notes/plan.md', LANGUAGES)).resolves.toEqual([])
  })
})

describe('hasWikiEntries', () => {
  it('reports whether any note lives in the source folder', async () => {
    await expect(hasWikiEntries(LANGUAGES)).resolves.toBe(true)

    fixture.notes = []
    await expect(hasWikiEntries(LANGUAGES)).resolves.toBe(false)
  })
})
