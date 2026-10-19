import { describe, expect, it } from 'vitest'
import { ReflectError } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { buildIndexedNote } from '../indexing/indexed-note.ts'
import { parseNote } from '../markdown/extract.ts'
import { createTestDatabaseService, type TestDatabaseService } from '../testing/database.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestNoteFileService, overrideNoteFileService } from '../testing/graph.ts'
import { createTestIpcBridgeService, type TestIpcBridgeService } from '../testing/ipc.ts'
import { wikiClaimTextHashes } from './claim-hashes.ts'
import { DEFAULT_WIKI_LANGUAGES, type WikiLanguage } from './languages.ts'
import { createWikiService } from './wiki-service.ts'

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
  '- 2026-01-02: Initial draft. #memory #learning',
].join('\n')

// A private translation that carries sync conflict markers, titled apart from
// its source, and linking back to it from its note on the source.
const TRANSLATION = [
  '---',
  'title: Spacing Effect (中文)',
  'private: true',
  '---',
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
  '',
  '<<<<<<< ours',
  'mine',
  '=======',
  'theirs',
  '>>>>>>> theirs',
].join('\n')

const SPACING = 'wiki/memory/Spacing Effect.md'
const SPACING_CN = 'wiki-cn/memory/Spacing Effect.md'
const HUB = 'wiki/index.md'

/**
 * One note of the test graph: its file, and the hash and time its index row carries.
 */
interface GraphNote {
  readonly markdown: string
  readonly mtime?: number
  readonly fileHash?: string
}

const GRAPH: Readonly<Record<string, GraphNote>> = {
  [SPACING_CN]: { markdown: TRANSLATION, mtime: 3, fileHash: 'cn' },
  [HUB]: { markdown: '# Wiki Index\n\n## Entries\n\n- [[Spacing Effect]]\n', mtime: 1 },
  [SPACING]: { markdown: ENTRY, mtime: 2, fileHash: 'h1' },
  // Four notes outside the wiki cite the entry; one of them twice.
  'notes/a.md': { markdown: '# A\n\nSee [[Spacing Effect]] and [[Spacing Effect]].\n' },
  'notes/b.md': { markdown: '# B\n\n[[Spacing Effect]]\n' },
  'notes/c.md': { markdown: '# C\n\n[[Spacing Effect]]\n' },
  'notes/index.md': { markdown: '# Notes Index\n\n[[Spacing Effect]]\n' },
}

/**
 * Project `note` at `path` into `database` through the real indexing pipeline.
 */
function project(database: TestDatabaseService, path: string, note: GraphNote): void {
  database.applyProjection(
    buildIndexedNote(parseNote({ path, source: note.markdown }), {
      fileHash: note.fileHash ?? `hash-${path}`,
      mtime: note.mtime ?? 0,
      source: note.markdown,
    }),
  )
}

interface Setup {
  readonly graph?: Readonly<Record<string, GraphNote>>
  readonly evicted?: readonly string[]
  /**
   * Paths whose index row stays while their file is gone.
   */
  readonly missing?: readonly string[]
  readonly generation?: number
  /**
   * Wraps the graph's files, as a failing disk would.
   */
  readonly noteFile?: (inner: NoteFileService) => NoteFileService
  readonly ipc?: TestIpcBridgeService
}

function setup(options: Setup = {}) {
  const graph = options.graph ?? GRAPH
  const database = createTestDatabaseService()
  const files: Record<string, string> = {}
  for (const [path, note] of Object.entries(graph)) {
    project(database, path, note)
    if (!(options.missing ?? []).includes(path)) {
      files[path] = note.markdown
    }
  }
  const inner = createTestNoteFileService({ files, evicted: options.evicted ?? [] })
  // Every `readLocal`, with the generation it was pinned to.
  const reads: { path: string; generation: number }[] = []
  const counted = overrideNoteFileService(inner, {
    readLocal: async (path, generation, readOptions) => {
      reads.push({ path, generation })
      return await inner.readLocal(path, generation, readOptions)
    },
  })
  const graphSession = createTestGraphSessionService({
    graph: { generation: options.generation ?? 1 },
  })
  const ipc = options.ipc ?? createTestIpcBridgeService()
  const wiki = createWikiService({
    ipc,
    database,
    noteFile: options.noteFile?.(counted) ?? counted,
    graphSession,
  })
  const readsOf = (path: string): number => reads.filter((read) => read.path === path).length
  return { wiki, database, graphSession, ipc, reads, readsOf }
}

