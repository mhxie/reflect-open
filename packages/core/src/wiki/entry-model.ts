import type { WikiEntrySummary } from './entry-summary.ts'

/**
 * Whether a copy's file was read: `local` (read), `evicted` (an iCloud copy
 * not on this device), or `unreadable` (the read failed, or the file vanished
 * since the index saw it).
 */
export type WikiCopyState = 'local' | 'evicted' | 'unreadable'

/**
 * One language's copy of a wiki entry: what its row shows, and what it opens,
 * when the Wiki screen is read in that language.
 */
export interface WikiEntryCopy {
  readonly path: string
  readonly title: string
  readonly displayTitle?: string | null
  readonly lang?: string | null
  /** File modification time (epoch ms). */
  readonly mtime: number
  readonly isPrivate: boolean
  readonly state: WikiCopyState
  /** The copy's opening paragraph (see {@link WikiEntrySummary.preview}); null unless read. */
  readonly preview: string | null
  /** The newest day in the copy's `## Revision Log` (ISO `YYYY-MM-DD`), or null. */
  readonly revised: string | null
}

/**
 * One entry on the Wiki screen: a note in the source language's folder — its
 * copy there, plus what the entry as a whole carries.
 */
export interface WikiEntry extends WikiEntryCopy {
  /** The entry's first folder inside the source folder, or null at its root. */
  readonly topic: string | null
  /** This entry's translations: translation folder (`wiki-cn`) → its copy there. */
  readonly translations: ReadonlyMap<string, WikiEntryCopy>
  /**
   * Distinct notes linking here, not counting the wiki's hub `index.md` files
   * (the generated index links every entry) or its translations.
   */
  readonly citedBy: number
  /** The note's body tags (first-seen casing), alphabetical. */
  readonly tags: readonly string[]
  /** The source copy's summary; null unless that copy was read. */
  readonly summary: WikiEntrySummary | null
}
