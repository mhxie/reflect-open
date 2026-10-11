import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { setBridge } from '../ipc/bridge.ts'
import { parseNote } from '../markdown/index.ts'
import { cjkColumnText } from '../indexing/cjk.ts'
import { openMigratedIndex } from '../indexing/flow-test-harness.ts'
import {
  buildIndexedNote,
  encodeTaskBreadcrumbs,
  type IndexedNote,
} from '../indexing/indexed-note.ts'
import { generateCorpus, type CorpusNote } from './corpus.ts'

/**
 * The index a benchmark runs against. `REFLECT_BENCH_GRAPH=<graph dir>`
 * points it at a real graph's `.reflect/index.sqlite`, opened read-only;
 * otherwise a synthetic graph ({@link generateCorpus}) is projected into an
 * in-memory index built from the production migrations. Either way, `db_query`
 * routes into it through the IPC bridge, so the benchmarks run the exact SQL
 * the app sends.
 */
export interface BenchIndex {
  readonly database: DatabaseSync
  /** `synthetic(<notes>)` or `graph`; printed so results name their input. */
  readonly label: string
}

/** Notes in the default synthetic graph: the size of a large personal graph. */
export const SYNTHETIC_NOTES = 6000

/** The graph directory named by `REFLECT_BENCH_GRAPH`, or `null`. */
export function benchGraphDirectory(): string | null {
  const directory = process.env['REFLECT_BENCH_GRAPH']
  return directory === undefined || directory === '' ? null : directory
}

let corpus: CorpusNote[] | null = null

/** The default synthetic corpus, generated once per process. */
export function benchCorpus(): CorpusNote[] {
  corpus ??= generateCorpus({ notes: SYNTHETIC_NOTES })
  return corpus
}

function sqliteParameter(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') {
    return value
  }
  throw new TypeError(`unsupported SQLite parameter: ${typeof value}`)
}

/** Mirror of the desktop writer's `apply_note` (`src-tauri/src/db/write.rs`). */
function applyNote(database: DatabaseSync, note: IndexedNote): void {
  const searchBody = note.assetText === '' ? note.text : `${note.text}\n${note.assetText}`
  database
    .prepare(
      `INSERT INTO notes(path, id, title, title_key, path_key, kind, daily_date, is_private,
        is_pinned, pinned_order, has_conflict, gist_url, gist_stale, file_hash, mtime, updated_at,
        preview, has_content, body_chars, has_device_only_content, asset_text_hash, summary_fresh,
        display_title, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      note.path,
      note.id,
      note.title,
      note.titleKey,
      note.pathKey,
      note.kind,
      note.dailyDate,
      Number(note.isPrivate),
      Number(note.isPinned),
      note.pinnedOrder,
      Number(note.hasConflict),
      note.gistUrl,
      Number(note.gistStale),
      note.fileHash,
      note.mtime,
      note.mtime,
      note.preview,
      Number(note.hasContent),
      note.bodyChars,
      Number(note.hasDeviceOnlyContent),
      createHash('sha256').update(note.assetText).digest('hex'),
      Number(note.summaryFresh),
      note.displayTitle,
      note.lang,
    )
  const insertLink = database.prepare(
    `INSERT INTO links(source_path, kind, target_raw, target_key, target_path_key, alias,
      pos_from, pos_to) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const link of note.links) {
    insertLink.run(
      note.path,
      link.kind,
      link.targetRaw,
      link.targetKey,
      link.targetPathKey,
      link.alias,
      link.posFrom,
      link.posTo,
    )
  }
  const insertTag = database.prepare('INSERT INTO tags(note_path, tag, tag_key) VALUES (?, ?, ?)')
  for (const tag of note.tags) {
    insertTag.run(note.path, tag.tag, tag.tagKey)
  }
  const insertAlias = database.prepare(
    'INSERT INTO aliases(note_path, alias, alias_key) VALUES (?, ?, ?)',
  )
  for (const alias of note.aliases) {
    insertAlias.run(note.path, alias.alias, alias.aliasKey)
  }
  const insertClaim = database.prepare(
    'INSERT INTO note_claims(note_path, key, tier) VALUES (?, ?, ?)',
  )
  for (const claim of note.claims) {
    insertClaim.run(note.path, claim.key, claim.tier)
  }
  const insertTask = database.prepare(
    `INSERT INTO tasks(note_path, ast_path, markdown, breadcrumbs, checked, due_date)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const task of note.tasks) {
    insertTask.run(
      note.path,
      task.astPath,
      task.markdown,
      encodeTaskBreadcrumbs(task.breadcrumbs),
      Number(task.checked),
      task.dueDate,
    )
  }
  const cjk = `${cjkColumnText(note.title)} ${cjkColumnText(searchBody)}`.trim()
  database
    .prepare('INSERT INTO search_fts(path, title, body, cjk) VALUES (?, ?, ?, ?)')
    .run(note.path, note.title, searchBody, cjk)
}

/** Project `notes` into a fresh in-memory index built from the production migrations. */
export function buildSyntheticIndex(notes: readonly CorpusNote[]): DatabaseSync {
  const database = openMigratedIndex()
  database.exec('BEGIN')
  for (const note of notes) {
    const indexed = buildIndexedNote(parseNote({ path: note.path, source: note.source }), {
      fileHash: createHash('sha256').update(note.source).digest('hex'),
      mtime: note.mtime,
      source: note.source,
    })
    applyNote(database, indexed)
  }
  database.exec('COMMIT')
  return database
}

/** Route `db_query` into `database`; disk probes see an empty graph. */
export function connectBenchIndex(database: DatabaseSync): void {
  setBridge({
    invoke: (command, args) => {
      if (command === 'db_query') {
        const sql = args['sql']
        const params = args['params']
        if (typeof sql !== 'string' || !Array.isArray(params)) {
          return Promise.reject(new TypeError('invalid db_query arguments'))
        }
        return Promise.resolve(database.prepare(sql).all(...params.map(sqliteParameter)))
      }
      if (command === 'list_files' || command === 'list_attachments') {
        return Promise.resolve([])
      }
      return Promise.reject({ kind: 'notFound', message: `bench: no ${command}` })
    },
    listen: () => Promise.resolve(() => {}),
  })
}

/** Open the benchmark index (see {@link BenchIndex}) and connect the bridge to it. */
export function openBenchIndex(): BenchIndex {
  const graph = benchGraphDirectory()
  if (graph !== null) {
    const path = join(graph, '.reflect', 'index.sqlite')
    if (!existsSync(path)) {
      throw new Error(`REFLECT_BENCH_GRAPH has no index at ${path}`)
    }
    const database = new DatabaseSync(path, { readOnly: true })
    connectBenchIndex(database)
    return { database, label: 'graph' }
  }
  const database = buildSyntheticIndex(benchCorpus())
  connectBenchIndex(database)
  return { database, label: `synthetic(${SYNTHETIC_NOTES})` }
}