describe('WikiService.listEntries', () => {
  it('lists source-language notes with topic, translations, inbound links, tags, and claims', async () => {
    const { wiki } = setup()

    const entries = await wiki.listEntries({ asOf: '2026-03-01', languages: LANGUAGES })

    expect(entries.map((entry) => entry.path)).toEqual([HUB, SPACING])
    const [index, spacing] = entries
    expect(index).toMatchObject({ topic: null, citedBy: 0, tags: [] })
    expect(index?.translations.size).toBe(0)
    expect(index?.summary?.claims).toBe(0)
    expect(spacing).toMatchObject({
      title: 'Spacing Effect',
      topic: 'memory',
      isPrivate: false,
      hasConflict: false,
      mtime: 2,
      state: 'local',
      preview: 'Spaced sessions beat cramming.',
      revised: '2026-01-02',
      citedBy: 4,
      tags: ['learning', 'memory'],
    })
    expect(spacing?.translations.get('wiki-cn')).toEqual({
      path: SPACING_CN,
      title: 'Spacing Effect (中文)',
      displayTitle: null,
      lang: null,
      isPrivate: true,
      hasConflict: true,
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
    const { wiki } = setup({
      graph: { ...GRAPH, [SPACING_CN]: { markdown: '# Spacing Effect (中文)\n' } },
    })

    const entries = await wiki.listEntries({ asOf: '2026-03-01', languages })

    expect(entries.map((entry) => [entry.path, entry.translations.get('wiki')?.path])).toEqual([
      [SPACING_CN, SPACING],
    ])
  })

  it('counts inbound links without the hub indexes or the translations, matching folders exactly', async () => {
    const languages: WikiLanguage[] = [
      { label: 'English', folder: 'wiki' },
      { label: '简体中文', folder: 'wiki_cn' },
    ]
    const cite = '# Note\n\n[[Spacing Effect]]\n'
    const { wiki } = setup({
      graph: {
        [SPACING]: { markdown: ENTRY },
        // Excluded: a hub index inside the wiki, and a translation.
        [HUB]: { markdown: cite },
        'wiki/memory/index.md': { markdown: cite },
        'wiki_cn/memory/Spacing Effect.md': { markdown: cite },
        // Counted: folders match case-sensitively and `_` in a folder name is
        // literal, an index outside the wiki is an ordinary note, and so is a
        // note in a folder that only shares the wiki folder's prefix.
        'WIKI_CN/a.md': { markdown: cite },
        'wikiXcn/b.md': { markdown: cite },
        'notes/index.md': { markdown: cite },
        'wiki-archive/c.md': { markdown: cite },
      },
    })

    const entries = await wiki.listEntries({ asOf: '2026-03-01', languages })

    expect(entries.find((entry) => entry.path === SPACING)?.citedBy).toBe(4)
  })

  it('re-reads only entries whose indexed hash changed, and everything in a new graph session', async () => {
    const { wiki, database, graphSession, reads, readsOf } = setup({ generation: 11 })
    const options = { asOf: '2026-03-01', languages: LANGUAGES }

    await wiki.listEntries(options)
    await wiki.listEntries(options)
    expect(readsOf(SPACING)).toBe(1)
    expect(readsOf(SPACING_CN)).toBe(1)

    project(database, SPACING, { markdown: ENTRY, mtime: 2, fileHash: 'h2' })
    await wiki.listEntries(options)
    expect(readsOf(SPACING)).toBe(2)
    expect(readsOf(HUB)).toBe(1)

    graphSession.setGraph({ generation: 12 })
    await wiki.listEntries(options)
    expect(readsOf(HUB)).toBe(2)
    // Every read is pinned to the session the list began in.
    expect(new Set(reads.map((read) => read.generation))).toEqual(new Set([11, 12]))
    expect(reads.filter((read) => read.generation === 12).map((read) => read.path)).toEqual(
      expect.arrayContaining([HUB, SPACING, SPACING_CN]),
    )
  })

  it('lists an evicted or vanished entry without a summary', async () => {
    const { wiki } = setup({ evicted: [SPACING], missing: [HUB] })

    const entries = await wiki.listEntries({ asOf: '2026-03-01', languages: LANGUAGES })

    expect(entries.map((entry) => entry.summary)).toEqual([null, null])
    expect(entries.map((entry) => entry.state)).toEqual(['unreadable', 'evicted'])
  })

  it('marks a file it cannot read on its own row instead of failing the list', async () => {
    const { wiki } = setup({
      noteFile: (inner) =>
        overrideNoteFileService(inner, {
          readLocal: async (path, generation) => {
            if (path === HUB) {
              throw new ReflectError('io', 'stream did not contain valid UTF-8')
            }
            return await inner.readLocal(path, generation)
          },
        }),
    })

    const entries = await wiki.listEntries({ asOf: '2026-03-01', languages: LANGUAGES })

    expect(entries.map((entry) => [entry.path, entry.state])).toEqual([
      [HUB, 'unreadable'],
      [SPACING, 'local'],
    ])
  })

  it('fails the list on an error that is not a read failure', async () => {
    const { wiki } = setup({
      noteFile: (inner) =>
        overrideNoteFileService(inner, {
          readLocal: async () => {
            throw new TypeError('broken')
          },
        }),
    })

    await expect(wiki.listEntries({ asOf: '2026-03-01', languages: LANGUAGES })).rejects.toThrow(
      'broken',
    )
  })

  it('rejects when no graph is open', async () => {
    const { wiki, graphSession, database } = setup()
    graphSession.setGraph(null)

    await expect(wiki.listEntries({ asOf: '2026-03-01', languages: LANGUAGES })).rejects.toThrow(
      'No graph is open.',
    )
    expect(database.getQueries()).toEqual([])
  })
})

describe('WikiService.copies', () => {
  it('lists each language with its copy of the entry, or null where it has none', async () => {
    const { wiki } = setup({
      graph: { ...GRAPH, 'wiki/memory/Retrieval.md': { markdown: '# Retrieval\n' } },
    })

    await expect(wiki.copies(SPACING_CN, LANGUAGES)).resolves.toEqual([
      { language: LANGUAGES[0], path: SPACING },
      { language: LANGUAGES[1], path: SPACING_CN },
    ])
    await expect(wiki.copies('wiki/memory/Retrieval.md', LANGUAGES)).resolves.toEqual([
      { language: LANGUAGES[0], path: 'wiki/memory/Retrieval.md' },
      { language: LANGUAGES[1], path: null },
    ])
  })

  it('is empty for a note outside the wiki', async () => {
    const { wiki } = setup()

    await expect(wiki.copies('notes/plan.md', LANGUAGES)).resolves.toEqual([])
  })
})

describe('WikiService.ancestors', () => {
  it('lists the existing indexes above a note, root first, skipping folders without one', async () => {
    const { wiki } = setup({
      graph: {
        ...GRAPH,
        'wiki/memory/index.md': { markdown: '# Memory\n' },
        'wiki/memory/deep/sub/Note.md': { markdown: '# Note\n' },
      },
    })

    await expect(wiki.ancestors('wiki/memory/deep/sub/Note.md', LANGUAGES)).resolves.toEqual([
      { path: HUB, title: 'Wiki Index', displayTitle: null, lang: null },
      { path: 'wiki/memory/index.md', title: 'Memory', displayTitle: null, lang: null },
    ])
    await expect(wiki.ancestors('wiki/memory/index.md', LANGUAGES)).resolves.toEqual([
      { path: HUB, title: 'Wiki Index', displayTitle: null, lang: null },
    ])
  })

  it('stays in the note’s own language', async () => {
    const { wiki } = setup()

    await expect(wiki.ancestors(SPACING_CN, LANGUAGES)).resolves.toEqual([])
  })

  it('is empty without asking the index for a root index or a note outside the wiki', async () => {
    const { wiki, database } = setup()

    await expect(wiki.ancestors(HUB, LANGUAGES)).resolves.toEqual([])
    await expect(wiki.ancestors('notes/plan.md', LANGUAGES)).resolves.toEqual([])
    expect(database.getQueries()).toEqual([])
  })
})

describe('WikiService.hasEntries', () => {
  it('reports whether any note lives in the source folder', async () => {
    await expect(setup().wiki.hasEntries(LANGUAGES)).resolves.toBe(true)
    await expect(
      setup({ graph: { 'notes/a.md': { markdown: '# A\n' } } }).wiki.hasEntries(LANGUAGES),
    ).resolves.toBe(false)
  })
})

describe('WikiService.readTrustReportFile', () => {
  it('reads the report pinned to the open graph session', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        wiki_trust_report_read: (args) =>
          args['knownStamp'] === 's1'
            ? { stamp: 's1', contents: null }
            : { stamp: 's1', contents: '{}' },
      },
    })
    const { wiki } = setup({ ipc, generation: 3 })

    await expect(wiki.readTrustReportFile('.harness/wiki-trust.json', null)).resolves.toEqual({
      stamp: 's1',
      contents: '{}',
    })
    await expect(wiki.readTrustReportFile('.harness/wiki-trust.json', 's1')).resolves.toEqual({
      stamp: 's1',
      contents: null,
    })
    expect(ipc.calls()).toEqual([
      {
        command: 'wiki_trust_report_read',
        args: { path: '.harness/wiki-trust.json', knownStamp: null, generation: 3 },
      },
      {
        command: 'wiki_trust_report_read',
        args: { path: '.harness/wiki-trust.json', knownStamp: 's1', generation: 3 },
      },
    ])
  })

  it('is null when no report is there', async () => {
    const ipc = createTestIpcBridgeService({ commands: { wiki_trust_report_read: () => null } })
    const { wiki } = setup({ ipc })

    await expect(wiki.readTrustReportFile('.harness/wiki-trust.json', null)).resolves.toBeNull()
  })

  it('rejects without reading when no graph is open', async () => {
    const ipc = createTestIpcBridgeService({ commands: { wiki_trust_report_read: () => null } })
    const { wiki, graphSession } = setup({ ipc })
    graphSession.setGraph(null)

    await expect(wiki.readTrustReportFile('.harness/wiki-trust.json', null)).rejects.toThrow(
      'No graph is open.',
    )
    expect(ipc.calls()).toEqual([])
  })
})

