import { sql, type RawBuilder, type SqlBool } from 'kysely'
import { isIsoDate } from '@reflect/utils'
import {
  ATTACHMENT_TYPE_EXTENSIONS,
  YOUTUBE_VIDEO_URL_FRAGMENTS,
  type NoteAttachmentType,
} from '../graph/attachment-types.ts'
import { AUDIO_MEMOS_DIR } from '../graph/paths.ts'
import { foldTag } from '../markdown/index.ts'
import { db } from './db.ts'
import { localDayStartMs } from './filter-query.ts'
import { recallOrder } from './filtered-search.ts'

/**
 * The All Notes list: every regular note, pinned first then newest, optionally
 * narrowed to one tag, attachment type, or edit day. The unfiltered list
 * excludes daily notes — the stream is their home — but a filter includes
 * matching daily notes alongside regular notes. Templates remain boilerplate,
 * not graph content. Uncapped: the screen virtualizes, the row
 * snippet is the stored `preview` column (derived once at index time), and
 * neither query carries a per-row parameter, so list size has no SQL ceiling.
 */

/** One row of the All Notes list. */
export interface NoteListEntry {
  path: string
  title: string
  /** The indexed row preview (`buildIndexedNote`; may be empty). */
  snippet: string
  /** The note's body tags (first-seen casing), alphabetical. */
  tags: string[]
  /** File modification time (epoch ms) — the list's recency sort key. */
  mtime: number
  /** Pinned notes lead the list (V1 order) and show a pin marker. */
  isPinned: boolean
  /** A numbered pin's shelf position (`pinned: <n>`); null for bare or no pins. */
  pinnedOrder: number | null
  /** Indexed privacy and sync conflict flags, normalized at the read boundary. */
  isPrivate: boolean
  hasConflict: boolean
}

export interface NoteListOptions {
  /** Only notes carrying this tag (case-insensitive). `null` lists all. */
  tag?: string | null
  /**
   * Only notes referencing an attachment of this type (see
   * {@link notesWithAttachment}). One filter at a time: ignored with a `tag`.
   */
  attachment?: NoteAttachmentType | null
  /**
   * Only notes last edited on this local day (ISO `YYYY-MM-DD`), plus that
   * day's daily note; an invalid date lists nothing. One filter at a time:
   * ignored with a `tag` or `attachment`.
   */
  updatedOn?: string | null
}

/**
 * Asset paths inside an `audio-memos/` tree, as a note links them (a link from
 * `notes/` is also stored source-relative, `notes/audio-memos/…`). Recordings
 * there are audio whatever their container: the recorder may save `.webm`.
 */
const AUDIO_MEMO_PATTERNS = [`${AUDIO_MEMOS_DIR}/%`, `%/${AUDIO_MEMOS_DIR}/%`]

/**
 * Paths of notes referencing an attachment of `type` by extension (a missing
 * file still counts). Audio adds everything under `audio-memos/`, which video
 * excludes; video adds YouTube links. `LIKE` is ASCII case-insensitive.
 */
function notesWithAttachment(type: NoteAttachmentType) {
  const files = db
    .selectFrom('assets')
    .select('assets.notePath as path')
    .where((eb) => {
      const byExtension = eb.or(
        ATTACHMENT_TYPE_EXTENSIONS[type].map((extension) =>
          eb('assets.assetPath', 'like', `%.${extension}`),
        ),
      )
      const isAudioMemo = eb.or(
        AUDIO_MEMO_PATTERNS.map((pattern) => eb('assets.assetPath', 'like', pattern)),
      )
      if (type === 'audio') {
        return eb.or([byExtension, isAudioMemo])
      }
      return type === 'video' ? eb.and([byExtension, eb.not(isAudioMemo)]) : byExtension
    })
  if (type !== 'video') {
    return files
  }
  return files.union(
    db
      .selectFrom('links')
      .select('links.sourcePath as path')
      .where('links.kind', '=', 'md')
      .where((eb) =>
        eb.or(
          YOUTUBE_VIDEO_URL_FRAGMENTS.map((fragment) =>
            eb('links.targetRaw', 'like', `%${fragment}%`),
          ),
        ),
      ),
  )
}

/** The attachment types whose files have a visual preview (an image, a PDF's first page). */
export type PreviewableAttachmentType = Extract<NoteAttachmentType, 'image' | 'pdf'>

