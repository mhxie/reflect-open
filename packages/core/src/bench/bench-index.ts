import { createDb } from '@reflect/db'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { toAppError } from '../errors.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import { buildIndexedNote } from '../indexing/indexed-note.ts'
import { createSearchService, type SearchService } from '../indexing/search-service.ts'
import { createSuggestionService, type SuggestionService } from '../indexing/suggestion-service.ts'
import { createWikiResolverService } from '../indexing/wiki-resolver-service.ts'
import { parseNote } from '../markdown/index.ts'
import { createTestDatabaseService } from '../testing/database.ts'
import { generateCorpus, type CorpusNote } from './corpus.ts'

/**
 * The index a benchmark runs against. `REFLECT_BENCH_GRAPH=<graph dir>`
 * points it at a real graph's `.reflect/index.sqlite`, opened read-only;
 * otherwise a synthetic graph ({@link generateCorpus}) is projected into an
 * in-memory index built from the production migrations. Either way the
 * services query it through a {@link DatabaseService}, so the benchmarks run
 * the exact SQL the app sends.
 */
export interface BenchIndex {
  /**
   * The index the services below query.
   */
  readonly database: DatabaseService
  /**
   * The palette's ranked lexical search.
   */
  readonly search: SearchService
  /**
   * The palette's wiki-target suggestions.
   */
  readonly suggestions: SuggestionService
  /**
   * `synthetic(<notes>)` or `graph`; printed so results name their input.
   */
  readonly label: string
}

/**
 * Notes in the default synthetic graph: the size of a large personal graph.
 */
export const SYNTHETIC_NOTES = 6000

/**
 * The graph directory named by `REFLECT_BENCH_GRAPH`, or `null`.
 */
export function benchGraphDirectory(): string | null {
  const directory = process.env['REFLECT_BENCH_GRAPH']
  return directory === undefined || directory === '' ? null : directory
}

/**
 * The default synthetic corpus. Generation is seeded, so every benchmark file
 * that asks for it measures the same notes.
 */
export function benchCorpus(): CorpusNote[] {
  return generateCorpus({ notes: SYNTHETIC_NOTES })
}

function sqliteParameter(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'number') {
    return value
  }
  throw new TypeError(`unsupported SQLite parameter: ${typeof value}`)
}

/**
 * A {@link DatabaseService} over a real graph's index file, opened read-only.
 */
function openGraphDatabase(path: string): DatabaseService {
  const database = new DatabaseSync(path, { readOnly: true })
  const runQuery = (sql: string, params: readonly unknown[]): Promise<unknown> =>
    Promise.try(() => {
      try {
        return database.prepare(sql).all(...params.map(sqliteParameter))
      } catch (error) {
        throw toAppError(error)
      }
    })
  return { db: createDb(runQuery), runQuery }
}

/**
 * Project `notes` into a fresh in-memory index built from the production
 * migrations, through the same writer mirror the core tests use.
 */
export function buildSyntheticIndex(notes: readonly CorpusNote[]): DatabaseService {
  const database = createTestDatabaseService()
  for (const note of notes) {
    database.applyProjection(
      buildIndexedNote(parseNote({ path: note.path, source: note.source }), {
        fileHash: createHash('sha256').update(note.source).digest('hex'),
        mtime: note.mtime,
        source: note.source,
      }),
    )
  }
  return database
}

function benchServices(database: DatabaseService, label: string): BenchIndex {
  const wikiResolver = createWikiResolverService({ database })
  return {
    database,
    search: createSearchService({ database, wikiResolver }),
    suggestions: createSuggestionService({ database }),
    label,
  }
}

/**
 * Open the benchmark index (see {@link BenchIndex}) and the services over it.
 */
export function openBenchIndex(): BenchIndex {
  const graph = benchGraphDirectory()
  if (graph !== null) {
    const path = join(graph, '.reflect', 'index.sqlite')
    if (!existsSync(path)) {
      throw new Error(`REFLECT_BENCH_GRAPH has no index at ${path}`)
    }
    return benchServices(openGraphDatabase(path), 'graph')
  }
  return benchServices(buildSyntheticIndex(benchCorpus()), `synthetic(${SYNTHETIC_NOTES})`)
}
