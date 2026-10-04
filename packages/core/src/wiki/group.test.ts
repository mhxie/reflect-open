import { describe, expect, it } from 'vitest'
import type { WikiEntrySummary } from './entry-summary.ts'
import { groupWikiEntries, isWikiGuide, wikiTotals } from './group.ts'
import type { WikiEntry } from './list.ts'

function summary(claims: number): WikiEntrySummary {
  return {
    preview: null,
    claims,
    unsourcedClaims: 0,
    sources: claims,
    verifiedClaims: 0,
    flaggedClaims: 0,
    lastRevised: null,
  }
}

function entry(
  path: string,
  title: string,
  topic: string | null,
  claims: number | null,
): WikiEntry {
  return {
    path,
    title,
    topic,
    mtime: 0,
    state: 'local',
    preview: null,
    revised: null,
    translations: new Map(),
    citedBy: 0,
    tags: [],
    summary: claims === null ? null : summary(claims),
  }
}

const ENTRIES = [
  entry('wiki/memory/Spacing Effect.md', 'Spacing Effect', 'memory', 3),
  entry('wiki/memory/index.md', 'Memory: Reading Guide', 'memory', 0),
  entry('wiki/memory/Retrieval Practice.md', 'retrieval practice', 'memory', 2),
  entry('wiki/index.md', 'Wiki Index', null, 0),
  entry('wiki/attention/Inattentional Blindness.md', 'Inattentional Blindness', 'attention', null),
]

describe('groupWikiEntries', () => {
  it('puts the root first, then topics A–Z, with guides leading each topic', () => {
    const groups = groupWikiEntries(ENTRIES)

    // Inside a topic the given order holds (here, the fixture's), after its guides.
    expect(groups.map((group) => [group.topic, group.entries.map((item) => item.title)])).toEqual([
      [null, ['Wiki Index']],
      ['attention', ['Inattentional Blindness']],
      ['memory', ['Memory: Reading Guide', 'Spacing Effect', 'retrieval practice']],
    ])
  })
})

describe('isWikiGuide', () => {
  it('marks read entries without claims, not entries whose file was unavailable', () => {
    expect(ENTRIES.map(isWikiGuide)).toEqual([false, true, false, true, false])
  })
})

describe('wikiTotals', () => {
  it('counts entries with claims and their claims', () => {
    expect(wikiTotals(ENTRIES)).toEqual({ entries: 2, claims: 5 })
  })
})