/**
 * Each note's first attachment of `type` (graph-relative, alphabetical), for
 * the All Notes gallery: note path → attachment path.
 */
export async function listAttachmentPreviews(
  type: PreviewableAttachmentType,
): Promise<Map<string, string>> {
  const rows = await db
    .selectFrom('assets')
    .select(['assets.notePath', (eb) => eb.fn.min('assets.assetPath').as('assetPath')])
    .where((eb) =>
      eb.or(
        ATTACHMENT_TYPE_EXTENSIONS[type].map((extension) =>
          eb('assets.assetPath', 'like', `%.${extension}`),
        ),
      ),
    )
    .groupBy('assets.notePath')
    .execute()
  return new Map(rows.map((row) => [row.notePath, row.assetPath]))
}

/**
 * Notes last edited on the local day `date`, plus that day's daily note — an
 * edit made later (or a sync re-stamping mtimes) must not hide the entry the
 * day is named after. Raw, like `recallOrder`, so differently-rooted queries
 * can share it.
 */
function editedOnDay(date: string): RawBuilder<SqlBool> {
  return sql<SqlBool>`(("notes"."mtime" >= ${localDayStartMs(date)} and "notes"."mtime" < ${localDayStartMs(date, 1)}) or "notes"."daily_date" = ${date})`
}

/** The columns of one All Notes row. */
const NOTE_LIST_COLUMNS = [
  'notes.path',
  'notes.title',
  'notes.mtime',
  'notes.preview',
  'notes.isPinned',
  'notes.pinnedOrder',
  'notes.isPrivate',
  'notes.hasConflict',
] as const

/** The All Notes rows for one filter (or none), before ordering. */
function noteListQuery(
  tag: string | null,
  attachment: NoteAttachmentType | null,
  updatedOn: string | null,
) {
  if (tag !== null) {
    return db
      .selectFrom('tags')
      .innerJoin('notes', 'notes.path', 'tags.notePath')
      .where('tags.tagKey', '=', foldTag(tag))
      .where('notes.kind', 'in', ['note', 'daily'])
      .select(NOTE_LIST_COLUMNS)
      .distinct()
  }
  if (attachment !== null) {
    return db
      .selectFrom('notes')
      .where('notes.kind', 'in', ['note', 'daily'])
      .where('notes.path', 'in', notesWithAttachment(attachment))
      .select(NOTE_LIST_COLUMNS)
  }
  if (updatedOn !== null) {
    return db
      .selectFrom('notes')
      .where('notes.kind', 'in', ['note', 'daily'])
      .where(editedOnDay(updatedOn))
      .select(NOTE_LIST_COLUMNS)
  }
  return db.selectFrom('notes').where('notes.kind', '=', 'note').select(NOTE_LIST_COLUMNS)
}

/**
 * The tags of {@link noteListQuery}'s notes, by join or subquery: an `IN (…)`
 * list of paths would hit SQLite's bound-parameter ceiling. Ordered on the
 * folded key, like the facet list.
 */
function noteListTagsQuery(
  tag: string | null,
  attachment: NoteAttachmentType | null,
  updatedOn: string | null,
) {
  const tags = db
    .selectFrom('tags')
    .innerJoin('notes', 'notes.path', 'tags.notePath')
    .select(['tags.notePath', 'tags.tag'])
    .orderBy('tags.tagKey')
  if (tag !== null) {
    return tags
      .innerJoin('tags as filterTags', 'filterTags.notePath', 'notes.path')
      .where('filterTags.tagKey', '=', foldTag(tag))
      .where('notes.kind', 'in', ['note', 'daily'])
      .distinct()
  }
  if (attachment !== null) {
    return tags
      .where('notes.kind', 'in', ['note', 'daily'])
      .where('notes.path', 'in', notesWithAttachment(attachment))
  }
  if (updatedOn !== null) {
    return tags.where('notes.kind', 'in', ['note', 'daily']).where(editedOnDay(updatedOn))
  }
  return tags.where('notes.kind', '=', 'note')
}

/**
 * Notes for the All Notes screen: unfiltered lists include non-daily notes only;
 * a tag, attachment, or edited-on-day filter includes both regular and daily
 * notes that match. Pinned notes appear first (explicit pin order, then
 * unordered pins), then most recently edited — V1's list order.
 * `sortNoteListRows` reorders the result for another sort without a new query.
 */
