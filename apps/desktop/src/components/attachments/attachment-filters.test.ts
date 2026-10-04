import { describe, expect, it } from 'vitest'
import type { AttachmentLibraryEntry, AttachmentNoteRef } from '@reflect/core'
import { attachmentTagFacets, filterAttachments } from './attachment-filters.ts'

function note(path: string, tags: string[]): AttachmentNoteRef {
  return { path, title: path, mtime: 1, tags }
}

function entry(
  path: string,
  type: AttachmentLibraryEntry['type'],
  notes: AttachmentNoteRef[],
): AttachmentLibraryEntry {
  return { path, type, size: 1, modifiedMs: 1, placeholder: false, notes }
}

const trip = note('notes/trip.md', ['Travel', 'japan'])
const work = note('notes/work.md', ['work', 'travel'])
const library = [
  entry('assets/map.png', 'image', [trip]),
  entry('assets/ticket.pdf', 'pdf', [trip, work]),
  entry('assets/deck.pdf', 'pdf', [work]),
  entry('assets/stray.png', 'image', []),
]
function paths(entries: readonly AttachmentLibraryEntry[]): string[] {
  return entries.map((item) => item.path)
}

describe('filterAttachments', () => {
  it('returns everything when nothing is filtered', () => {
    expect(filterAttachments(library, { type: null, tag: null })).toBe(library)
  })

  it('narrows to files linked from a note with the tag, case-insensitively', () => {
    expect(paths(filterAttachments(library, { type: null, tag: 'TRAVEL' }))).toEqual([
      'assets/map.png',
      'assets/ticket.pdf',
      'assets/deck.pdf',
    ])
    expect(paths(filterAttachments(library, { type: null, tag: 'japan' }))).toEqual([
      'assets/map.png',
      'assets/ticket.pdf',
    ])
  })

  it('combines the tag with the type', () => {
    expect(paths(filterAttachments(library, { type: 'pdf', tag: 'japan' }))).toEqual([
      'assets/ticket.pdf',
    ])
    expect(paths(filterAttachments(library, { type: 'image', tag: null }))).toEqual([
      'assets/map.png',
      'assets/stray.png',
    ])
  })
})

describe('attachmentTagFacets', () => {
  it('counts each file once per tag, folding casing, ordered on the key', () => {
    expect(attachmentTagFacets(library)).toEqual([
      { tag: 'japan', count: 2 },
      { tag: 'Travel', count: 3 },
      { tag: 'work', count: 2 },
    ])
  })

  it('has no facets when no linked note carries a tag', () => {
    expect(attachmentTagFacets([entry('assets/stray.png', 'image', [])])).toEqual([])
  })
})
