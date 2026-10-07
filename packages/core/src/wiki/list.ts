import { sql, type RawBuilder } from 'kysely'
import { isNotNullish } from '@ocavue/utils'
import { isAppError } from '../errors.ts'
import { readNoteLocal } from '../graph/commands.ts'
import { db } from '../indexing/db.ts'
import { summarizeWikiEntry, type WikiEntrySummary } from './entry-summary.ts'
import {
  wikiLocation,
  wikiPathIn,
  wikiSourceLanguage,
  wikiTopic,
  type WikiLanguage,
} from './languages.ts'

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
  readonly hasConflict: boolean
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

export interface ListWikiEntriesOptions {
  /** The graph session the reads belong to; a new generation drops cached summaries. */
  readonly generation: number
  /** The day markers are judged on (ISO `YYYY-MM-DD`). */
  readonly asOf: string
  /** The wiki's languages, source first (the `wikiLanguages` setting). */
  readonly languages: readonly WikiLanguage[]
}

interface CachedSummary {
  readonly fileHash: string
  readonly asOf: string
  readonly summary: WikiEntrySummary
}

/**
 * Summaries by note path for one graph generation. Index queries refetch after
 * any note changes, so an unchanged file (same indexed hash) is never re-read.
 */
const summaryCache = new Map<string, CachedSummary>()
let cacheGeneration: number | null = null

/** Entries read at once on a cold cache, so a large wiki doesn't flood the file bridge. */
const READ_CONCURRENCY = 8

interface WikiNoteRow {
  readonly path: string
  readonly title: string
  readonly displayTitle: string | null
  readonly lang: string | null
  readonly mtime: number
  readonly fileHash: string
  readonly isPrivate: number
  readonly hasConflict: number
}

interface CopyRead {
  readonly state: WikiCopyState
  readonly summary: WikiEntrySummary | null
}

async function readCopy(row: WikiNoteRow, options: ListWikiEntriesOptions): Promise<CopyRead> {
  const cached = summaryCache.get(row.path)
  if (cached?.fileHash === row.fileHash && cached.asOf === options.asOf) {
    return { state: 'local', summary: cached.summary }
  }
  let read: Awaited<ReturnType<typeof readNoteLocal>>
  try {
    read = await readNoteLocal(row.path, options.generation)
  } catch (cause) {
    // One file the bridge can't read (permissions, not UTF-8, a symlink, gone
    // since the index read) marks its own row instead of failing the list.
    if (isAppError(cause)) {
      return { state: 'unreadable', summary: null }
    }
    throw cause
  }
  if (read.kind === 'evicted') {
    return { state: 'evicted', summary: null }
  }
  const summary = summarizeWikiEntry(read.content, options.asOf)
  summaryCache.set(row.path, { fileHash: row.fileHash, asOf: options.asOf, summary })
  return { state: 'local', summary }
}

/** One language's copy of an entry, from its index row and read. */
function copyOf(row: WikiNoteRow, { state, summary }: CopyRead): WikiEntryCopy {
  return {
    path: row.path,
    title: row.title,
    displayTitle: row.displayTitle,
    lang: row.lang,
    mtime: row.mtime,
    isPrivate: row.isPrivate !== 0,
    hasConflict: row.hasConflict !== 0,
    state,
    preview: summary?.preview ?? null,
    revised: summary?.lastRevised ?? null,
  }
}

/**
 * Whether `column` holds a path inside `folder`: an exact, case-sensitive
 * prefix match, as `wikiLocation` reads paths (`LIKE` would ignore ASCII case
 * and read `_` and `%` in a folder name as wildcards).
 */
function inFolder(column: string, folder: string): RawBuilder<boolean> {
  return sql<boolean>`instr(${sql.ref(column)}, ${`${folder}/`}) = 1`
}

/** `items` mapped through `map` with at most `limit` calls in flight, in input order. */
async function mapBounded<Item, Result>(
  items: readonly Item[],
  limit: number,
  map: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length)
  const queue = items.entries()
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) {
      results[index] = await map(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

/** How many distinct notes link to each source entry (see {@link WikiEntry.citedBy}). */
async function citedByCounts(languages: readonly WikiLanguage[]): Promise<Map<string, number>> {
  const source = wikiSourceLanguage(languages)
  const translations = languages.filter((language) => language !== source)
  const rows = await db
    .selectFrom('backlinks')
    .select([
      'backlinks.targetPath',
      sql<number>`count(distinct "backlinks"."source_path")`.as('citedBy'),
    ])
    .where(inFolder('backlinks.target_path', source.folder))
    .whereRef('backlinks.sourcePath', '!=', 'backlinks.targetPath')
    .where((eb) =>
      eb.and([
        // The wiki's hub indexes link every entry.
        eb.not(
          eb.and([
            inFolder('backlinks.source_path', source.folder),
            eb('backlinks.sourcePath', 'like', '%/index.md'),
          ]),
        ),
        ...translations.map((language) =>
          eb.not(inFolder('backlinks.source_path', language.folder)),
        ),
      ]),
    )
    .groupBy('backlinks.targetPath')
    .execute()
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.targetPath !== null) {
      counts.set(row.targetPath, row.citedBy)
    }
  }
  return counts
}

