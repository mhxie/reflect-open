import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileMeta } from '../graph/schemas.ts'
import { setBridge } from '../ipc/bridge.ts'
import {
  buildAttachmentLibrary,
  listAttachmentNoteTags,
  listAttachmentReferences,
  type AttachmentReferenceRow,
} from './attachment-library.ts'

function file(path: string, modifiedMs: number, extra: Partial<FileMeta> = {}): FileMeta {
  return { path, size: 100, modifiedMs, ...extra }
}

function reference(assetPath: string, notePath: string, mtime = 1): AttachmentReferenceRow {
  return { assetPath, notePath, title: notePath, mtime, isPrivate: false, hasConflict: false }
}

describe('buildAttachmentLibrary', () => {
  it('keeps media files only, newest first with the path breaking ties', () => {
    const library = buildAttachmentLibrary(
      [
        file('assets/old.png', 10),
        file('assets/table.csv', 50),
        file('assets/b.pdf', 30),
        file('assets/a.mp4', 30),
        file('audio-memos/memo.webm', 20),
      ],
      [],
    )

    expect(library.map((entry) => [entry.path, entry.type])).toEqual([
      ['assets/a.mp4', 'video'],
      ['assets/b.pdf', 'pdf'],
      ['audio-memos/memo.webm', 'audio'],
      ['assets/old.png', 'image'],
    ])
  })

  it('links notes by exact path or bare filename, once each, most recent first', () => {
    const [entry] = buildAttachmentLibrary(
      [file('assets/photo.png', 1)],
      [
        {
          ...reference('assets/photo.png', 'notes/trip.md', 5),
          isPrivate: true,
          hasConflict: true,
        },
        reference('photo.png', 'daily/2026-10-01.md', 9),
        { ...reference('photo.png', 'notes/trip.md', 5), isPrivate: true, hasConflict: true },
        reference('notes/assets/photo.png', 'notes/other.md', 7),
        reference('assets/other.png', 'notes/unrelated.md', 8),
      ],
    )

    expect(entry?.notes).toEqual([
      {
        path: 'daily/2026-10-01.md',
        title: 'daily/2026-10-01.md',
        mtime: 9,
        tags: [],
        isPrivate: false,
        hasConflict: false,
      },
      {
        path: 'notes/trip.md',
        title: 'notes/trip.md',
        mtime: 5,
        tags: [],
        isPrivate: true,
        hasConflict: true,
      },
    ])
  })

  it('credits every file a spelling could name rather than lose a link', () => {
    // The rows of `![](media/photo.png)` in notes/trip.md, and of two separate
    // links `/media/photo.png` and `/notes/media/photo.png`, look the same:
    // both files are credited, so neither real link is dropped.
    const library = buildAttachmentLibrary(
      [file('notes/media/photo.png', 2), file('media/photo.png', 1)],
      [
        reference('notes/media/photo.png', 'notes/trip.md'),
        reference('media/photo.png', 'notes/trip.md'),
        reference('media/photo.png', 'root.md'),
      ],
    )

    expect(library.map((entry) => [entry.path, entry.notes.map((note) => note.path)])).toEqual([
      ['notes/media/photo.png', ['notes/trip.md']],
      ['media/photo.png', ['notes/trip.md', 'root.md']],
    ])
  })

  it('credits a root-level bare row to the root file as well as the nearest one', () => {
    // `/photo.png` or `../photo.png` in notes/trip.md stores `photo.png`, just
    // as `![[photo.png]]` does: the root file it may render keeps the link.
    const library = buildAttachmentLibrary(
      [file('notes/photo.png', 2), file('photo.png', 1)],
      [reference('photo.png', 'notes/trip.md')],
    )

    expect(library.map((entry) => [entry.path, entry.notes.map((note) => note.path)])).toEqual([
      ['notes/photo.png', ['notes/trip.md']],
      ['photo.png', ['notes/trip.md']],
    ])
  })

  it('credits a vault-root or wiki-embed spelling to the file it names', () => {
    // `![](/media/photo.png)` or `![[media/photo.png]]` in notes/trip.md stores
    // one path; a source-relative twin on disk must not claim it.
    const library = buildAttachmentLibrary(
      [file('notes/media/photo.png', 2), file('media/photo.png', 1)],
      [reference('media/photo.png', 'notes/trip.md')],
    )

    expect(library.map((entry) => [entry.path, entry.notes.map((note) => note.path)])).toEqual([
      ['notes/media/photo.png', []],
      ['media/photo.png', ['notes/trip.md']],
    ])
  })

  it('credits a relative link to its vault-root file when the source-relative one is missing', () => {
    const [entry] = buildAttachmentLibrary(
      [file('media/photo.png', 1)],
      [
        reference('notes/media/photo.png', 'notes/trip.md'),
        reference('media/photo.png', 'notes/trip.md'),
      ],
    )

    expect(entry?.notes.map((note) => note.path)).toEqual(['notes/trip.md'])
  })

  it('credits a bare filename to one same-named file, not all of them', () => {
    const library = buildAttachmentLibrary(
      [file('a/x.png', 2), file('b/c/x.png', 1)],
      [reference('x.png', 'notes/n.md')],
    )

    expect(library.flatMap((entry) => entry.notes)).toHaveLength(1)
  })

  it('carries each linked note’s tags, in the order the rows give them', () => {
    const [entry] = buildAttachmentLibrary(
      [file('assets/photo.png', 1)],
      [reference('assets/photo.png', 'notes/trip.md')],
      [
        { notePath: 'notes/trip.md', tag: 'Japan' },
        { notePath: 'notes/other.md', tag: 'work' },
        { notePath: 'notes/trip.md', tag: 'travel' },
      ],
    )

    expect(entry?.notes.map((note) => note.tags)).toEqual([['Japan', 'travel']])
  })

  it('keeps unlinked files and carries the iCloud placeholder flag', () => {
    const library = buildAttachmentLibrary(
      [file('assets/stray.jpg', 2), file('assets/evicted.png', 1, { placeholder: true })],
      [],
    )

    expect(library).toEqual([
      {
        path: 'assets/stray.jpg',
        type: 'image',
        size: 100,
        modifiedMs: 2,
        placeholder: false,
        notes: [],
      },
      {
        path: 'assets/evicted.png',
        type: 'image',
        size: 100,
        modifiedMs: 1,
        placeholder: true,
        notes: [],
      },
    ])
  })
})