export async function listNotes(options: NoteListOptions = {}): Promise<NoteListEntry[]> {
  const tag = options.tag ?? null
  const attachment = tag === null ? (options.attachment ?? null) : null
  const updatedOn = tag === null && attachment === null ? (options.updatedOn ?? null) : null
  if (updatedOn !== null && !isIsoDate(updatedOn)) {
    return []
  }

  let listQuery = noteListQuery(tag, attachment, updatedOn)
  for (const order of recallOrder(true)) {
    listQuery = listQuery.orderBy(order)
  }
  const rows = await listQuery.execute()

  if (rows.length === 0) {
    return []
  }

  const tagRows = await noteListTagsQuery(tag, attachment, updatedOn).execute()
  const tagsByPath = new Map<string, string[]>()
  for (const row of tagRows) {
    const tags = tagsByPath.get(row.notePath)
    if (tags === undefined) {
      tagsByPath.set(row.notePath, [row.tag])
    } else {
      tags.push(row.tag)
    }
  }

  return rows.map((row) => ({
    path: row.path,
    title: row.title,
    mtime: row.mtime,
    snippet: row.preview,
    tags: tagsByPath.get(row.path) ?? [],
    isPinned: row.isPinned !== 0,
    pinnedOrder: row.pinnedOrder,
    isPrivate: row.isPrivate !== 0,
    hasConflict: row.hasConflict !== 0,
  }))
}

/** One row of the recent-notes listing (the AI chat's recents tool). */
export interface RecentNoteRow {
  path: string
  title: string
  /** The indexed row preview (`buildIndexedNote`; may be empty). */
  preview: string
  /** File modification time (epoch ms). */
  mtime: number
  isPrivate: boolean
}

export interface RecentNotesOptions {
  /** Row cap — the most recently edited notes win. */
  limit: number
  /** Only notes carrying this tag (case-insensitive). `null` lists all. */
  tag?: string | null
  /** Local callers may include private rows; cloud-facing callers keep the default. */
  includePrivate?: boolean
}

/**
 * The most recently edited non-daily notes, newest first. Same population as
 * {@link listNotes} (dailies live in their own date-keyed listing) but capped,
 * without the per-note tag fetch, and with private notes excluded in SQL so
 * they don't consume cap slots — the AI privacy gate still re-checks every
 * row live before anything leaves the device.
 */
export async function listRecentNotes(options: RecentNotesOptions): Promise<RecentNoteRow[]> {
  const tag = options.tag ?? null

  const rows =
    tag === null
      ? await db
          .selectFrom('notes')
          .where('notes.kind', '=', 'note')
          .$if(options.includePrivate !== true, (query) => query.where('notes.isPrivate', '=', 0))
          .select(['notes.path', 'notes.title', 'notes.preview', 'notes.mtime', 'notes.isPrivate'])
          .orderBy('notes.mtime', 'desc')
          .orderBy('notes.path')
          .limit(options.limit)
          .execute()
      : await db
          .selectFrom('tags')
          .innerJoin('notes', 'notes.path', 'tags.notePath')
          .where('tags.tagKey', '=', foldTag(tag))
          .where('notes.kind', '=', 'note')
          .$if(options.includePrivate !== true, (query) => query.where('notes.isPrivate', '=', 0))
          .select(['notes.path', 'notes.title', 'notes.preview', 'notes.mtime', 'notes.isPrivate'])
          .distinct()
          .orderBy('notes.mtime', 'desc')
          .orderBy('notes.path')
          .limit(options.limit)
          .execute()
  return rows.map((row) => ({ ...row, isPrivate: row.isPrivate !== 0 }))
}

/** One tag facet over the note list: display casing + non-daily note count. */
export interface NoteTagFacet {
  tag: string
  count: number
}

/**
 * Every tag carried by at least one non-daily note, with how many such notes
 * carry it, alphabetical. Grouped on the stored `tag_key`, matching the tag
 * filter (and the `#tag` search token): `#Book` and `#book` are one facet,
 * displayed with one deterministic casing.
 */
export async function listNoteTags(): Promise<NoteTagFacet[]> {
  return await db
    .selectFrom('tags')
    .innerJoin('notes', 'notes.path', 'tags.notePath')
    .where('notes.kind', '=', 'note')
    .select([sql<string>`min(tags.tag)`.as('tag'), sql<number>`count(*)`.as('count')])
    .groupBy('tags.tagKey')
    .orderBy('tags.tagKey')
    .execute()
}
