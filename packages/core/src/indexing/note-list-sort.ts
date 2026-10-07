import { displayNoteTitle } from '../markdown/note-title.ts'
import { comparePinPrecedence, type PinRank } from './pin-precedence.ts'

/** What the All Notes list can be ordered by. */
export const NOTE_LIST_SORT_KEYS = ['updated', 'title'] as const

export type NoteListSortKey = (typeof NOTE_LIST_SORT_KEYS)[number]

export const SORT_DIRECTIONS = ['asc', 'desc'] as const

export type SortDirection = (typeof SORT_DIRECTIONS)[number]

/** An All Notes ordering: a key and a direction. Pinned notes always lead. */
export interface NoteListSort {
  readonly key: NoteListSortKey
  readonly direction: SortDirection
}

/** V1's list order: most recently edited first. */
export const DEFAULT_NOTE_LIST_SORT: NoteListSort = { key: 'updated', direction: 'desc' }

/** The direction a key starts in when first chosen: newest first, A→Z. */
export const NOTE_LIST_SORT_DEFAULT_DIRECTION: Record<NoteListSortKey, SortDirection> = {
  updated: 'desc',
  title: 'asc',
}

/** The fields of a list row an ordering reads. */
export interface SortableNoteRow extends PinRank {
  readonly path: string
  readonly title: string
  readonly displayTitle?: string | null | undefined
  readonly mtime: number
}

const titleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Only link syntax (`[`, `<`) or a `//` subject alias changes how a title
 * displays, so other titles skip the inline parse.
 */
const DISPLAY_SYNTAX = /[[<]|\/\//

/** A title as {@link displayNoteTitle} shows it, trimmed for comparison. */
function sortableTitle(title: string): string {
  return (DISPLAY_SYNTAX.test(title) ? displayNoteTitle(title) : title).trim()
}

/**
 * `rows` in a new array ordered by: pin rank (numbered pins, then bare pins,
 * then the rest), the chosen key, then path. Titles compare as displayed, with
 * a numeric collator (`Note 2` before `Note 10`); untitled notes come last.
 */
export function sortNoteListRows<TRow extends SortableNoteRow>(
  rows: readonly TRow[],
  sort: NoteListSort,
): TRow[] {
  const sign = sort.direction === 'asc' ? 1 : -1
  const keyed = rows.map((row) => ({
    row,
    title: sort.key === 'title' ? sortableTitle(row.displayTitle?.trim() || row.title) : '',
  }))
  keyed.sort((left, right) => {
    const byPin = comparePinPrecedence(left.row, right.row)
    if (byPin !== 0) {
      return byPin
    }
    const byKey =
      sort.key === 'title'
        ? compareTitles(left.title, right.title, sign)
        : sign * (left.row.mtime - right.row.mtime)
    if (byKey !== 0) {
      return byKey
    }
    return left.row.path < right.row.path ? -1 : left.row.path > right.row.path ? 1 : 0
  })
  return keyed.map((entry) => entry.row)
}

function compareTitles(left: string, right: string, sign: number): number {
  if ((left === '') !== (right === '')) {
    return left === '' ? 1 : -1
  }
  return sign * titleCollator.compare(left, right)
}

/**
 * The order after choosing `key` (a column header click): the active key flips
 * direction, another key starts in its natural direction — newest first, A→Z.
 */
export function chooseNoteListSort(current: NoteListSort, key: NoteListSortKey): NoteListSort {
  if (current.key === key) {
    return reverseNoteListSort(current)
  }
  return { key, direction: NOTE_LIST_SORT_DEFAULT_DIRECTION[key] }
}

/** `sort` with its direction reversed. */
export function reverseNoteListSort(sort: NoteListSort): NoteListSort {
  return { key: sort.key, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
}
