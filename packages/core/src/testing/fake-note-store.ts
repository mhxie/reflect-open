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
    readNote: async (path) => {
      const contents = files.get(path)
      if (contents === undefined) {
        throw { kind: 'notFound', message: `no such note: ${path}` }
      }
      return contents
    },
    writeNote: async (path, contents, _generation, expectedContents) => {
      store.beforeWrite(path)
      if ((files.get(path) ?? null) !== expectedContents) {
        store.refused += 1
        throw { ...CHANGED_ON_DISK }
      }
      files.set(path, contents)
      store.landed.push({ path, contents })
    },
    createNoteIfAbsent: async (path, contents) => {
      store.beforeWrite(path)
      if (files.has(path)) {
        return { kind: 'collision' }
      }
      files.set(path, contents)
      store.landed.push({ path, contents })
      return { kind: 'created', modifiedMs: null }
    },
  }
  return store
}
