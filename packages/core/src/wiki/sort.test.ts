import { describe, expect, it } from 'vitest'
import type { WikiEntrySummary } from './entry-summary.ts'
import { localDayStartMs } from '../indexing/filter-query.ts'
import type { WikiEntry } from './list.ts'
import { DEFAULT_WIKI_SORT } from './sort-keys.ts'
import { chooseWikiSort, sortWikiEntries } from './sort.ts'

function entry(
  title: string,
  summary: Partial<WikiEntrySummary> | null,
  citedBy = 0,
  dates: Partial<Pick<WikiEntry, 'mtime' | 'revised'>> = {},
): WikiEntry {
  return {
    path: `wiki/topic/${title}.md`,
    title,
    topic: 'topic',
    mtime: dates.mtime ?? 0,
    isPrivate: false,
    hasConflict: false,
    state: 'local',
    preview: null,
    revised: dates.revised ?? null,
    translations: new Map(),
    citedBy,
    tags: [],
    summary:
      summary === null
        ? null
        : {
            preview: null,
            claims: 1,
            unsourcedClaims: 0,
            sources: 1,
            verifiedClaims: 0,
            flaggedClaims: 0,
            lastRevised: null,
            ...summary,
          },
  }
}

const ENTRIES = [
  entry('Item 10', { claims: 4, sources: 2, verifiedClaims: 4 }, 1, { revised: '2026-03-01' }),
  entry('item 2', { claims: 2, sources: 6, flaggedClaims: 1 }, 7, { revised: '2026-05-01' }),
  entry('Guide', { claims: 0, sources: 0 }, 9, {
    mtime: localDayStartMs('2026-04-01') + 5 * 60 * 60 * 1000,
  }),
  entry('Unread', null, 3),
  entry('Alpha', { claims: 3, sources: 3, verifiedClaims: 1 }, 0),
  entry('Beta', { claims: 5, sources: 1 }, 2),
]

function titles(entries: readonly WikiEntry[]): string[] {
  return entries.map((item) => item.title)
}

describe('sortWikiEntries', () => {
  it('orders titles case-insensitively with numbers in numeric order', () => {
    expect(titles(sortWikiEntries(ENTRIES, DEFAULT_WIKI_SORT))).toEqual([
      'Alpha',
      'Beta',
      'Guide',
      'item 2',
      'Item 10',
      'Unread',
    ])
  })

  it('sorts counts, keeping guides and unread entries last either way', () => {
    expect(titles(sortWikiEntries(ENTRIES, { key: 'claims', direction: 'desc' }))).toEqual([
      'Beta',
      'Item 10',
      'Alpha',
      'item 2',
      'Guide',
      'Unread',
    ])
    expect(titles(sortWikiEntries(ENTRIES, { key: 'sources', direction: 'asc' }))).toEqual([
      'Beta',
      'Item 10',
      'Alpha',
      'item 2',
      'Guide',
      'Unread',
    ])
  })

  it('puts what needs attention first when sorting review ascending', () => {
    expect(titles(sortWikiEntries(ENTRIES, { key: 'review', direction: 'asc' }))).toEqual([
      'item 2',
      'Beta',
      'Alpha',
      'Item 10',
      'Guide',
      'Unread',
    ])
  })

  it('sorts inbound links and updates for every entry', () => {
    expect(titles(sortWikiEntries(ENTRIES, { key: 'citedBy', direction: 'desc' }))).toEqual([
      'Guide',
      'item 2',
      'Unread',
      'Beta',
      'Item 10',
      'Alpha',
    ])
    // The newest revision-log day, else when the file last changed.
    expect(titles(sortWikiEntries(ENTRIES, { key: 'updated', direction: 'desc' }))).toEqual([
      'item 2',
      'Guide',
      'Item 10',
      'Alpha',
      'Beta',
      'Unread',
    ])
  })
})

describe('chooseWikiSort', () => {
  it('flips the active column and starts a new one in its natural direction', () => {
    expect(chooseWikiSort(DEFAULT_WIKI_SORT, 'title')).toEqual({ key: 'title', direction: 'desc' })
    expect(chooseWikiSort(DEFAULT_WIKI_SORT, 'claims')).toEqual({
      key: 'claims',
      direction: 'desc',
    })
    expect(chooseWikiSort(DEFAULT_WIKI_SORT, 'review')).toEqual({ key: 'review', direction: 'asc' })
  })
})
