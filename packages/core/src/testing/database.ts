import { createDb } from '@reflect/db'
import type { IndexReadCommand } from '@reflect/types'
import { createWasmIndexBackend, type WasmIndexBackend } from '@reflect/index-wasm'
import { toAppError } from '../errors.ts'
import type { LocalOnlyFolders } from '../graph/local-only.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import { buildIndexedNote, type IndexedNote } from '../indexing/indexed-note.ts'
import type { CommandArgs, CommandResult } from '../ipc/ipc-service.ts'
import { parseNote } from '../markdown/extract.ts'

/**
 * One query the database ran, in its compiled form.
 */
export interface TestDatabaseQuery {
  readonly sql: string
  readonly params: readonly unknown[]
}

/**
 * One read command the database ran.
 */
export interface TestDatabaseRead {
  readonly command: string
  readonly args: Readonly<Record<string, unknown>>
}

export interface TestDatabaseService extends DatabaseService {
  /**
   * Replace every projected row of `note.path` with `note`, like `index_apply`.
   */
  applyProjection(note: IndexedNote): void
  /**
   * Run one index command on the database, like the native shell.
   */
  invoke(command: string, args: Record<string, unknown>): unknown
  /**
   * The generation of the open index, which a write command must carry.
   */
  generation(): number
  /**
   * Every query run so far, in order.
   */
  getQueries(): readonly TestDatabaseQuery[]
  /**
   * Every read command run through `read` so far, in order.
   */
  getReads(): readonly TestDatabaseRead[]
  /**
   * Release the database; later queries and seeding throw.
   */
  close(): void
}

const READ_STATEMENT = /^\s*(?:select|with|explain)\b/i

class TestDatabaseServiceImpl implements TestDatabaseService {
  readonly db: DatabaseService['db']
  readonly #queries: TestDatabaseQuery[] = []
  readonly #reads: TestDatabaseRead[] = []
  #index: WasmIndexBackend | null = null
  #generation = 0
  #closed = false

  constructor() {
    this.db = createDb(this.runQuery)
  }

  readonly runQuery = (sql: string, params: readonly unknown[]): Promise<unknown> => {
    return Promise.try(() => {
      this.#queries.push({ sql, params: [...params] })
      // A statement that writes seeds rows the index writer would never
      // produce; the wasm index runs it through its test-only command.
      const command = READ_STATEMENT.test(sql) ? 'db_query' : 'test_execute'
      return this.invoke(command, { sql, params: [...params] })
    })
  }

  read<C extends IndexReadCommand>(command: C, args: CommandArgs<C>): Promise<CommandResult<C>> {
    return Promise.try(() => {
      this.#reads.push({ command, args: structuredClone(args) })
      return this.invoke(command, args) as CommandResult<C>
    })
  }

  applyProjection(note: IndexedNote): void {
    this.invoke('index_apply', { note, generation: this.generation() })
  }

  invoke(command: string, args: Record<string, unknown>): unknown {
    try {
      const result = this.#open().invoke(command, args)
      if (command === 'index_open') {
        this.#generation = result as number
      }
      return result
    } catch (error) {
      throw toAppError(error)
    }
  }

  generation(): number {
    this.#open()
    return this.#generation
  }

  getQueries(): readonly TestDatabaseQuery[] {
    return [...this.#queries]
  }

  getReads(): readonly TestDatabaseRead[] {
    return [...this.#reads]
  }

  close(): void {
    this.#closed = true
    this.#index?.close()
    this.#index = null
  }

  #open(): WasmIndexBackend {
    if (this.#closed) {
      throw new Error('the test database is closed')
    }
    if (this.#index === null) {
      this.#index = createWasmIndexBackend()
      this.#generation = this.#index.invoke('index_open', {}) as number
    }
    return this.#index
  }
}

/**
 * A {@link DatabaseService} over the index of the native shells, compiled to
 * wasm, with a new in-memory database. The database opens on first use, so
 * building one is cheap.
 */
export function createNodeTestDatabaseService(): TestDatabaseService {
  return new TestDatabaseServiceImpl()
}

/**
 * One note to project into a test index from its markdown.
 */
export interface TestNote {
  /**
   * Graph-relative path.
   */
  readonly path: string
  /**
   * The file contents.
   */
  readonly markdown: string
  /**
   * File modification time (epoch ms); defaults to 0.
   */
  readonly mtime?: number
  /**
   * The stored content hash. Defaults to a placeholder; a test whose writes
   * are checked against the note's content gives the real SHA-256.
   */
  readonly fileHash?: string | undefined
}

/**
 * Project each note through the real markdown indexing pipeline into `database`.
 * `options.localOnly` is the graph's local-only folders (none by default),
 * whose notes the projection marks private.
 */
export function seedNotes(
  database: TestDatabaseService,
  notes: readonly TestNote[],
  options?: { readonly localOnly?: LocalOnlyFolders },
): void {
  for (const { path, markdown, mtime, fileHash } of notes) {
    database.applyProjection(
      buildIndexedNote(parseNote({ path, source: markdown }), {
        fileHash: fileHash ?? `hash-${path}`,
        mtime: mtime ?? 0,
        source: markdown,
        ...(options?.localOnly === undefined ? {} : { localOnly: options.localOnly }),
      }),
    )
  }
}
