import { describe, expect, it } from 'vitest'
import { noteBodyHash } from '../markdown/body-hash.ts'
import { upsertFrontmatter } from '../markdown/frontmatter.ts'
import { createNodeTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import {
  createNoteListService,
  firstExistingAttachment,
  type NoteListService,
} from './note-list-service.ts'

const NOTES: TestNote[] = [
  {
    path: 'notes/pinned.md',
    markdown: '---\npinned: 1\n---\n# Pinned Plan\nAlways on top.\n',
    mtime: 500,
  },
  { path: 'notes/first-pin.md', markdown: '---\npinned: 0\n---\n# First Pin\n', mtime: 100 },
  { path: 'notes/bare-pin.md', markdown: '---\npinned: true\n---\n# Bare Pin\n', mtime: 3000 },
  {
    path: 'notes/health.md',
    markdown: '# Health Stacked\nShop your health goals. #link #Health\n',
    mtime: 2000,
  },
  { path: 'notes/older.md', markdown: '# Older\n#book\n', mtime: 1000 },
  {
    path: 'notes/secret.md',
    markdown: '---\nprivate: true\n---\n# Secret\n#book\n',
    mtime: 4000,
  },
  { path: 'daily/2026-06-09.md', markdown: 'Read a #Book.\n', mtime: 1500 },
  { path: 'templates/reading.md', markdown: '# Reading\n#book\n', mtime: 5000 },
]

function setup(notes: TestNote[] = NOTES) {
  const database = createNodeTestDatabaseService()
  seedNotes(database, notes)
  const noteList: NoteListService = createNoteListService({ database })
  return { database, noteList }
}

/**
 * Local epoch milliseconds of noon on `date`.
 */
function localNoon(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year!, month! - 1, day, 12).getTime()
}

