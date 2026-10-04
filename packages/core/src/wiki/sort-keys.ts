import type { SortDirection } from '../indexing/note-list-sort.ts'

/** The Wiki screen's sortable columns. */
export const WIKI_SORT_KEYS = [
  'title',
  'updated',
  'review',
  'claims',
  'sources',
  'citedBy',
] as const

export type WikiSortKey = (typeof WIKI_SORT_KEYS)[number]

/** The Wiki screen's order (the `wikiSort` setting). */
export interface WikiSort {
  readonly key: WikiSortKey
  readonly direction: SortDirection
}

export const DEFAULT_WIKI_SORT: WikiSort = { key: 'title', direction: 'asc' }
