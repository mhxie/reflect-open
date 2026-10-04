import { localDayStartMs } from '../indexing/filter-query.ts'
import type { SortDirection } from '../indexing/note-list-sort.ts'
import { wikiReviewState, type WikiReviewState } from './entry-summary.ts'
import { isWikiGuide } from './group.ts'
import type { WikiEntry } from './list.ts'
import type { WikiSort, WikiSortKey } from './sort-keys.ts'

/** The direction a column starts in: titles A–Z, flags first, otherwise newest or most first. */
const DEFAULT_DIRECTION: Record<WikiSortKey, SortDirection> = {
  title: 'asc',
  updated: 'desc',
  review: 'asc',
  claims: 'desc',
  sources: 'desc',
  citedBy: 'desc',
}

/** Ascending review order: what needs attention first. */
const REVIEW_RANK: Record<WikiReviewState, number> = {
  flagged: 0,
  unreviewed: 1,
  partial: 2,
  verified: 3,
}

/** A column header click: flip the active column, or start a new one in its default direction. */
export function chooseWikiSort(current: WikiSort, key: WikiSortKey): WikiSort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  }
  return { key, direction: DEFAULT_DIRECTION[key] }
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/**
 * The value an entry sorts by, or null when it has none — a guide makes no
 * claims and an unread entry has no summary, so they have no counts or review.
 * An entry was updated on its newest revision-log day, or else when its file
 * last changed.
 */
function sortValue(entry: WikiEntry, key: Exclude<WikiSortKey, 'title'>): number | null {
  if (key === 'updated') {
    return entry.revised === null ? entry.mtime : localDayStartMs(entry.revised)
  }
  if (key === 'citedBy') {
    return entry.citedBy
  }
  const { summary } = entry
  if (summary === null || isWikiGuide(entry)) {
    return null
  }
  switch (key) {
    case 'claims':
      return summary.claims
    case 'sources':
      return summary.sources
    case 'review':
      return REVIEW_RANK[wikiReviewState(summary)]
  }
}

/**
 * `entries` in `sort` order. Entries without a value for the column follow
 * the rest whichever the direction; ties fall back to title, then path.
 */
export function sortWikiEntries(entries: readonly WikiEntry[], sort: WikiSort): WikiEntry[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const byTitle = (left: WikiEntry, right: WikiEntry): number =>
    collator.compare(left.title, right.title) || left.path.localeCompare(right.path)
  const { key } = sort
  if (key === 'title') {
    return [...entries].sort((left, right) => sign * byTitle(left, right))
  }
  return [...entries].sort((left, right) => {
    const leftValue = sortValue(left, key)
    const rightValue = sortValue(right, key)
    if (leftValue === null || rightValue === null) {
      return (leftValue === null ? 1 : 0) - (rightValue === null ? 1 : 0) || byTitle(left, right)
    }
    return sign * (leftValue - rightValue) || byTitle(left, right)
  })
}
