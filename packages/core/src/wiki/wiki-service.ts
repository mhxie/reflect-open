import { sql, type RawBuilder } from 'kysely'
import { isNotNullish } from '@ocavue/utils'
import { z } from 'zod'
import { isAppError } from '../errors.ts'
import { requireGraphSession, type GraphSessionSource } from '../graph/graph-session.ts'
import type { LocalNoteRead, NoteFileService } from '../graph/note-file-service.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import { wikiClaimTextHashes } from './claim-hashes.ts'
import type { WikiCopyState, WikiEntry, WikiEntryCopy } from './entry-model.ts'
import { summarizeWikiEntry, type WikiEntrySummary } from './entry-summary.ts'
import { wikiAncestorIndexPaths } from './hierarchy.ts'
import {
  wikiLocation,
  wikiPathIn,
  wikiSourceLanguage,
  wikiTopic,
  type WikiLanguage,
} from './languages.ts'

/**
 * What {@link WikiService.listEntries} lists the wiki as of.
 */
export interface WikiEntriesOptions {
  /**
   * The day markers are judged on (ISO `YYYY-MM-DD`).
   */
  readonly asOf: string
  /**
   * The wiki's languages, source first (the `wikiLanguages` setting).
   */
  readonly languages: readonly WikiLanguage[]
}

/**
 * One language's copy of a wiki entry: its path, or `null` where that
 * language has none.
 */
export interface WikiCopy {
  readonly language: WikiLanguage
  readonly path: string | null
}

/**
 * An index above a wiki note: what its breadcrumb shows and opens.
 */
export interface WikiAncestor {
  readonly path: string
  readonly title: string
  readonly displayTitle: string | null
  readonly lang: string | null
}

/**
 * One read of the trust report file (see the Rust `wiki_trust_report_read`).
 */
export interface WikiTrustReportFile {
  /**
   * Identifies this version of the file (modification time and size).
   */
  readonly stamp: string
  /**
   * The file's text; null when the stamp still equals the caller's.
   */
  readonly contents: string | null
}

const trustReportFileSchema = z
  .object({
    stamp: z.string(),
    contents: z.string().nullable(),
  })
  .nullable()

/**
 * A wiki article as saved, read the way the trust harness reads it.
 */
export interface WikiSavedClaims {
  /**
   * The file's text.
   */
  readonly content: string
  /**
   * Each range claim's text hash (`wikiClaimTextHashes`), by claim id.
   */
  readonly hashes: ReadonlyMap<string, string>
}

/**
 * Entries read at once on a cold cache, so a large wiki doesn't flood the file bridge.
 */
const READ_CONCURRENCY = 8

export interface WikiServiceDeps {
  readonly ipc: IpcBridgeService
  readonly database: DatabaseService
  readonly noteFile: NoteFileService
  readonly graphSession: GraphSessionSource
}

/**
 * The wiki browser's reads over the open graph: its entries with their
 * claims, each entry's language copies and indexes, and the harness's trust
 * report file.
 */
