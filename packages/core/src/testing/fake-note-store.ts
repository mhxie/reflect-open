import { AppError } from '../errors.ts'
import type { NoteCreateOutcome } from '../graph/schemas.ts'

/**
 * An in-memory stand-in for the note commands that keeps Rust's write rules:
 * `writeNote` lands only when the file still holds the contents it names
 * (`null`: absent) and otherwise refuses with Rust's `io` message, and
 * `createNoteIfAbsent` reports a collision without touching the winner.
 * Tests point their mocked commands at it and stage concurrent changes in
 * {@link FakeNoteStore.beforeWrite}.
 */
export interface FakeNoteStore {
  /** Note path → contents: the fake disk. */
  readonly files: Map<string, string>
  /** Every write and create that landed, in order. */
  readonly landed: Array<{ path: string; contents: string }>
  /** How many writes were refused because the file had changed. */
  refused: number
  /** Runs before each write or create is checked; a test changes `files` here. */
  beforeWrite: (path: string) => void
  readonly readNote: (path: string) => Promise<string>
  readonly writeNote: (
    path: string,
    contents: string,
    generation: number,
    expectedContents: string | null,
  ) => Promise<void>
  readonly createNoteIfAbsent: (
    path: string,
    contents: string,
    generation: number,
  ) => Promise<NoteCreateOutcome>
}

/** Rust's refusal of a write whose expected contents no longer match the file. */
export const CHANGED_ON_DISK = {
  kind: 'io',
  message: 'Note changed on disk; reload before retrying',
} as const

export function fakeNoteStore(initial: Record<string, string> = {}): FakeNoteStore {
  const files = new Map(Object.entries(initial))
  const store: FakeNoteStore = {
    files,
    landed: [],
    refused: 0,
    beforeWrite: () => {},
    // Each executor turns a synchronous throw into a rejection, as Rust's
    // commands answer.
    readNote: (path) => {
      return new Promise((resolve) => {
        const contents = files.get(path)
        if (contents === undefined) {
          throw new AppError('notFound', `no such note: ${path}`)
        }
        resolve(contents)
      })
    },
    writeNote: (path, contents, _generation, expectedContents) => {
      return new Promise((resolve) => {
        store.beforeWrite(path)
        if ((files.get(path) ?? null) !== expectedContents) {
          store.refused += 1
          throw new AppError(CHANGED_ON_DISK.kind, CHANGED_ON_DISK.message)
        }
        files.set(path, contents)
        store.landed.push({ path, contents })
        resolve()
      })
    },
    createNoteIfAbsent: (path, contents) => {
      return new Promise((resolve) => {
        store.beforeWrite(path)
        if (files.has(path)) {
          resolve({ kind: 'collision' })
          return
        }
        files.set(path, contents)
        store.landed.push({ path, contents })
        resolve({ kind: 'created', modifiedMs: null })
      })
    },
  }
  return store
}