describe('listNotes', () => {
  it('lists non-daily notes pinned-first then newest with stored previews and sorted tags', async () => {
    const { database, noteList } = setup()
    const entries = await noteList.listNotes()

    expect(entries.map((entry) => entry.path)).toEqual([
      'notes/first-pin.md',
      'notes/pinned.md',
      'notes/bare-pin.md',
      'notes/secret.md',
      'notes/health.md',
      'notes/older.md',
    ])
    expect(entries[1]).toEqual({
      path: 'notes/pinned.md',
      title: 'Pinned Plan',
      displayTitle: null,
      lang: null,
      mtime: 500,
      snippet: 'Always on top.',
      tags: [],
      isPinned: true,
      pinnedOrder: 1,
      isPrivate: false,
    })
    expect(entries[3]).toMatchObject({ path: 'notes/secret.md', isPrivate: true })
    expect(entries[4]).toMatchObject({
      path: 'notes/health.md',
      tags: ['Health', 'link'],
      isPinned: false,
      pinnedOrder: null,
    })

    const [list, tags] = database.getQueries()
    // The snippet is the stored projection column, not a per-query derivation.
    expect(list?.sql).toContain('"preview"')
    expect(list?.sql).toContain('"notes"."is_private"')
    // Uncapped: the screen virtualizes instead.
    expect(list?.sql).not.toContain('limit')
    // The tag fetch joins the same note predicates — never a `note_path IN`
    // list, whose per-row parameter would hit SQLite's bound-parameter
    // ceiling on large graphs.
    expect(tags?.sql).toContain('inner join "notes"')
    expect(tags?.sql).not.toContain(' in (')
    expect(tags?.params).toEqual(['note'])
  })

  it('includes dailies and their tags when a caller will filter by path', async () => {
    const { database, noteList } = setup()

    const entries = await noteList.listNotes({ includeDaily: true })

    expect(entries.find((entry) => entry.path === 'daily/2026-06-09.md')?.tags).toEqual(['Book'])
    expect(entries.map((entry) => entry.path)).not.toContain('templates/reading.md')
    const queries = database.getQueries()
    expect(queries).toHaveLength(2)
    for (const query of queries) {
      expect(query.sql).toContain('"notes"."kind" in (?, ?)')
      expect(query.params).toEqual(['note', 'daily'])
    }
  })

  it('shows a fresh AI summary in place of the opening text', async () => {
    const body = '# Long\nThe opening line.\n'
    const summarized = upsertFrontmatter(body, {
      aiSummary: { text: 'What the note is about.', hash: noteBodyHash(body) },
    })
    const stale = upsertFrontmatter('# Stale\nIts own first line.\n', {
      aiSummary: { text: 'An older summary.', hash: noteBodyHash('# Stale\nOlder body.\n') },
    })
    const { database, noteList } = setup([
      { path: 'notes/long.md', markdown: summarized, mtime: 2000 },
      { path: 'notes/stale.md', markdown: stale, mtime: 1000 },
    ])

    const entries = await noteList.listNotes()

    expect(entries.map((entry) => entry.snippet)).toEqual([
      'What the note is about.',
      'Its own first line.',
    ])
    expect(database.getQueries()[0]?.sql).toContain('"notes"."summary"')
  })

  it('narrows to one tag case-insensitively and includes tagged daily notes', async () => {
    const { database, noteList } = setup()
    const entries = await noteList.listNotes({ tag: 'BOOK' })

    expect(entries.map((entry) => entry.path)).toEqual([
      'notes/secret.md',
      'daily/2026-06-09.md',
      'notes/older.md',
    ])
    expect(entries[1]?.tags).toEqual(['Book'])

    const [list, tags] = database.getQueries()
    expect(list?.sql).toContain('from "tags"')
    expect(list?.sql).not.toContain('exists')
    expect(list?.sql).not.toContain('lower(')
    expect(list?.params).toEqual(['book', 'note', 'daily'])
    expect(tags?.sql).toContain('inner join "tags" as "filter_tags"')
    expect(tags?.params).toEqual(['book', 'note', 'daily'])
  })

  it('narrows to notes referencing an attachment type, daily notes included', async () => {
    const { database, noteList } = setup([
      { path: 'papers/socc.md', markdown: '# SoCC\n![paper](papers/socc.pdf) #paper\n', mtime: 2 },
      { path: 'daily/2026-10-02.md', markdown: 'Read ![](assets/z.PDF)\n', mtime: 1 },
      { path: 'notes/photo.md', markdown: '# Photo\n![](assets/a.png)\n', mtime: 3 },
      { path: 'templates/form.md', markdown: '# Form\n![](assets/form.pdf)\n', mtime: 4 },
    ])

    const entries = await noteList.listNotes({ attachment: 'pdf' })

    expect(entries.map((entry) => [entry.path, entry.tags])).toEqual([
      ['papers/socc.md', ['paper']],
      ['daily/2026-10-02.md', []],
    ])
    for (const query of database.getQueries()) {
      expect(query.sql).toContain(
        '"notes"."path" in (select "assets"."note_path" as "path" from "assets"',
      )
      expect(query.sql).toContain('"assets"."asset_path" like ?')
      expect(query.sql).not.toContain('union')
      expect(query.params).toEqual(expect.arrayContaining(['note', 'daily', '%.pdf']))
    }
  })

  it('narrows to notes edited on a local day, plus that day’s daily note', async () => {
    const { database, noteList } = setup([
      { path: 'notes/edited.md', markdown: '# Edited\n', mtime: localNoon('2026-10-02') },
      { path: 'notes/before.md', markdown: '# Before\n', mtime: localNoon('2026-10-01') },
      // Named after the day but edited later: still listed on its day.
      { path: 'daily/2026-10-02.md', markdown: 'Today.\n', mtime: localNoon('2026-10-05') },
    ])

    const entries = await noteList.listNotes({ updatedOn: '2026-10-02' })

    expect(entries.map((entry) => entry.path).sort()).toEqual([
      'daily/2026-10-02.md',
      'notes/edited.md',
    ])
    const start = new Date(2026, 9, 2).getTime()
    const end = new Date(2026, 9, 3).getTime()
    const queries = database.getQueries()
    expect(queries).toHaveLength(2)
    for (const query of queries) {
      expect(query.sql).toContain('"notes"."daily_date" =')
      expect(query.params).toEqual(
        expect.arrayContaining(['note', 'daily', start, end, '2026-10-02']),
      )
    }
  })

  it('lists nothing for an invalid edit day', async () => {
    const { database, noteList } = setup()
    await expect(noteList.listNotes({ updatedOn: '2026-02-31' })).resolves.toEqual([])
    expect(database.getQueries()).toEqual([])
  })

  it('lets a tag filter win over an edit day', async () => {
    const { database, noteList } = setup()

    await noteList.listNotes({ tag: 'book', updatedOn: '2026-10-02' })

    expect(database.getQueries()[0]?.sql).not.toContain('mtime" >=')
  })

  it('counts YouTube links as video alongside local video files', async () => {
    const { database, noteList } = setup([
      { path: 'notes/talk.md', markdown: '# Talk\n[talk](https://www.youtube.com/watch?v=x)\n' },
      { path: 'notes/clip.md', markdown: '# Clip\n![](assets/clip.mp4)\n' },
      { path: 'notes/text.md', markdown: '# Text\nNo media.\n' },
    ])

    const entries = await noteList.listNotes({ attachment: 'video' })

    expect(entries.map((entry) => entry.path).sort()).toEqual(['notes/clip.md', 'notes/talk.md'])
    const [list] = database.getQueries()
    expect(list?.sql).toContain('union select "links"."source_path" as "path" from "links"')
    expect(list?.params).toEqual(
      expect.arrayContaining(['%.mp4', '%.mov', 'md', '%youtube.com/watch%', '%youtu.be/%']),
    )
  })

  it('counts every audio-memos recording as audio and never as video', async () => {
    const recording = { path: 'notes/memo.md', markdown: '# Memo\n![](audio-memos/memo.webm)\n' }
    const { database, noteList } = setup([recording])

    await expect(noteList.listNotes({ attachment: 'audio' })).resolves.toMatchObject([
      { path: 'notes/memo.md' },
    ])
    expect(database.getQueries()[0]?.params).toEqual(
      expect.arrayContaining(['%.m4a', 'audio-memos/%', '%/audio-memos/%']),
    )

    const video = setup([recording])
    await expect(video.noteList.listNotes({ attachment: 'video' })).resolves.toEqual([])
    const [videoList] = video.database.getQueries()
    expect(videoList?.sql).toContain('not (')
    expect(videoList?.params).toEqual(
      expect.arrayContaining(['%.webm', 'audio-memos/%', '%/audio-memos/%']),
    )
  })

  it('applies one filter at a time, the tag over the attachment type', async () => {
    const { database, noteList } = setup()

    await noteList.listNotes({ tag: 'Book', attachment: 'pdf' })

    const [list] = database.getQueries()
    expect(list?.sql).not.toContain('"assets"')
    expect(list?.params).toEqual(['book', 'note', 'daily'])
  })

  it('skips the tag fetch entirely when no notes match', async () => {
    const { database, noteList } = setup()

    await expect(noteList.listNotes({ tag: 'nothing' })).resolves.toEqual([])
    expect(database.getQueries()).toHaveLength(1)
  })
})