export interface WikiService {
  /**
   * Every note in the source language's folder, with its topic, its copies in
   * the other languages, inbound links, tags, and a summary of its claims as
   * of `options.asOf`. Ordered by path; the screen sorts, filters, and groups.
   * Files are read with `readLocal`, so an evicted iCloud copy lists without a
   * summary or preview instead of blocking, and a file that cannot be read
   * marks its own row. A file whose indexed hash is unchanged since the last
   * list in the same graph session is not read again.
   */
  listEntries(options: WikiEntriesOptions): Promise<WikiEntry[]>
  /**
   * Which languages hold a copy of the wiki entry at `path` (a note in any
   * language's folder): each language with its copy's path, or null where that
   * language has none. Empty when `path` is not in the wiki.
   */
  copies(path: string, languages: readonly WikiLanguage[]): Promise<WikiCopy[]>
  /**
   * The indexes above the wiki note at `path` that exist, root first (see
   * `wikiAncestorIndexPaths`): a folder without an index is skipped, and the
   * search stays in the note's own language. Empty, without asking the index,
   * outside the wiki, for a root index, and for a note with no index above it.
   */
  ancestors(path: string, languages: readonly WikiLanguage[]): Promise<WikiAncestor[]>
  /**
   * Whether the open graph has any wiki entries (the sidebar shows Wiki only then).
   */
  hasEntries(languages: readonly WikiLanguage[]): Promise<boolean>
  /**
   * Read the open graph's trust report at graph-relative `path`: null when no
   * file is there, and no contents when its stamp still equals `knownStamp`.
   * Rejects when no graph is open or the file cannot be read.
   */
  readTrustReportFile(path: string, knownStamp: string | null): Promise<WikiTrustReportFile | null>
  /**
   * The saved article at `path` in the open graph, its claims hashed as of
   * `asOf` the way the harness hashes them, so the editor's serialization
   * never decides freshness; `'evicted'` while iCloud has not downloaded it
   * (this read never downloads). Rejects when no graph is open or the file
   * cannot be read.
   */
  readSavedClaims(path: string, asOf: string): Promise<WikiSavedClaims | 'evicted'>
}

interface CachedSummary {
  readonly fileHash: string
  readonly asOf: string
  readonly summary: WikiEntrySummary
}

/**
 * The entry summaries of one graph session, by note path.
 */
interface SummaryCache {
  readonly generation: number
  readonly summaries: Map<string, CachedSummary>
}

/**
 * One {@link WikiService.listEntries} call: the session it reads with, and the
 * summary cache of that session.
 */
interface ListPass {
  readonly generation: number
  readonly asOf: string
  readonly summaries: Map<string, CachedSummary>
}

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

class WikiServiceImpl implements WikiService {
  readonly #deps: WikiServiceDeps
  // Index queries refetch after any note changes, so an unchanged file (same
  // indexed hash) is never re-read. A new graph session starts empty.
  #cache: SummaryCache | null = null

  constructor(deps: WikiServiceDeps) {
    this.#deps = deps
  }

