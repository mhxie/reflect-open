import { describe, expect, it } from 'vitest'
import type { WikiEntry, WikiEntryCopy } from './list.ts'
import { wikiEntryIn } from './localize.ts'

const COPY: WikiEntryCopy = {
  path: 'wiki-cn/memory/Spacing Effect.md',
  title: 'Spacing Effect (中文)',
  mtime: 5,
  isPrivate: true,
  hasConflict: true,
  state: 'evicted',
  preview: null,
  revised: null,
}

const ENTRY: WikiEntry = {
  path: 'wiki/memory/Spacing Effect.md',
  title: 'Spacing Effect',
  mtime: 2,
  isPrivate: false,
  hasConflict: false,
  state: 'local',
  preview: 'Spaced sessions beat cramming.',
  revised: '2026-01-02',
  topic: 'memory',
  translations: new Map([['wiki-cn', COPY]]),
  citedBy: 4,
  tags: ['memory'],
  summary: null,
}

describe('wikiEntryIn', () => {
  it("reads, sorts, and opens as its copy in a language, keeping the entry's own facts", () => {
    // The row reports its own copy's availability, not the source's.
    expect(wikiEntryIn(ENTRY, 'wiki-cn')).toEqual({ ...ENTRY, ...COPY })
    expect(wikiEntryIn(ENTRY, 'wiki-cn').state).toBe('evicted')
  })

  it('stays the source for the source language and where it has no copy', () => {
    expect(wikiEntryIn(ENTRY, null)).toBe(ENTRY)
    expect(wikiEntryIn(ENTRY, 'wiki-ja')).toBe(ENTRY)
  })
})