/** The body tags of the notes in `folder`, by note path. */
async function tagsByPath(folder: string): Promise<Map<string, string[]>> {
  const rows = await db
    .selectFrom('tags')
    .select(['tags.notePath', 'tags.tag'])
    .where(inFolder('tags.note_path', folder))
    .orderBy('tags.tagKey')
    .execute()
  const tags = new Map<string, string[]>()
  for (const row of rows) {
    tags.set(row.notePath, [...(tags.get(row.notePath) ?? []), row.tag])
  }
  return tags
}

/**
 * Every note in the source language's folder, with its topic, its copies in
 * the other languages, inbound links, tags, and a summary of its claims as of
 * `options.asOf`. Ordered by path; the screen sorts, filters, and groups.
 * Files are read through `readNoteLocal`, so an evicted iCloud copy lists
 * without a summary or preview instead of blocking.
 */
export async function listWikiEntries(options: ListWikiEntriesOptions): Promise<WikiEntry[]> {
  if (cacheGeneration !== options.generation) {
    summaryCache.clear()
    cacheGeneration = options.generation
  }

  const { languages } = options
  const source = wikiSourceLanguage(languages)
  const [rows, citedBy, tags] = await Promise.all([
    db
      .selectFrom('notes')
      .select([
        'notes.path',
        'notes.title',
        'notes.displayTitle',
        'notes.lang',
        'notes.mtime',
        'notes.fileHash',
        'notes.isPrivate',
        'notes.hasConflict',
      ])
      .where('notes.kind', '=', 'note')
      .where((eb) => eb.or(languages.map((language) => inFolder('notes.path', language.folder))))
      .orderBy('notes.path')
      .execute(),
    citedByCounts(languages),
    tagsByPath(source.folder),
  ])

  // A note at an entry's relative path in a translation folder is the
  // entry's copy in that language.
  const notes = new Map(rows.map((row) => [row.path, row]))
  const entries = rows
    .map((row) => {
      const location = wikiLocation(row.path, languages)
      return location?.language === source ? { row, relative: location.relativePath } : null
    })
    .filter(isNotNullish)
  for (const path of summaryCache.keys()) {
    if (!notes.has(path)) {
      summaryCache.delete(path)
    }
  }
  const translationLanguages = languages.filter((language) => language !== source)

  return await mapBounded(entries, READ_CONCURRENCY, async ({ row, relative }) => {
    const translations = new Map<string, WikiEntryCopy>()
    for (const language of translationLanguages) {
      const translation = notes.get(wikiPathIn(language, relative))
      if (translation !== undefined) {
        translations.set(language.folder, copyOf(translation, await readCopy(translation, options)))
      }
    }
    const read = await readCopy(row, options)
    return {
      ...copyOf(row, read),
      topic: wikiTopic(relative),
      translations,
      citedBy: citedBy.get(row.path) ?? 0,
      tags: tags.get(row.path) ?? [],
      summary: read.summary,
    }
  })
}

/**
 * Which languages hold a copy of the wiki entry at `path` (a note in any
 * language's folder): each language with its copy's path, or null where that
 * language has none. Empty when `path` is not in the wiki.
 */
export async function wikiCopies(
  path: string,
  languages: readonly WikiLanguage[],
): Promise<{ readonly language: WikiLanguage; readonly path: string | null }[]> {
  const location = wikiLocation(path, languages)
  if (location === null) {
    return []
  }
  const copies = languages.map((language) => ({
    language,
    candidate: wikiPathIn(language, location.relativePath),
  }))
  const rows = await db
    .selectFrom('notes')
    .select('notes.path')
    .where(
      'notes.path',
      'in',
      copies.map(({ candidate }) => candidate),
    )
    .execute()
  const existing = new Set(rows.map((row) => row.path))
  return copies.map(({ language, candidate }) => ({
    language,
    path: existing.has(candidate) ? candidate : null,
  }))
}

/** Whether the open graph has any wiki entries (the sidebar shows Wiki only then). */
export async function hasWikiEntries(languages: readonly WikiLanguage[]): Promise<boolean> {
  const row = await db
    .selectFrom('notes')
    .select('notes.path')
    .where('notes.kind', '=', 'note')
    .where(inFolder('notes.path', wikiSourceLanguage(languages).folder))
    .limit(1)
    .executeTakeFirst()
  return row !== undefined
}