describe('WikiService.readSavedClaims', () => {
  const ARTICLE = [
    '# T',
    '',
    'Lead <!-- claim:c1 -->**first**<!-- /claim:c1 --> and <!-- claim:c4 -->second<!-- /claim:c4 -->.',
    '',
    '## Evidence',
    '',
    '```anchors c1',
    '```',
    '',
  ].join('\n')

  it('hashes the saved claims as the harness reads them, pinned to the open graph', async () => {
    const { wiki, reads } = setup({
      graph: { 'wiki/article.md': { markdown: ARTICLE } },
      generation: 4,
    })

    const saved = await wiki.readSavedClaims('wiki/article.md', '2026-03-01')

    const hashes = await wikiClaimTextHashes(ARTICLE, '2026-03-01')
    expect([...hashes.keys()]).toEqual(['c1', 'c4'])
    expect(saved).toEqual({ content: ARTICLE, hashes })
    expect(reads).toEqual([{ path: 'wiki/article.md', generation: 4 }])
  })

  it('reports an evicted file without downloading it', async () => {
    const { wiki } = setup({
      graph: { 'wiki/article.md': { markdown: ARTICLE } },
      evicted: ['wiki/article.md'],
    })

    await expect(wiki.readSavedClaims('wiki/article.md', '2026-03-01')).resolves.toBe('evicted')
  })

  it('rejects on a failed read and without a graph', async () => {
    const { wiki, graphSession } = setup({ graph: {} })

    await expect(wiki.readSavedClaims('wiki/gone.md', '2026-03-01')).rejects.toThrow()
    graphSession.setGraph(null)
    await expect(wiki.readSavedClaims('wiki/gone.md', '2026-03-01')).rejects.toThrow(
      'No graph is open.',
    )
  })
})
