import { describe, expect, it } from 'vitest'
import type { WikiEntrySummary } from './entry-summary.ts'
import { filterWikiEntries, wikiEntryTags, wikiFiltersEqual, type WikiFilter } from './filter.ts'
import type { WikiEntry, WikiEntryCopy } from './list.ts'

function entry(
  title: string,
  summary: Partial<WikiEntrySummary> | null,
  extra: Partial<Pick<WikiEntry, 'path' | 'tags' | 'translations'>> = {},
): WikiEntry {
  return {
    path: extra.path ?? `wiki/topic/${title}.md`,
    title,
    topic: 'topic',
    mtime: 0,
    isPrivate: false,
    hasConflict: false,
    state: 'local',
    preview: null,
    revised: null,
    translations: extra.translations ?? new Map(),
    citedBy: 0,
    tags: extra.tags ?? [],
    summary:
      summary === null
        ? null
        : {
            preview: null,
            claims: 2,
            unsourcedClaims: 0,
            sources: 2,
            verifiedClaims: 2,
            flaggedClaims: 0,
            lastRevised: null,
            ...summary,
          },
  }
}

const ENTRIES = [
  entry(
    'Verified',
    {},
    {
      translations: new Map<string, WikiEntryCopy>([
        [
          'wiki-cn',
          {
            path: 'wiki-cn/topic/Verified.md',
            title: 'Verified (中文)',
            mtime: 0,
            isPrivate: false,
            hasConflict: false,
            state: 'local',
            preview: null,
            revised: null,
          },
        ],
      ]),
    },
  ),
  entry('Flagged', { flaggedClaims: 1, verifiedClaims: 1 }, { tags: ['Memory'] }),
  entry('Unreviewed', { verifiedClaims: 0, unsourcedClaims: 1 }),
  entry(
    'Guide',
    { claims: 0, verifiedClaims: 0 },
    { path: 'wiki/topic/index.md', tags: ['memory', 'meta'] },
  ),
  entry('Unread', null),
  entry('Hub', { claims: 1, verifiedClaims: 0, flaggedClaims: 1 }, { path: 'wiki/index.md' }),
  entry('Unread Index', null, { path: 'wiki/other/index.md' }),
  entry('Draft', { claims: 0, verifiedClaims: 0 }),
]

function titlesFor(filter: WikiFilter | null): string[] {
  return filterWikiEntries(ENTRIES, filter).map((item) => item.title)
}

describe('filterWikiEntries', () => {
  it('reads indexes from the file name and knowledge from claims', () => {
    // An index that makes claims is knowledge too; an unread index is still an index.
    expect(titlesFor({ kind: 'knowledge' })).toEqual(['Verified', 'Flagged', 'Unreviewed', 'Hub'])
    expect(titlesFor({ kind: 'index' })).toEqual(['Guide', 'Hub', 'Unread Index'])
  })

  it('narrows to review states and unsourced claims, never selecting claimless or unread entries', () => {
    expect(titlesFor({ kind: 'flagged' })).toEqual(['Flagged', 'Hub'])
    expect(titlesFor({ kind: 'unreviewed' })).toEqual(['Unreviewed'])
    expect(titlesFor({ kind: 'unsourced' })).toEqual(['Unreviewed'])
  })

  it('finds entries missing a translation, indexes and unread ones included', () => {
    expect(titlesFor({ kind: 'untranslated', folder: 'wiki-cn' })).toEqual([
      'Flagged',
      'Unreviewed',
      'Guide',
      'Unread',
      'Hub',
      'Unread Index',
      'Draft',
    ])

    // A folder named like an object built-in is still just a folder.
    expect(titlesFor({ kind: 'untranslated', folder: 'constructor' })).toHaveLength(ENTRIES.length)
  })

  it('matches tags case-insensitively, indexes included', () => {
    expect(titlesFor({ kind: 'tag', tag: 'memory' })).toEqual(['Flagged', 'Guide'])
  })

  it('keeps everything without a filter', () => {
    expect(titlesFor(null)).toHaveLength(ENTRIES.length)
  })
})

describe('wikiFiltersEqual', () => {
  it('compares filters by kind and argument', () => {
    expect(wikiFiltersEqual(null, null)).toBe(true)
    expect(wikiFiltersEqual({ kind: 'flagged' }, null)).toBe(false)
    expect(wikiFiltersEqual({ kind: 'knowledge' }, { kind: 'knowledge' })).toBe(true)
    expect(wikiFiltersEqual({ kind: 'index' }, { kind: 'index' })).toBe(true)
    expect(wikiFiltersEqual({ kind: 'knowledge' }, { kind: 'index' })).toBe(false)
    expect(wikiFiltersEqual({ kind: 'tag', tag: 'Memory' }, { kind: 'tag', tag: 'memory' })).toBe(
      true,
    )
    expect(
      wikiFiltersEqual(
        { kind: 'untranslated', folder: 'wiki-cn' },
        { kind: 'untranslated', folder: 'wiki-ja' },
      ),
    ).toBe(false)
  })
})

describe('wikiEntryTags', () => {
  it('lists every tag once, in first-seen casing, alphabetically', () => {
    expect(wikiEntryTags(ENTRIES)).toEqual(['Memory', 'meta'])
  })
})