describe('attachment reference queries', () => {
  // A fake bridge resolves `db_query` so the test exercises the real compiled
  // SQL — the same harness note-list.test uses.
  const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

  beforeEach(() => {
    mockInvoke.mockReset()
    setBridge({ invoke: mockInvoke, listen: async () => () => {} })
  })

  afterEach(() => {
    setBridge(null)
  })

  it('reads the body tags of notes with media references, by subquery', async () => {
    mockInvoke.mockResolvedValueOnce([{ note_path: 'notes/trip.md', tag: 'travel' }])

    expect(await listAttachmentNoteTags()).toEqual([{ notePath: 'notes/trip.md', tag: 'travel' }])
    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags" where "tags"."note_path" in (select "assets"."note_path"')
    expect(sql).toContain('"assets"."asset_path" like ?')
    expect(sql).toContain('order by "tags"."tag_key"')
  })

  it('reads media references from regular and daily notes with their titles', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        asset_path: 'assets/photo.png',
        note_path: 'notes/trip.md',
        title: 'Trip',
        mtime: 4,
        is_private: 1,
        has_conflict: 1,
      },
    ])

    const rows = await listAttachmentReferences()

    expect(rows).toEqual([
      {
        assetPath: 'assets/photo.png',
        notePath: 'notes/trip.md',
        title: 'Trip',
        mtime: 4,
        isPrivate: true,
        hasConflict: true,
      },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('inner join "notes" on "notes"."path" = "assets"."note_path"')
    expect(sql).toContain('"notes"."is_private"')
    expect(sql).toContain('"notes"."has_conflict"')
    expect(mockInvoke).toHaveBeenCalledTimes(1)
    expect(sql).toContain('"notes"."kind" in (?, ?)')
    expect(sql).toContain('"assets"."asset_path" like ?')
    const parameters = args['params']
    expect(parameters).toEqual(expect.arrayContaining(['note', 'daily', '%.png', '%.pdf']))
    expect(parameters).not.toContain('%.zip')
  })
})
