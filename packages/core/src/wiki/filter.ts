import { foldTag } from '../markdown/index.ts'
import { wikiReviewState } from './entry-summary.ts'
import { isWikiGuide } from './group.ts'
import type { WikiEntry } from './list.ts'

/**
 * What the Wiki screen is narrowed to: knowledge entries, index guides,
 * entries with a flagged claim, with no reviewer verification yet, with a
 * claim lacking a source, without a copy in one translation folder, or
 * carrying a tag.
 */
export type WikiFilter =
  | { readonly kind: 'knowledge' }
  | { readonly kind: 'index' }
  | { readonly kind: 'flagged' }
  | { readonly kind: 'unreviewed' }
  | { readonly kind: 'unsourced' }
  | { readonly kind: 'untranslated'; readonly folder: string }
  | { readonly kind: 'tag'; readonly tag: string }

/** Structural equality of two Wiki filters (`null` = everything). */
export function wikiFiltersEqual(left: WikiFilter | null, right: WikiFilter | null): boolean {
  if (left === null || right === null) {
    return left === right
  }
  switch (left.kind) {
    case 'knowledge':
    case 'index':
    case 'flagged':
    case 'unreviewed':
    case 'unsourced':
      return right.kind === left.kind
    case 'untranslated':
      return right.kind === 'untranslated' && right.folder === left.folder
    case 'tag':
      return right.kind === 'tag' && foldTag(right.tag) === foldTag(left.tag)
  }
}

/**
 * Whether `entry` passes `filter`. Guides make no claims, so only the index
 * and tag filters select them. Unread entries pass only the translation and
 * tag filters; their role stays unknown until their contents can be read.
 */
export function matchesWikiFilter(entry: WikiEntry, filter: WikiFilter): boolean {
  if (filter.kind === 'index') {
    return isWikiGuide(entry)
  }
  if (filter.kind === 'knowledge') {
    return entry.summary !== null && entry.summary.claims > 0
  }
  if (filter.kind === 'tag') {
    const key = foldTag(filter.tag)
    return entry.tags.some((tag) => foldTag(tag) === key)
  }
  if (isWikiGuide(entry)) {
    return false
  }
  if (filter.kind === 'untranslated') {
    return !entry.translations.has(filter.folder)
  }
  const { summary } = entry
  if (summary === null) {
    return false
  }
  switch (filter.kind) {
    case 'flagged':
      return wikiReviewState(summary) === 'flagged'
    case 'unreviewed':
      return wikiReviewState(summary) === 'unreviewed'
    case 'unsourced':
      return summary.unsourcedClaims > 0
  }
}

/** The entries passing `filter`, in their given order; every entry for `null`. */
export function filterWikiEntries(
  entries: readonly WikiEntry[],
  filter: WikiFilter | null,
): WikiEntry[] {
  return filter === null
    ? [...entries]
    : entries.filter((entry) => matchesWikiFilter(entry, filter))
}

/** Every tag carried by a wiki entry (first-seen casing), alphabetical. */
export function wikiEntryTags(entries: readonly WikiEntry[]): string[] {
  const byKey = new Map<string, string>()
  for (const entry of entries) {
    for (const tag of entry.tags) {
      const key = foldTag(tag)
      if (!byKey.has(key)) {
        byKey.set(key, tag)
      }
    }
  }
  return [...byKey].sort(([left], [right]) => left.localeCompare(right)).map(([, tag]) => tag)
}