describe('listRecentNotes', () => {
  it('caps public non-daily rows, newest first, with a boolean privacy flag', async () => {
    const { database, noteList } = setup()

    await expect(noteList.listRecentNotes({ limit: 2 })).resolves.toEqual([
      {
        path: 'notes/bare-pin.md',
        title: 'Bare Pin',
        preview: '',
        mtime: 3000,
        isPrivate: false,
      },
      {
        path: 'notes/health.md',
        title: 'Health Stacked',
        preview: 'Shop your health goals. #link #Health',
        mtime: 2000,
        isPrivate: false,
      },
    ])
    expect(database.getQueries()[0]?.params).toEqual(['note', 0, 2])
  })

  it('includes private rows for a local-only caller', async () => {
    const { noteList } = setup()

    const rows = await noteList.listRecentNotes({ limit: 1, includePrivate: true })

    expect(rows).toEqual([
      { path: 'notes/secret.md', title: 'Secret', preview: '#book', mtime: 4000, isPrivate: true },
    ])
  })

  it('narrows to one tag via the stored folded tag key', async () => {
    const { database, noteList } = setup()
    const rows = await noteList.listRecentNotes({ limit: 5, tag: 'Book' })

    expect(rows.map((row) => row.path)).toEqual(['notes/older.md'])
    const [query] = database.getQueries()
    expect(query?.sql).not.toContain('exists')
    expect(query?.sql).not.toContain('lower(')
    expect(query?.params).toEqual(['book', 'note', 0, 5])
  })
})

describe('listNoteTags', () => {
  it('groups tags on the stored key over non-daily notes, alphabetical', async () => {
    await expect(setup().noteList.listNoteTags()).resolves.toEqual([
      { tag: 'book', count: 2 },
      { tag: 'Health', count: 1 },
      { tag: 'link', count: 1 },
    ])
  })
})

