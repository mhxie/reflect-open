import { isIsoDate } from '@reflect/utils'
import type { Database } from '@reflect/db'
import { sql, type Kysely, type RawBuilder, type SqlBool } from 'kysely'
import {
  ATTACHMENT_TYPE_EXTENSIONS,
  NOTE_ATTACHMENT_TYPES,
  YOUTUBE_VIDEO_URL_FRAGMENTS,
  type NoteAttachmentType,
} from '../graph/attachment-types.ts'
import type { AttachmentCatalog } from '../graph/attachment-resolution.ts'
import { AUDIO_MEMOS_DIR } from '../graph/paths.ts'
import { foldTag } from '../markdown/index.ts'
import type { AttachmentNoteTagRow, AttachmentReferenceRow } from './attachment-library.ts'
import type { DatabaseService } from './database-service.ts'
import { localDayStartMs } from './filter-query.ts'
import { recallOrder } from './queries-shared.ts'

/**
 * The All Notes list: every regular note, pinned first then newest, optionally
 * narrowed to one tag, attachment type, or edit day. The unfiltered list
 * excludes daily notes — the stream is their home — but a filter includes
 * matching daily notes alongside regular notes. Templates remain boilerplate,
 * not graph content. Uncapped: the screen virtualizes, the row snippet is the
 * stored `summary` or `preview` column (derived once at index time), and
 * neither query carries a per-row parameter, so list size has no SQL ceiling.
 */

/**
 * One row of the All Notes list.
 */
export interface NoteListEntry {
  path: string
  title: string
  /**
   * The note's display title (`display_title`, or a localized note's H1), when it has one.
   */
  displayTitle?: string | null | undefined
  /**
   * The note's `lang` frontmatter, when it has one.
   */
  lang?: string | null | undefined
  /**
   * The note's fresh AI summary when it has one, else its indexed leading text
   * (`buildIndexedNote`; may be empty). Only this row shows the summary.
   */
  snippet: string
  /**
   * The note's body tags (first-seen casing), alphabetical.
   */
  tags: string[]
  /**
   * File modification time (epoch ms) — the list's recency sort key.
   */
  mtime: number
  /**
   * Pinned notes lead the list (V1 order) and show a pin marker.
   */
  isPinned: boolean
  /**
   * A numbered pin's shelf position (`pinned: <n>`); null for bare or no pins.
   */
  pinnedOrder: number | null
  /**
   * The indexed privacy flag (locked, unreadable frontmatter, or local-only).
   */
  isPrivate: boolean
}

