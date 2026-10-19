import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { describe, expect, it, vi } from 'vitest'
import type { NoteFileService } from '../graph/note-file-service.ts'
import {
  createTestDatabaseService,
  seedNotes,
  type TestDatabaseService,
  type TestNote,
} from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createBacklinkService, type BacklinkService } from './backlink-service.ts'

function seeded(notes: readonly TestNote[]): TestDatabaseService {
  const database = createTestDatabaseService()
  seedNotes(database, notes)
  return database
}

describe('getBacklinksWithContext', () => {
  function setup(notes: readonly TestNote[]): {
    database: TestDatabaseService
    backlinks: BacklinkService
    reads: string[]
  } {
    const database = seeded(notes)
    const files = createTestNoteFileService({
      files: Object.fromEntries(notes.map((note) => [note.path, note.markdown])),
    })
    const reads: string[] = []
    const readFile = files.read.bind(files)
    vi.spyOn(files, 'read').mockImplementation(async (path, generation) => {
      reads.push(path)
      return await readFile(path, generation)
    })
    const noteFile: NoteFileService = files
    return {
      database,
      backlinks: createBacklinkService({
        database,
        noteFile,
        graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
      }),
      reads,
    }
  }

  it('pages complete sources in deterministic recency order and reads only included sources', async () => {
    const { backlinks, reads } = setup([
      { path: 'notes/target.md', markdown: '# target\n' },
      { path: 'daily/2026-07-01.md', markdown: 'daily [[target]]\n', mtime: 1 },
      { path: 'notes/older.md', markdown: 'older [[target]]\n', mtime: 1_000 },
      { path: 'notes/not-loaded.md', markdown: 'extra [[target]]\n', mtime: 500 },
      { path: 'notes/unrelated.md', markdown: 'no links\n', mtime: 5_000 },
    ])

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 2,
    })

    expect(page.contexts).toEqual([
      {
        sourcePath: 'daily/2026-07-01.md',
        sourceTitle: '2026-07-01',
        sourceDisplayTitle: null,
        sourceLang: null,
        sourcePrivate: false,
        snippet: 'daily [[target]]',
        posFrom: 6,
        tasks: [],
      },
      {
        sourcePath: 'notes/older.md',
        sourceTitle: 'older',
        sourceDisplayTitle: null,
        sourceLang: null,
        sourcePrivate: false,
        snippet: 'older [[target]]',
        posFrom: 6,
        tasks: [],
      },
    ])
    expect(page.nextCursor).toEqual({ recencyMs: 1_000, sourcePath: 'notes/older.md' })
    expect(page.indexedLinkCount).toBe(3)
    expect(reads.toSorted()).toEqual(['daily/2026-07-01.md', 'notes/older.md'])
  })

  it('uses the recency/path keyset after a cursor and returns null at the end', async () => {
    const { backlinks } = setup([
      { path: 'notes/target.md', markdown: '# target\n' },
      { path: 'notes/newer.md', markdown: 'newer [[target]]\n', mtime: 2_000 },
      { path: 'notes/previous.md', markdown: 'previous [[target]]\n', mtime: 1_000 },
      { path: 'notes/sibling.md', markdown: 'sibling [[target]]\n', mtime: 1_000 },
      { path: 'notes/next.md', markdown: 'next [[target]]\n', mtime: 900 },
    ])

    const first = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: { recencyMs: 1_000, sourcePath: 'notes/previous.md' },
      limit: 1,
    })
    expect(first.contexts.map((context) => context.sourcePath)).toEqual(['notes/sibling.md'])
    expect(first.nextCursor).toEqual({ recencyMs: 1_000, sourcePath: 'notes/sibling.md' })

    const second = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: first.nextCursor,
      limit: 1,
    })
    expect(second.contexts.map((context) => context.sourcePath)).toEqual(['notes/next.md'])
    expect(second.nextCursor).toBeNull()
    expect(second.indexedLinkCount).toBe(4)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid page limit (%s) before querying',
    async (limit) => {
      const { database, backlinks } = setup([])
      await expect(
        backlinks.getBacklinksWithContext('notes/target.md', { cursor: null, limit }),
      ).rejects.toThrow('positive safe integer')
      expect(database.getQueries()).toEqual([])
    },
  )

  it('extracts the block context around the link — a list item keeps its children', async () => {
    const { backlinks } = setup([
      { path: 'notes/target.md', markdown: '# target\n' },
      {
        path: 'notes/source.md',
        markdown: '- kickoff with [[target]]\n  - prep the agenda\n- unrelated\n',
      },
    ])

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 10,
    })

    expect(page.contexts.map((row) => row.snippet)).toEqual([
      '- kickoff with [[target]]\n  - prep the agenda',
    ])
  })

  it('co-groups sibling branches through the target aliases, not just the clicked spelling', async () => {
    const { backlinks } = setup([
      { path: 'notes/target.md', markdown: '---\naliases: [projx]\n---\n# Project X\n' },
      {
        path: 'notes/source.md',
        markdown: '- parent line\n  - one [[Project X]]\n  - two [[projx]]\n',
      },
    ])

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 10,
    })

    expect(page.contexts.map((row) => row.snippet)).toEqual([
      '- parent line\n  - one [[Project X]]\n  - two [[projx]]',
    ])
    expect(page.indexedLinkCount).toBe(2)
  })

  it('deduplicates a complete source while reporting the raw indexed link count', async () => {
    const { backlinks } = setup([
      { path: 'notes/target.md', markdown: '# target\n' },
      {
        path: 'notes/source.md',
        markdown: 'both [[target]] links on one [[target]] line\n\nanother [[target]] mention\n',
      },
    ])

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 1,
    })

    expect(page.contexts.map((row) => row.snippet)).toEqual([
      'both [[target]] links on one [[target]] line',
      'another [[target]] mention',
    ])
    expect(page.indexedLinkCount).toBe(3)
  })

  it('keeps a source that vanished from disk with an empty snippet', async () => {
    const database = seeded([
      { path: 'notes/target.md', markdown: '# target\n' },
      { path: 'notes/gone.md', markdown: 'gone [[target]]\n' },
    ])
    const backlinks = createBacklinkService({
      database,
      noteFile: createTestNoteFileService(),
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    })

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 10,
    })

    expect(page.contexts).toEqual([
      {
        sourcePath: 'notes/gone.md',
        sourceTitle: 'gone',
        sourceDisplayTitle: null,
        sourceLang: null,
        // An unreadable source fails closed.
        sourcePrivate: true,
        snippet: '',
        posFrom: 5,
        tasks: [],
      },
    ])
  })

  it('marks a source private by its index row, by the read it was cut from, or when unreadable', async () => {
    const link = 'see [[target]]\n'
    const database = seeded([
      { path: 'notes/target.md', markdown: '# target\n' },
      { path: 'notes/public.md', markdown: link, mtime: 4 },
      {
        path: 'notes/indexed-locked.md',
        markdown: `---\nprivate: true\n---\n${link}`,
        mtime: 3,
      },
      // Locked on disk before the index caught up: the row still says public
      // (an unrelated key of the same length keeps the link positions).
      { path: 'notes/just-locked.md', markdown: `---\nlocked0: true\n---\n${link}`, mtime: 2 },
      { path: 'notes/gone.md', markdown: link, mtime: 1 },
    ])
    const backlinks = createBacklinkService({
      database,
      noteFile: createTestNoteFileService({
        files: {
          'notes/public.md': link,
          'notes/indexed-locked.md': `---\nprivate: true\n---\n${link}`,
          'notes/just-locked.md': `---\nprivate: true\n---\n${link}`,
        },
      }),
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    })

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 10,
    })

    expect(
      page.contexts.map((context) => [context.sourcePath, context.sourcePrivate, context.snippet]),
    ).toEqual([
      ['notes/public.md', false, 'see [[target]]'],
      ['notes/indexed-locked.md', true, 'see [[target]]'],
      ['notes/just-locked.md', true, 'see [[target]]'],
      ['notes/gone.md', true, ''],
    ])
    const sourceQuery = database.getQueries().find(({ sql }) => sql.includes('select distinct'))
    expect(sourceQuery?.sql).toContain('"notes"."is_private"')
    expect(
      page.contexts.find((context) => context.sourcePath === 'notes/indexed-locked.md'),
    ).toMatchObject({ sourcePrivate: true })
  })

  it('carries the source’s display title and language for its row title', async () => {
    const { backlinks } = setup([
      { path: 'notes/target.md', markdown: '# target\n' },
      {
        path: 'notes/localized.md',
        markdown: '---\nlang: ja\n---\n# 東京メモ\nsee [[target]]\n',
      },
    ])

    const page = await backlinks.getBacklinksWithContext('notes/target.md', {
      cursor: null,
      limit: 10,
    })

    expect(page.contexts[0]).toMatchObject({
      sourcePath: 'notes/localized.md',
      sourceDisplayTitle: '東京メモ',
      sourceLang: 'ja',
    })
  })
})

describe('getBacklinks', () => {
  it('lists the raw resolved links into a note, by source path', async () => {
    const database = seeded([
      { path: 'notes/target.md', markdown: '---\naliases: [T]\n---\n# Target\n' },
      { path: 'notes/b.md', markdown: '[[Target]]\n' },
      { path: 'notes/a.md', markdown: 'x [[T|the target]]\n' },
      { path: 'notes/c.md', markdown: '[[Other]]\n' },
    ])
    const backlinks = createBacklinkService({
      database,
      noteFile: createTestNoteFileService(),
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
    })

    await expect(backlinks.getBacklinks('notes/target.md')).resolves.toEqual([
      { sourcePath: 'notes/a.md', targetRaw: 'T', alias: 'the target', posFrom: 2, posTo: 18 },
      { sourcePath: 'notes/b.md', targetRaw: 'Target', alias: null, posFrom: 0, posTo: 10 },
    ])
  })
})
