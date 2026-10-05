import { describe, expect, it } from 'vitest'
import type { WikiEntrySummary } from './entry-summary.ts'
import { filterWikiEntries, wikiEntryTags, wikiFiltersEqual, type WikiFilter } from './filter.ts'
import type { WikiEntry, WikiEntryCopy } from './list.ts'

function entry(
  title: string,
  summary: Partial<WikiEntrySummary> | null,
  extra: Partial<Pick<WikiEntry, 'tags' | 'translations'>> = {},
): WikiEntry {
  return {
    path: `wiki/topic/${title}.md`,
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
  entry('Guide', { claims: 0, verifiedClaims: 0 }, { tags: ['memory', 'meta'] }),
  entry('Unread', null),
]

function titlesFor(filter: WikiFilter | null): string[] {
  return filterWikiEntries(ENTRIES, filter).map((item) => item.title)
}

describe('filterWikiEntries', () => {
  it('narrows to review states and unsourced claims, never selecting guides or unread entries', () => {
    expect(titlesFor({ kind: 'flagged' })).toEqual(['Flagged'])
    expect(titlesFor({ kind: 'unreviewed' })).toEqual(['Unreviewed'])
    expect(titlesFor({ kind: 'unsourced' })).toEqual(['Unreviewed'])
  })

  it('finds entries missing a translation, unread ones included', () => {
    expect(titlesFor({ kind: 'untranslated', folder: 'wiki-cn' })).toEqual([
      'Flagged',
      'Unreviewed',
      'Unread',
    ])

    // A folder named like an object built-in is still just a folder.
    expect(titlesFor({ kind: 'untranslated', folder: 'constructor' })).toEqual([
      'Verified',
      'Flagged',
      'Unreviewed',
      'Unread',
    ])
  })

  it('matches tags case-insensitively, guides included', () => {
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