export interface NoteListOptions {
  /**
   * Include daily notes in an unfiltered read, for callers that filter rows by path.
   */
  includeDaily?: boolean
  /**
   * Only notes carrying this tag (case-insensitive). `null` lists all.
   */
  tag?: string | null
  /**
   * Only notes referencing an attachment of this type (by extension; a missing
   * file still counts). One filter at a time: ignored with a `tag`.
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
 * One row of the recent-notes listing (the AI chat's recents tool).
 */
export interface RecentNoteRow {
  path: string
  title: string
  /**
   * The indexed row preview (`buildIndexedNote`; may be empty).
   */
  preview: string
  /**
   * File modification time (epoch ms).
   */
  mtime: number
  isPrivate: boolean
}

export interface RecentNotesOptions {
  /**
   * Row cap — the most recently edited notes win.
   */
  limit: number
  /**
   * Only notes carrying this tag (case-insensitive). `null` lists all.
   */
  tag?: string | null
  /**
   * Local callers may include private rows; cloud-facing callers keep the default.
   */
  includePrivate?: boolean
}

/**
 * One tag facet over the note list: display casing + non-daily note count.
 */
export interface NoteTagFacet {
  tag: string
  count: number
}

/**
 * The attachment types whose files have a visual preview (an image, a PDF's first page).
 */
export type PreviewableAttachmentType = Extract<NoteAttachmentType, 'image' | 'pdf'>

/**
 * The first of `candidates` (one note's {@link NoteListService.listAttachmentPreviews}
 * entry) that `catalog` holds; without a catalog yet, the first candidate.
 * Undefined when none exists.
 */
export function firstExistingAttachment(
  candidates: readonly string[],
  catalog: Pick<AttachmentCatalog, 'has'> | null,
): string | undefined {
  return catalog === null ? candidates[0] : candidates.find((path) => catalog.has(path))
}

/**
 * Asset paths inside an `audio-memos/` tree, as a note links them (a link from
 * `notes/` is also stored source-relative, `notes/audio-memos/…`). Recordings
 * there are audio whatever their container: the recorder may save `.webm`.
 */
const AUDIO_MEMO_PATTERNS = [`${AUDIO_MEMOS_DIR}/%`, `%/${AUDIO_MEMOS_DIR}/%`]

/**
 * Every media extension, for narrowing the attachment reference rows in SQL.
 */
const MEDIA_EXTENSIONS = NOTE_ATTACHMENT_TYPES.flatMap((type) => ATTACHMENT_TYPE_EXTENSIONS[type])

/**
 * The columns of one All Notes row.
 */
const NOTE_LIST_COLUMNS = [
  'notes.path',
  'notes.title',
  'notes.displayTitle',
  'notes.lang',
  'notes.mtime',
  'notes.preview',
  'notes.summary',
  'notes.isPinned',
  'notes.pinnedOrder',
  'notes.isPrivate',
] as const

/**
 * Paths of notes referencing an attachment of `type` by extension (a missing
 * file still counts). Audio adds everything under `audio-memos/`, which video
 * excludes; video adds YouTube links. `LIKE` is ASCII case-insensitive.
 */
function notesWithAttachment(db: Kysely<Database>, type: NoteAttachmentType) {
  const files = db
    .selectFrom('assets')
    .select('assets.notePath as path')
    .where((eb) => {
      const byExtension = eb.or(
        ATTACHMENT_TYPE_EXTENSIONS[type].map((extension) => {
          return eb('assets.assetPath', 'like', `%.${extension}`)
        }),
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
      .where((eb) => {
        return eb.or(
          YOUTUBE_VIDEO_URL_FRAGMENTS.map((fragment) => {
            return eb('links.targetRaw', 'like', `%${fragment}%`)
          }),
        )
      }),
  )
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

/**
 * The All Notes filter in force: one of tag, attachment type, and edit day,
 * in that precedence, or none.
 */
interface NoteListFilter {
  readonly tag: string | null
  readonly attachment: NoteAttachmentType | null
  readonly updatedOn: string | null
  readonly includeDaily: boolean
}

/**
 * The All Notes rows for one filter (or none), before ordering.
 */
function noteListQuery(db: Kysely<Database>, filter: NoteListFilter) {
  const { tag, attachment, updatedOn, includeDaily } = filter
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
      .where('notes.path', 'in', notesWithAttachment(db, attachment))
      .select(NOTE_LIST_COLUMNS)
  }
  if (updatedOn !== null) {
    return db
      .selectFrom('notes')
      .where('notes.kind', 'in', ['note', 'daily'])
      .where(editedOnDay(updatedOn))
      .select(NOTE_LIST_COLUMNS)
  }
  const notes = db.selectFrom('notes').select(NOTE_LIST_COLUMNS)
  return includeDaily
    ? notes.where('notes.kind', 'in', ['note', 'daily'])
    : notes.where('notes.kind', '=', 'note')
}

/**
 * The tags of {@link noteListQuery}'s notes, by join or subquery: an `IN (…)`
 * list of paths would hit SQLite's bound-parameter ceiling. Ordered on the
 * folded key so a row's tags read in the same alphabetical order as the facet
 * list, regardless of display casing.
 */
function noteListTagsQuery(db: Kysely<Database>, filter: NoteListFilter) {
  const { tag, attachment, updatedOn, includeDaily } = filter
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
      .where('notes.path', 'in', notesWithAttachment(db, attachment))
  }
  if (updatedOn !== null) {
    return tags.where('notes.kind', 'in', ['note', 'daily']).where(editedOnDay(updatedOn))
  }
  return includeDaily
    ? tags.where('notes.kind', 'in', ['note', 'daily'])
    : tags.where('notes.kind', '=', 'note')
}

/**
 * References from notes (regular and daily; templates are boilerplate, not
 * graph content) to media attachment spellings. `LIKE` is ASCII
 * case-insensitive, matching `attachmentTypeOf`.
 */
function mediaReferences(db: Kysely<Database>) {
  return db
    .selectFrom('assets')
    .innerJoin('notes', 'notes.path', 'assets.notePath')
    .where('notes.kind', 'in', ['note', 'daily'])
    .where((eb) => {
      return eb.or(
        MEDIA_EXTENSIONS.map((extension) => eb('assets.assetPath', 'like', `%.${extension}`)),
      )
    })
}

export interface NoteListServiceDeps {
  readonly database: DatabaseService
}

/**
 * The All Notes list, the recent-notes listing, the tag facets, and the
 * attachment reads of the All Notes galleries and the Attachments library.
 */
export interface NoteListService {
  /**
   * Notes for the All Notes screen: unfiltered lists include non-daily notes
   * only (daily ones too with `includeDaily`); a tag, attachment, or
   * edited-on-day filter includes both regular and daily notes that match.
   * Pinned notes appear first (explicit pin order, then unordered pins), then
   * most recently edited — V1's list order. `sortNoteListRows` reorders the
   * result for another sort without a new query.
   */
  listNotes(options?: NoteListOptions): Promise<NoteListEntry[]>
  /**
   * The most recently edited non-daily notes, newest first. Same population as
   * {@link NoteListService.listNotes} (dailies live in their own date-keyed listing) but capped,
   * without the per-note tag fetch, and with private notes excluded in SQL so
   * they don't consume cap slots — the AI privacy gate still re-checks every
   * row live before anything leaves the device. A local-only caller (an
   * on-device model) may include them.
   */
  listRecentNotes(options: RecentNotesOptions): Promise<RecentNoteRow[]>
  /**
   * Every tag carried by at least one non-daily note, with how many such notes
   * carry it, alphabetical. Grouped on the stored `tag_key`, matching the tag
   * filter (and the `#tag` search token): `#Book` and `#book` are one facet,
   * displayed with one deterministic casing.
   */
  listNoteTags(): Promise<NoteTagFacet[]>
  /**
   * Each note's attachments of `type`, for the All Notes gallery: note path →
   * graph-relative paths in document order. A reference contributes every
   * candidate spelling it may mean (`attachmentReferenceCandidates`), in
   * resolution order, so the gallery picks the first that exists with
   * {@link firstExistingAttachment}.
   */
  listAttachmentPreviews(type: PreviewableAttachmentType): Promise<Map<string, string[]>>
  /**
   * The indexed references from notes to media attachment spellings: the
   * Attachments library's "linked from" half (`buildAttachmentLibrary`).
   */
  listAttachmentReferences(): Promise<AttachmentReferenceRow[]>
  /**
   * The body tags of every note with a media reference, ordered on the folded
   * key like the All Notes facets — by subquery, since an `IN (…)` list of
   * paths would hit SQLite's bound-parameter ceiling.
   */
  listAttachmentNoteTags(): Promise<AttachmentNoteTagRow[]>
}

class NoteListServiceImpl implements NoteListService {
  readonly #deps: NoteListServiceDeps

  constructor(deps: NoteListServiceDeps) {
    this.#deps = deps
  }

  async listNotes(options: NoteListOptions = {}): Promise<NoteListEntry[]> {
    const { db } = this.#deps.database
    const tag = options.tag ?? null
    const attachment = tag === null ? (options.attachment ?? null) : null
    const updatedOn = tag === null && attachment === null ? (options.updatedOn ?? null) : null
    if (updatedOn !== null && !isIsoDate(updatedOn)) {
      return []
    }
    const filter: NoteListFilter = {
      tag,
      attachment,
      updatedOn,
      includeDaily: options.includeDaily ?? false,
    }

    let listQuery = noteListQuery(db, filter)
    for (const order of recallOrder(true)) {
      listQuery = listQuery.orderBy(order)
    }
    const rows = await listQuery.execute()

    if (rows.length === 0) {
      return []
    }

    // Tags for the same note set, via the same predicates — a join rather than a
    // `note_path IN (…)` list, which would put a per-row parameter between the
    // list and SQLite's bound-parameter ceiling.
    const tagRows = await noteListTagsQuery(db, filter).execute()
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
      displayTitle: row.displayTitle,
      lang: row.lang,
      mtime: row.mtime,
      snippet: row.summary || row.preview,
      tags: tagsByPath.get(row.path) ?? [],
      isPinned: row.isPinned !== 0,
      pinnedOrder: row.pinnedOrder,
      isPrivate: row.isPrivate !== 0,
    }))
  }

  async listRecentNotes(options: RecentNotesOptions): Promise<RecentNoteRow[]> {
    const { db } = this.#deps.database
    const tag = options.tag ?? null
    const includePrivate = options.includePrivate === true

    const rows =
      tag === null
        ? await db
            .selectFrom('notes')
            .where('notes.kind', '=', 'note')
            .$if(!includePrivate, (query) => query.where('notes.isPrivate', '=', 0))
            .select([
              'notes.path',
              'notes.title',
              'notes.preview',
              'notes.mtime',
              'notes.isPrivate',
            ])
            .orderBy('notes.mtime', 'desc')
            .orderBy('notes.path')
            .limit(options.limit)
            .execute()
        : await db
            .selectFrom('tags')
            .innerJoin('notes', 'notes.path', 'tags.notePath')
            .where('tags.tagKey', '=', foldTag(tag))
            .where('notes.kind', '=', 'note')
            .$if(!includePrivate, (query) => query.where('notes.isPrivate', '=', 0))
            .select([
              'notes.path',
              'notes.title',
              'notes.preview',
              'notes.mtime',
              'notes.isPrivate',
            ])
            .distinct()
            .orderBy('notes.mtime', 'desc')
            .orderBy('notes.path')
            .limit(options.limit)
            .execute()
    return rows.map((row) => ({ ...row, isPrivate: row.isPrivate !== 0 }))
  }

  async listNoteTags(): Promise<NoteTagFacet[]> {
    const { db } = this.#deps.database
    return await db
      .selectFrom('tags')
      .innerJoin('notes', 'notes.path', 'tags.notePath')
      .where('notes.kind', '=', 'note')
      .select([sql<string>`min(tags.tag)`.as('tag'), sql<number>`count(*)`.as('count')])
      .groupBy('tags.tagKey')
      .orderBy('tags.tagKey')
      .execute()
  }

  async listAttachmentPreviews(type: PreviewableAttachmentType): Promise<Map<string, string[]>> {
    const { db } = this.#deps.database
    const rows = await db
      .selectFrom('assets')
      .select(['assets.notePath', 'assets.assetPath'])
      .where((eb) => {
        return eb.or(
          ATTACHMENT_TYPE_EXTENSIONS[type].map((extension) => {
            return eb('assets.assetPath', 'like', `%.${extension}`)
          }),
        )
      })
      // Rows are written in document order, each reference's spellings in
      // resolution order.
      .orderBy(sql`"assets"."rowid"`)
      .execute()
    const previews = new Map<string, string[]>()
    for (const row of rows) {
      const paths = previews.get(row.notePath)
      if (paths === undefined) {
        previews.set(row.notePath, [row.assetPath])
      } else {
        paths.push(row.assetPath)
      }
    }
    return previews
  }

  async listAttachmentReferences(): Promise<AttachmentReferenceRow[]> {
    const { db } = this.#deps.database
    const rows = await mediaReferences(db)
      .select([
        'assets.assetPath',
        'assets.notePath',
        'notes.title',
        'notes.mtime',
        'notes.isPrivate',
      ])
      .execute()
    return rows.map((row) => ({
      ...row,
      isPrivate: row.isPrivate !== 0,
    }))
  }

  async listAttachmentNoteTags(): Promise<AttachmentNoteTagRow[]> {
    const { db } = this.#deps.database
    return await db
      .selectFrom('tags')
      .where('tags.notePath', 'in', mediaReferences(db).select('assets.notePath'))
      .select(['tags.notePath', 'tags.tag'])
      .orderBy('tags.tagKey')
      .execute()
  }
}

export function createNoteListService(deps: NoteListServiceDeps): NoteListService {
  return new NoteListServiceImpl(deps)
}
