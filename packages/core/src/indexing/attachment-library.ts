import {
  ATTACHMENT_TYPE_EXTENSIONS,
  attachmentTypeOf,
  NOTE_ATTACHMENT_TYPES,
  type NoteAttachmentType,
} from '../graph/attachment-types.ts'
import {
  createAttachmentCatalog,
  resolveAttachmentLink,
  type AttachmentCatalog,
} from '../graph/attachment-resolution.ts'
import type { FileMeta } from '../graph/schemas.ts'
import { db } from './db.ts'

/**
 * The Attachments library: every media file in the graph (images, PDFs,
 * video, audio), newest first, each with the notes that link to it. The file
 * listing (`listAttachments`) is the source of truth for what exists — the
 * index `assets` projection stores reference *spellings* (bare filenames,
 * source-relative candidates, missing files) — so the index only contributes
 * the "linked from" notes.
 */

/** A note that links to an attachment. */
export interface AttachmentNoteRef {
  readonly path: string
  readonly title: string
  /** The note file's modification time (epoch ms). */
  readonly mtime: number
  /** The note's body tags (first-seen casing), ordered on the folded key. */
  readonly tags: readonly string[]
  readonly isPrivate: boolean
  readonly hasConflict: boolean
}

/** One media file in the Attachments library. */
export interface AttachmentLibraryEntry {
  /** Graph-relative path of the file. */
  readonly path: string
  readonly type: NoteAttachmentType
  /** Size in bytes. */
  readonly size: number
  /** The file's modification time (epoch ms) — the library's sort key. */
  readonly modifiedMs: number
  /** An iCloud eviction placeholder: the file exists but must not be read. */
  readonly placeholder: boolean
  /** Notes linking to the file, most recently edited first; empty when none do. */
  readonly notes: readonly AttachmentNoteRef[]
}

/** One indexed reference from a note to an attachment spelling. */
export interface AttachmentReferenceRow {
  /** The spelling the index stores: a graph-relative path or a bare filename. */
  readonly assetPath: string
  readonly notePath: string
  readonly title: string
  readonly mtime: number
  readonly isPrivate: boolean
  readonly hasConflict: boolean
}

/** One body tag of a note that links to a media attachment. */
export interface AttachmentNoteTagRow {
  readonly notePath: string
  readonly tag: string
}

/** Every media extension, for narrowing the reference rows in SQL. */
const MEDIA_EXTENSIONS = NOTE_ATTACHMENT_TYPES.flatMap((type) => ATTACHMENT_TYPE_EXTENSIONS[type])

/**
 * References from notes (regular and daily; templates are boilerplate, not
 * graph content) to media attachment spellings. `LIKE` is ASCII
 * case-insensitive, matching {@link attachmentTypeOf}.
 */
function mediaReferences() {
  return db
    .selectFrom('assets')
    .innerJoin('notes', 'notes.path', 'assets.notePath')
    .where('notes.kind', 'in', ['note', 'daily'])
    .where((eb) =>
      eb.or(MEDIA_EXTENSIONS.map((extension) => eb('assets.assetPath', 'like', `%.${extension}`))),
    )
}

/** The indexed references from notes to media attachment spellings. */
export async function listAttachmentReferences(): Promise<AttachmentReferenceRow[]> {
  const rows = await mediaReferences()
    .select([
      'assets.assetPath',
      'assets.notePath',
      'notes.title',
      'notes.mtime',
      'notes.isPrivate',
      'notes.hasConflict',
    ])
    .execute()
  return rows.map((row) => ({
    ...row,
    isPrivate: row.isPrivate !== 0,
    hasConflict: row.hasConflict !== 0,
  }))
}

/**
 * The body tags of every note with a media reference, ordered on the folded
 * key like the All Notes facets — by subquery, since an `IN (…)` list of
 * paths would hit SQLite's bound-parameter ceiling.
 */
export async function listAttachmentNoteTags(): Promise<AttachmentNoteTagRow[]> {
  return await db
    .selectFrom('tags')
    .where('tags.notePath', 'in', mediaReferences().select('assets.notePath'))
    .select(['tags.notePath', 'tags.tag'])
    .orderBy('tags.tagKey')
    .execute()
}

/** Push `row` onto the list keyed by `key`. */
function pushTo(
  map: Map<string, AttachmentReferenceRow[]>,
  key: string,
  row: AttachmentReferenceRow,
): void {
  const rows = map.get(key)
  if (rows === undefined) {
    map.set(key, [row])
  } else {
    rows.push(row)
  }
}

/**
 * The files a note may render for one stored spelling of a reference. The
 * index keeps a reference as its candidate paths and does not say how it was
 * written: a plain relative link stores its source-relative and vault-root
 * candidates, `/x` or a wiki embed with a folder the one path it names, and a
 * bare wiki embed its filename as authored — as do `/x` and `../x` when they
 * land at the graph root. So each spelling credits every file it could name:
 * a path exactly, a bare filename the file the editor resolves it to (the
 * nearest same-named one) and a root-level file of that name. Where same-named
 * files collide, a card may show a note that renders its twin; it never loses
 * a link the note does render. Exactness needs the index to record each
 * reference's spelling.
 */
function candidateFiles(reference: AttachmentReferenceRow, catalog: AttachmentCatalog): string[] {
  const { notePath, assetPath } = reference
  if (assetPath.includes('/')) {
    return [assetPath]
  }
  const nearest = resolveAttachmentLink(notePath, encodeURIComponent(assetPath), catalog)
  return [...new Set([nearest, assetPath].filter((file) => file !== null))]
}

/**
 * Join the attachment listing with the indexed references (and their notes'
 * tags) into the library: media files only, newest first (path breaks ties).
 * Each note appears once per file.
 *
 * Each stored spelling credits the files it could name (see
 * `candidateFiles`), erring toward showing a link over losing one.
 */
export function buildAttachmentLibrary(
  files: readonly FileMeta[],
  references: readonly AttachmentReferenceRow[],
  noteTags: readonly AttachmentNoteTagRow[] = [],
): AttachmentLibraryEntry[] {
  const catalog = createAttachmentCatalog(files)
  const byFile = new Map<string, AttachmentReferenceRow[]>()
  for (const reference of references) {
    for (const file of candidateFiles(reference, catalog)) {
      pushTo(byFile, file, reference)
    }
  }
  const tagsByNote = new Map<string, string[]>()
  for (const { notePath, tag } of noteTags) {
    const tags = tagsByNote.get(notePath)
    if (tags === undefined) {
      tagsByNote.set(notePath, [tag])
    } else {
      tags.push(tag)
    }
  }

  const entries: AttachmentLibraryEntry[] = []
  for (const file of files) {
    const type = attachmentTypeOf(file.path)
    if (type === null) {
      continue
    }
    const notes = new Map<string, AttachmentNoteRef>()
    for (const reference of byFile.get(file.path) ?? []) {
      notes.set(reference.notePath, {
        path: reference.notePath,
        title: reference.title,
        mtime: reference.mtime,
        tags: tagsByNote.get(reference.notePath) ?? [],
        isPrivate: reference.isPrivate,
        hasConflict: reference.hasConflict,
      })
    }
    entries.push({
      path: file.path,
      type,
      size: file.size,
      modifiedMs: file.modifiedMs,
      placeholder: file.placeholder === true,
      notes: [...notes.values()].sort(
        (left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path),
      ),
    })
  }
  return entries.sort(
    (left, right) => right.modifiedMs - left.modifiedMs || left.path.localeCompare(right.path),
  )
}
