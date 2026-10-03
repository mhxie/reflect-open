import { describe, expect, it } from 'vitest'
import {
  chooseNoteListSort,
  reverseNoteListSort,
  sortNoteListRows,
  type NoteListSort,
} from './note-list-sort.ts'

interface Row {
  path: string
  title: string
  mtime: number
  isPinned: boolean
  pinnedOrder: number | null
}

function row(path: string, overrides: Partial<Row> = {}): Row {
  return { path, title: path, mtime: 0, isPinned: false, pinnedOrder: null, ...overrides }
}

const paths = (rows: readonly Row[]): string[] => rows.map((each) => each.path)

describe('sortNoteListRows', () => {
  const rows = [
    row('notes/b.md', { title: 'banana', mtime: 300 }),
    row('notes/n10.md', { title: 'Note 10', mtime: 100 }),
    row('notes/a.md', { title: 'Apple', mtime: 200 }),
    row('notes/n2.md', { title: 'Note 2', mtime: 400 }),
    row('notes/untitled.md', { title: '', mtime: 500 }),
  ]

  it('orders by title A to Z, number-aware and case-insensitive, untitled last', () => {
    expect(paths(sortNoteListRows(rows, { key: 'title', direction: 'asc' }))).toEqual([
      'notes/a.md',
      'notes/b.md',
      'notes/n2.md',
      'notes/n10.md',
      'notes/untitled.md',
    ])
  })

  it('orders by title Z to A with untitled notes still last', () => {
    expect(paths(sortNoteListRows(rows, { key: 'title', direction: 'desc' }))).toEqual([
      'notes/n10.md',
      'notes/n2.md',
      'notes/b.md',
      'notes/a.md',
      'notes/untitled.md',
    ])
  })

  it('compares titles as displayed, with link syntax flattened', () => {
    const linked = [
      row('notes/z.md', { title: 'Zebra' }),
      row('notes/m.md', { title: '[[Mango]] notes' }),
    ]
    expect(paths(sortNoteListRows(linked, { key: 'title', direction: 'asc' }))).toEqual([
      'notes/m.md',
      'notes/z.md',
    ])
  })

  it('compares a subject alias by its first segment and an autolink by its URL', () => {
    const shown = [
      row('notes/z.md', { title: 'Zed // Alpha' }),
      row('notes/y.md', { title: 'Yak' }),
      row('notes/l.md', { title: '<https://b.example>' }),
      row('notes/a.md', { title: 'https://a.example' }),
    ]
    expect(paths(sortNoteListRows(shown, { key: 'title', direction: 'asc' }))).toEqual([
      'notes/a.md',
      'notes/l.md',
      'notes/y.md',
      'notes/z.md',
    ])
  })

  it('orders by last edit in either direction', () => {
    const newest: NoteListSort = { key: 'updated', direction: 'desc' }
    const oldest: NoteListSort = { key: 'updated', direction: 'asc' }
    expect(paths(sortNoteListRows(rows, newest))[0]).toBe('notes/untitled.md')
    expect(paths(sortNoteListRows(rows, oldest))).toEqual([
      'notes/n10.md',
      'notes/a.md',
      'notes/b.md',
      'notes/n2.md',
      'notes/untitled.md',
    ])
  })

  it('keeps pinned notes on top in shelf order under every sort', () => {
    const pinned = [
      ...rows,
      row('notes/pin-bare.md', { title: 'Aardvark', isPinned: true }),
      row('notes/pin-2.md', { title: 'Zulu', isPinned: true, pinnedOrder: 2 }),
      row('notes/pin-1.md', { title: 'Yak', isPinned: true, pinnedOrder: 1 }),
    ]
    for (const sort of [
      { key: 'title', direction: 'asc' },
      { key: 'updated', direction: 'asc' },
    ] as const) {
      expect(paths(sortNoteListRows(pinned, sort)).slice(0, 3)).toEqual([
        'notes/pin-1.md',
        'notes/pin-2.md',
        'notes/pin-bare.md',
      ])
    }
  })

  it('breaks ties by path and leaves the input untouched', () => {
    const tied = [row('notes/y.md', { title: 'Same' }), row('notes/x.md', { title: 'same' })]
    expect(paths(sortNoteListRows(tied, { key: 'title', direction: 'asc' }))).toEqual([
      'notes/x.md',
      'notes/y.md',
    ])
    expect(paths(tied)).toEqual(['notes/y.md', 'notes/x.md'])
  })
})

describe('chooseNoteListSort', () => {
  it('flips the active key and starts a new key in its natural direction', () => {
    const newest: NoteListSort = { key: 'updated', direction: 'desc' }
    expect(chooseNoteListSort(newest, 'updated')).toEqual({ key: 'updated', direction: 'asc' })
    expect(chooseNoteListSort(newest, 'title')).toEqual({ key: 'title', direction: 'asc' })
    expect(chooseNoteListSort({ key: 'title', direction: 'asc' }, 'updated')).toEqual(newest)
  })

  it('reverses a direction', () => {
    expect(reverseNoteListSort({ key: 'title', direction: 'asc' })).toEqual({
      key: 'title',
      direction: 'desc',
    })
  })
})
