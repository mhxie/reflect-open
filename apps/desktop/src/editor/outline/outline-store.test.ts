import { describe, expect, it } from 'vitest'
import {
  clearNoteOutline,
  noteOutlineFor,
  publishNoteOutline,
  type NoteOutline,
} from './outline-store.ts'

function outline(text: string): NoteOutline {
  return { headings: [{ level: 2, text, position: 0 }], activeIndex: null, reveal: () => {} }
}

describe('outline store', () => {
  it('publishes and clears per note path', () => {
    const owner = Symbol('a')
    publishNoteOutline('a.md', owner, outline('A'))
    expect(noteOutlineFor('a.md')?.headings[0]?.text).toBe('A')
    expect(noteOutlineFor('b.md')).toBeNull()

    clearNoteOutline('a.md', owner)
    expect(noteOutlineFor('a.md')).toBeNull()
  })

  it('ignores a clear from an owner that no longer holds the path', () => {
    const unmounting = Symbol('old editor')
    const mounting = Symbol('new editor')
    publishNoteOutline('a.md', unmounting, outline('old'))
    publishNoteOutline('a.md', mounting, outline('new'))

    clearNoteOutline('a.md', unmounting)
    expect(noteOutlineFor('a.md')?.headings[0]?.text).toBe('new')
    clearNoteOutline('a.md', mounting)
  })
})