describe('listAttachmentPreviews', () => {
  it('maps each note to its attachments of the type, in document order', async () => {
    const { database, noteList } = setup([
      {
        path: 'papers/socc.md',
        markdown: '# SoCC\n![](z.pdf)\n![](assets/a.pdf)\n![](assets/photo.png)\n',
      },
      { path: 'notes/trip.md', markdown: '# Trip\n![](/assets/map.pdf)\n' },
    ])

    const previews = await noteList.listAttachmentPreviews('pdf')

    expect(previews.get('notes/trip.md')).toEqual(['assets/map.pdf'])
    // Each reference contributes its candidate spellings, in resolution
    // order, and the references keep their document order.
    const paper = previews.get('papers/socc.md') ?? []
    expect(paper.indexOf('papers/z.pdf')).toBeLessThan(paper.indexOf('papers/assets/a.pdf'))
    expect(paper).toContain('z.pdf')
    expect(paper.some((path) => path.endsWith('.png'))).toBe(false)
    const [query] = database.getQueries()
    expect(query?.sql).toContain('order by "assets"."rowid"')
    expect(query?.sql).not.toContain('min(')
    expect(query?.params).toEqual(['%.pdf'])
  })
})

describe('attachment library reads', () => {
  it('reads media references from regular and daily notes with their titles', async () => {
    const { database, noteList } = setup([
      {
        path: 'notes/trip.md',
        markdown: '---\nprivate: true\n---\n# Trip\n![](/assets/photo.png)\n',
        mtime: 4,
      },
      { path: 'daily/2026-10-01.md', markdown: '![](/assets/photo.png)\n', mtime: 9 },
      { path: 'notes/archive.md', markdown: '# Archive\n[data](/assets/data.zip)\n', mtime: 2 },
      { path: 'templates/t.md', markdown: '# T\n![](/assets/photo.png)\n', mtime: 5 },
    ])

    const rows = await noteList.listAttachmentReferences()

    expect(rows.toSorted((left, right) => left.notePath.localeCompare(right.notePath))).toEqual([
      {
        assetPath: 'assets/photo.png',
        notePath: 'daily/2026-10-01.md',
        title: '2026-10-01',
        mtime: 9,
        isPrivate: false,
      },
      {
        assetPath: 'assets/photo.png',
        notePath: 'notes/trip.md',
        title: 'Trip',
        mtime: 4,
        isPrivate: true,
      },
    ])
    const queries = database.getQueries()
    expect(queries).toHaveLength(1)
    const [query] = queries
    expect(query?.sql).toContain('inner join "notes" on "notes"."path" = "assets"."note_path"')
    expect(query?.sql).toContain('"notes"."kind" in (?, ?)')
    expect(query?.sql).toContain('"assets"."asset_path" like ?')
    expect(query?.params).toEqual(expect.arrayContaining(['note', 'daily', '%.png', '%.pdf']))
    expect(query?.params).not.toContain('%.zip')
  })

  it('reads the body tags of notes with media references, by subquery', async () => {
    const { database, noteList } = setup([
      { path: 'notes/trip.md', markdown: '# Trip\n![](/assets/photo.png) #travel\n' },
      { path: 'notes/plain.md', markdown: '# Plain\n#travel without media\n' },
    ])

    expect(await noteList.listAttachmentNoteTags()).toEqual([
      { notePath: 'notes/trip.md', tag: 'travel' },
    ])
    const [query] = database.getQueries()
    expect(query?.sql).toContain(
      'from "tags" where "tags"."note_path" in (select "assets"."note_path"',
    )
    expect(query?.sql).toContain('"assets"."asset_path" like ?')
    expect(query?.sql).toContain('order by "tags"."tag_key"')
  })
})

describe('firstExistingAttachment', () => {
  const catalog = (paths: readonly string[]) => ({ has: (path: string) => paths.includes(path) })

  it('skips a candidate spelling that does not exist on disk', () => {
    // `projects/plan.md` linking `diagram.png` may mean either; only one exists.
    expect(
      firstExistingAttachment(['projects/diagram.png', 'diagram.png'], catalog(['diagram.png'])),
    ).toBe('diagram.png')
    expect(
      firstExistingAttachment(
        ['projects/diagram.png', 'diagram.png'],
        catalog(['projects/diagram.png', 'diagram.png']),
      ),
    ).toBe('projects/diagram.png')
  })

  it('finds nothing when no candidate exists, and the first before the catalog loads', () => {
    expect(firstExistingAttachment(['a.png', 'b.png'], catalog([]))).toBeUndefined()
    expect(firstExistingAttachment(['a.png', 'b.png'], null)).toBe('a.png')
  })
})
