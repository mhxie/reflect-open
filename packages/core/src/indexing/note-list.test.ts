import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { listAttachmentPreviews, listNotes, listNoteTags, listRecentNotes } from './note-list.ts'

// A fake bridge resolves `db_query` so the tests exercise the real compiled
// SQL (snake_case columns, parameters) — the same harness queries.test uses.
const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

beforeEach(() => {
  mockInvoke.mockReset()
  setBridge({ invoke: mockInvoke, listen: async () => () => {} })
})

afterEach(() => {
  setBridge(null)
})

describe('listNotes', () => {
  it('lists non-daily notes pinned-first then newest with stored previews and grouped tags', async () => {
    mockInvoke
      .mockResolvedValueOnce([
        {
          path: 'notes/pinned.md',
          title: 'Pinned Plan',
          mtime: 500,
          preview: 'Always on top.',
          is_pinned: 1,
          pinned_order: 1,
        },
        {
          path: 'notes/health.md',
          title: 'Health Stacked',
          mtime: 2000,
          preview: 'Shop your health goals.',
          is_pinned: 0,
          pinned_order: null,
        },
      ])
      .mockResolvedValueOnce([
        { note_path: 'notes/health.md', tag: 'health' },
        { note_path: 'notes/health.md', tag: 'link' },
      ])

    const entries = await listNotes()

    expect(entries).toEqual([
      {
        path: 'notes/pinned.md',
        title: 'Pinned Plan',
        mtime: 500,
        snippet: 'Always on top.',
        tags: [],
        isPinned: true,
        pinnedOrder: 1,
      },
      {
        path: 'notes/health.md',
        title: 'Health Stacked',
        mtime: 2000,
        snippet: 'Shop your health goals.',
        tags: ['health', 'link'],
        isPinned: false,
        pinnedOrder: null,
      },
    ])

    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    // The snippet is the stored projection column, not a per-query derivation.
    expect(sql).toContain('"preview"')
    // `kind = 'note'` excludes dailies (the stream is their home) and templates.
    expect(sql).toContain('"notes"."kind" = ?')
    // Pinned notes lead (explicit order first), then recency — V1's list
    // order, via the recallOrder helper shared with filtered-search.
    const pinnedAt = sql.indexOf('"notes"."is_pinned" desc')
    const orderAt = sql.indexOf('"notes"."pinned_order" is null')
    const mtimeAt = sql.indexOf('"notes"."mtime" desc')
    expect(pinnedAt).toBeGreaterThan(-1)
    expect(orderAt).toBeGreaterThan(pinnedAt)
    expect(mtimeAt).toBeGreaterThan(orderAt)
    expect(sql).not.toContain('exists')
    // Uncapped: the screen virtualizes instead.
    expect(sql).not.toContain('limit')

    // The tag fetch joins the same note predicates — never a `note_path IN`
    // list, whose per-row parameter would hit SQLite's bound-parameter
    // ceiling on large graphs.
    const [, tagArgs] = mockInvoke.mock.calls[1]!
    const tagSql = String(tagArgs['sql'])
    expect(tagSql).toContain('inner join "notes"')
    expect(tagSql).toContain('"notes"."kind" = ?')
    expect(tagSql).not.toContain(' in (')
    expect(tagArgs['params']).toEqual(['note'])
  })

  it('narrows both queries to one tag and includes tagged daily notes', async () => {
    mockInvoke
      .mockResolvedValueOnce([
        {
          path: 'notes/health.md',
          title: 'Health Stacked',
          mtime: 2000,
          preview: '',
          is_pinned: 0,
          pinned_order: null,
        },
        {
          path: 'daily/2026-06-09.md',
          title: 'June 9, 2026',
          mtime: 1500,
          preview: 'Read a book.',
          is_pinned: 0,
          pinned_order: null,
        },
      ])
      .mockResolvedValueOnce([{ note_path: 'daily/2026-06-09.md', tag: 'Book' }])

    const entries = await listNotes({ tag: 'Book' })

    expect(entries.map((entry) => entry.path)).toEqual(['notes/health.md', 'daily/2026-06-09.md'])
    expect(entries[1]?.tags).toEqual(['Book'])

    expect(mockInvoke).toHaveBeenCalledTimes(2)
    const [, listArgs] = mockInvoke.mock.calls[0]!
    const listSql = String(listArgs['sql'])
    expect(listSql).toContain('from "tags"')
    expect(listSql).toContain('inner join "notes"')
    expect(listSql).toContain('"tags"."tag_key"')
    expect(listSql).not.toContain('exists')
    expect(listSql).not.toContain('lower(')
    expect(listArgs['params']).toEqual(['book', 'note', 'daily'])

    const [, tagArgs] = mockInvoke.mock.calls[1]!
    const tagSql = String(tagArgs['sql'])
    expect(tagSql).toContain('inner join "tags" as "filter_tags"')
    expect(tagSql).toContain('"filter_tags"."tag_key"')
    expect(tagSql).not.toContain('exists')
    expect(tagSql).not.toContain('lower(')
    expect(tagArgs['params']).toEqual(['book', 'note', 'daily'])
  })

  it('narrows both queries to notes referencing an attachment type, daily notes included', async () => {
    mockInvoke
      .mockResolvedValueOnce([
        {
          path: 'papers/socc.md',
          title: 'SoCC',
          mtime: 2000,
          preview: '',
          is_pinned: 0,
          pinned_order: null,
        },
      ])
      .mockResolvedValueOnce([{ note_path: 'papers/socc.md', tag: 'paper' }])

    const entries = await listNotes({ attachment: 'pdf' })

    expect(entries.map((entry) => [entry.path, entry.tags])).toEqual([
      ['papers/socc.md', ['paper']],
    ])
    for (const [, args] of mockInvoke.mock.calls) {
      const statement = String(args['sql'])
      expect(statement).toContain(
        '"notes"."path" in (select "assets"."note_path" as "path" from "assets"',
      )
      expect(statement).toContain('"assets"."asset_path" like ?')
      expect(statement).not.toContain('union')
      expect(args['params']).toEqual(expect.arrayContaining(['note', 'daily', '%.pdf']))
    }
  })

  it('narrows both queries to notes edited on a local day, plus that day’s daily note', async () => {
    mockInvoke
      .mockResolvedValueOnce([
        {
          path: 'daily/2026-10-02.md',
          title: '2026-10-02',
          mtime: 1,
          preview: '',
          is_pinned: 0,
          pinned_order: null,
        },
      ])
      .mockResolvedValueOnce([])

    await listNotes({ updatedOn: '2026-10-02' })

    const start = new Date(2026, 9, 2).getTime()
    const end = new Date(2026, 9, 3).getTime()
    expect(mockInvoke.mock.calls).toHaveLength(2)
    for (const [, args] of mockInvoke.mock.calls) {
      expect(String(args['sql'])).toContain('"notes"."daily_date" =')
      expect(args['params']).toEqual(
        expect.arrayContaining(['note', 'daily', start, end, '2026-10-02']),
      )
    }
  })

  it('lists nothing for an invalid edit day', async () => {
    await expect(listNotes({ updatedOn: '2026-02-31' })).resolves.toEqual([])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('lets a tag filter win over an edit day', async () => {
    mockInvoke.mockResolvedValue([])

    await listNotes({ tag: 'book', updatedOn: '2026-10-02' })

    expect(String(mockInvoke.mock.calls[0]![1]['sql'])).not.toContain('mtime" >=')
  })

  it('counts YouTube links as video alongside local video files', async () => {
    mockInvoke.mockResolvedValue([])

    await listNotes({ attachment: 'video' })

    const [, listArgs] = mockInvoke.mock.calls[0]!
    const listSql = String(listArgs['sql'])
    expect(listSql).toContain('union select "links"."source_path" as "path" from "links"')
    expect(listArgs['params']).toEqual(
      expect.arrayContaining(['%.mp4', '%.mov', 'md', '%youtube.com/watch%', '%youtu.be/%']),
    )
  })

  it('counts every audio-memos recording as audio and never as video', async () => {
    mockInvoke.mockResolvedValue([])

    await listNotes({ attachment: 'audio' })
    const [, audioArgs] = mockInvoke.mock.calls[0]!
    expect(audioArgs['params']).toEqual(
      expect.arrayContaining(['%.m4a', 'audio-memos/%', '%/audio-memos/%']),
    )

    mockInvoke.mockClear()
    await listNotes({ attachment: 'video' })
    const [, videoArgs] = mockInvoke.mock.calls[0]!
    expect(String(videoArgs['sql'])).toContain('not (')
    expect(videoArgs['params']).toEqual(
      expect.arrayContaining(['%.webm', 'audio-memos/%', '%/audio-memos/%']),
    )
  })

  it('applies one filter at a time, the tag over the attachment type', async () => {
    mockInvoke.mockResolvedValue([])

    await listNotes({ tag: 'Book', attachment: 'pdf' })

    const [, listArgs] = mockInvoke.mock.calls[0]!
    expect(String(listArgs['sql'])).not.toContain('"assets"')
    expect(listArgs['params']).toEqual(['book', 'note', 'daily'])
  })

  it('skips the tag fetch entirely when no notes match', async () => {
    mockInvoke.mockResolvedValue([])
    await expect(listNotes({ tag: 'nothing' })).resolves.toEqual([])
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })
})

describe('listRecentNotes', () => {
  it('caps public non-daily rows, newest first, with a boolean privacy flag', async () => {
    mockInvoke.mockResolvedValueOnce([
      {
        path: 'notes/health.md',
        title: 'Health Stacked',
        preview: 'Shop your health goals.',
        mtime: 2000,
        is_private: 0,
      },
    ])

    const rows = await listRecentNotes({ limit: 5 })

    expect(rows).toEqual([
      {
        path: 'notes/health.md',
        title: 'Health Stacked',
        preview: 'Shop your health goals.',
        mtime: 2000,
        isPrivate: false,
      },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('"notes"."kind" = ?')
    expect(sql).toContain('"is_private"')
    expect(sql).toContain('order by "notes"."mtime" desc')
    expect(sql).toContain('limit')
    expect(args['params']).toEqual(['note', 0, 5])
  })

  it('narrows to one tag via the stored folded tag_key', async () => {
    mockInvoke.mockResolvedValueOnce([])

    await listRecentNotes({ limit: 5, tag: 'Book' })

    const [, args] = mockInvoke.mock.calls[0]!
    const sql = String(args['sql'])
    expect(sql).toContain('from "tags"')
    expect(sql).toContain('inner join "notes"')
    expect(sql).toContain('"tags"."tag_key"')
    expect(sql).not.toContain('exists')
    expect(sql).not.toContain('lower(')
    expect(args['params']).toEqual(['book', 'note', 0, 5])
  })
})

describe('listNoteTags', () => {
  it('groups tags on the stored key over non-daily notes', async () => {
    mockInvoke.mockResolvedValue([
      { tag: 'Book', count: 3 },
      { tag: 'link', count: 12 },
    ])

    const facets = await listNoteTags()

    expect(facets).toEqual([
      { tag: 'Book', count: 3 },
      { tag: 'link', count: 12 },
    ])
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const sql = String(args['sql'])
    expect(sql).toContain('"notes"."kind" = ?')
    expect(sql).toContain('group by "tags"."tag_key"')
  })
})

describe('listAttachmentPreviews', () => {
  it('maps each note to its first attachment of the type', async () => {
    mockInvoke.mockResolvedValueOnce([
      { note_path: 'papers/socc.md', asset_path: 'papers/assets/a.pdf' },
      { note_path: 'notes/trip.md', asset_path: 'assets/map.pdf' },
    ])

    const previews = await listAttachmentPreviews('pdf')

    expect(previews).toEqual(
      new Map([
        ['papers/socc.md', 'papers/assets/a.pdf'],
        ['notes/trip.md', 'assets/map.pdf'],
      ]),
    )
    const [command, args] = mockInvoke.mock.calls[0]!
    expect(command).toBe('db_query')
    const statement = String(args['sql'])
    expect(statement).toContain('min("assets"."asset_path")')
    expect(statement).toContain('group by "assets"."note_path"')
    expect(args['params']).toEqual(['%.pdf'])
  })
})