  async listEntries(options: WikiEntriesOptions): Promise<WikiEntry[]> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    if (this.#cache?.generation !== generation) {
      this.#cache = { generation, summaries: new Map() }
    }
    // A list still running when the graph switches keeps writing to its own
    // session's cache, never to the next one's.
    const pass: ListPass = { generation, asOf: options.asOf, summaries: this.#cache.summaries }

    const { languages } = options
    const source = wikiSourceLanguage(languages)
    const [rows, citedBy, tags] = await Promise.all([
      this.#deps.database.db
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
      this.#citedByCounts(languages),
      this.#tagsByPath(source.folder),
    ])

    // A note at an entry's relative path in a translation folder is the
    // entry's copy in that language.
    const notes = new Map<string, WikiNoteRow>(rows.map((row) => [row.path, row]))
    const entries = rows
      .map((row) => {
        const location = wikiLocation(row.path, languages)
        return location?.language === source ? { row, relative: location.relativePath } : null
      })
      .filter(isNotNullish)
    for (const path of pass.summaries.keys()) {
      if (!notes.has(path)) {
        pass.summaries.delete(path)
      }
    }
    const translationLanguages = languages.filter((language) => language !== source)

    return await mapBounded(entries, READ_CONCURRENCY, async ({ row, relative }) => {
      const translations = new Map<string, WikiEntryCopy>()
      for (const language of translationLanguages) {
        const translation = notes.get(wikiPathIn(language, relative))
        if (translation !== undefined) {
          translations.set(
            language.folder,
            copyOf(translation, await this.#readCopy(translation, pass)),
          )
        }
      }
      const read = await this.#readCopy(row, pass)
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

  async copies(path: string, languages: readonly WikiLanguage[]): Promise<WikiCopy[]> {
    const location = wikiLocation(path, languages)
    if (location === null) {
      return []
    }
    const candidates = languages.map((language) => ({
      language,
      candidate: wikiPathIn(language, location.relativePath),
    }))
    const rows = await this.#deps.database.db
      .selectFrom('notes')
      .select('notes.path')
      .where(
        'notes.path',
        'in',
        candidates.map(({ candidate }) => candidate),
      )
      .execute()
    const existing = new Set(rows.map((row) => row.path))
    return candidates.map(({ language, candidate }) => ({
      language,
      path: existing.has(candidate) ? candidate : null,
    }))
  }

  async ancestors(path: string, languages: readonly WikiLanguage[]): Promise<WikiAncestor[]> {
    const candidates = wikiAncestorIndexPaths(path, languages)
    if (candidates.length === 0) {
      return []
    }
    const rows = await this.#deps.database.db
      .selectFrom('notes')
      .select(['notes.path', 'notes.title', 'notes.displayTitle', 'notes.lang'])
      .where('notes.kind', '=', 'note')
      .where('notes.path', 'in', candidates)
      .execute()
    const byPath = new Map(rows.map((row) => [row.path, row]))
    return candidates
      .map((candidate) => byPath.get(candidate))
      .filter(isNotNullish)
      .reverse()
  }

  async hasEntries(languages: readonly WikiLanguage[]): Promise<boolean> {
    const row = await this.#deps.database.db
      .selectFrom('notes')
      .select('notes.path')
      .where('notes.kind', '=', 'note')
      .where(inFolder('notes.path', wikiSourceLanguage(languages).folder))
      .limit(1)
      .executeTakeFirst()
    return row !== undefined
  }

  async readTrustReportFile(
    path: string,
    knownStamp: string | null,
  ): Promise<WikiTrustReportFile | null> {
    const { ipc, graphSession } = this.#deps
    const { generation } = requireGraphSession(graphSession)
    return await ipc.call(
      'wiki_trust_report_read',
      { path, knownStamp, generation },
      trustReportFileSchema,
    )
  }

  async readSavedClaims(path: string, asOf: string): Promise<WikiSavedClaims | 'evicted'> {
    const { generation } = requireGraphSession(this.#deps.graphSession)
    const read = await this.#deps.noteFile.readLocal(path, generation)
    if (read.kind === 'evicted') {
      return 'evicted'
    }
    return { content: read.content, hashes: await wikiClaimTextHashes(read.content, asOf) }
  }

  async #readCopy(row: WikiNoteRow, pass: ListPass): Promise<CopyRead> {
    const cached = pass.summaries.get(row.path)
    if (cached?.fileHash === row.fileHash && cached.asOf === pass.asOf) {
      return { state: 'local', summary: cached.summary }
    }
    let read: LocalNoteRead
    try {
      read = await this.#deps.noteFile.readLocal(row.path, pass.generation)
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
    const summary = summarizeWikiEntry(read.content, pass.asOf)
    pass.summaries.set(row.path, { fileHash: row.fileHash, asOf: pass.asOf, summary })
    return { state: 'local', summary }
  }

  /**
   * How many distinct notes link to each source entry (see {@link WikiEntry.citedBy}).
   */
  async #citedByCounts(languages: readonly WikiLanguage[]): Promise<Map<string, number>> {
    const source = wikiSourceLanguage(languages)
    const translations = languages.filter((language) => language !== source)
    const rows = await this.#deps.database.db
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

  /**
   * The body tags of the notes in `folder`, by note path.
   */
  async #tagsByPath(folder: string): Promise<Map<string, string[]>> {
    const rows = await this.#deps.database.db
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
}

/**
 * One language's copy of an entry, from its index row and read.
 */
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

/**
 * `items` mapped through `map` with at most `limit` calls in flight, in input order.
 */
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

/**
 * A {@link WikiService} over the index and the open graph's files.
 */
export function createWikiService(deps: WikiServiceDeps): WikiService {
  return new WikiServiceImpl(deps)
}
