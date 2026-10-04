import { isAppError, ReflectError } from '../errors.ts'
import { readNote, writeNote } from './commands.ts'

/**
 * Read-modify-write for a note on disk. Every note write is checked (see
 * `writeNote`): it names the source it replaces and Rust refuses it when the
 * file changed in between. A patch therefore never clobbers a concurrent
 * change — a sync pull, another device, an editor save. It re-reads the note
 * and re-applies itself to the new bytes, a bounded number of times, and then
 * surfaces the conflict. There is never an unconditional fallback.
 */

/** How many writes {@link patchNote} attempts before a conflict surfaces. */
export const PATCH_NOTE_ATTEMPTS = 3

/**
 * One read-modify-write step: given the note's current source (`null` when no
 * file exists), return the full next source, or `null` to leave the note as
 * it is. It runs again on fresh bytes after a concurrent change, so it must
 * derive everything it writes from its argument. Throwing aborts the patch
 * with nothing written. For a missing note, return `null` rather than `''`
 * when there is nothing to add, or an empty file is created.
 */
export type NotePatch = (source: string | null) => string | null | Promise<string | null>

/** The file access a patch needs; {@link patchNote} binds the note commands. */
export interface NotePatchIo {
  /** The note's current source, or `null` when no file exists. */
  read: (path: string) => Promise<string | null>
  /**
   * A checked write: refuses unless the file still holds `expectedContents`
   * (`null`: the file must not exist).
   */
  write: (path: string, contents: string, expectedContents: string | null) => Promise<void>
}

export interface PatchNoteOptions {
  /** Writes to attempt before a conflict surfaces; {@link PATCH_NOTE_ATTEMPTS} by default. */
  readonly attempts?: number
}

export interface PatchNoteResult {
  /** The source the final patch ran against (`null`: there was no file). */
  readonly source: string | null
  /** What the final patch returned: the note's next source, or `null` if it declined. */
  readonly patched: string | null
  /**
   * Whether the note now holds `patched` — false when the patch declined or
   * changed nothing. A write that reported failure after landing counts.
   */
  readonly written: boolean
}

/**
 * Every attempt of a patch lost to a concurrent change. It is an `io` app
 * error carrying Rust's message, so it surfaces exactly like the refusal it
 * wraps (`cause`); a background pass that should skip the note rather than
 * stop can tell it apart from a real IO failure.
 */
export class NoteChangedError extends ReflectError {
  readonly path: string

  constructor(path: string, options?: ErrorOptions) {
    super('io', 'Note changed on disk; reload before retrying', options)
    this.name = 'NoteChangedError'
    this.path = path
  }
}

/** Is `value` the conflict a patch surfaces after its last attempt? */
export function isNoteChangedError(value: unknown): value is NoteChangedError {
  return value instanceof NoteChangedError
}

/**
 * A note's source at `generation`, or `null` when the file does not exist —
 * the value a checked write names for "must not exist yet".
 */
export async function readNoteOrNull(path: string, generation: number): Promise<string | null> {
  try {
    return await readNote(path, generation)
  } catch (cause) {
    if (isAppError(cause) && cause.kind === 'notFound') {
      return null
    }
    throw cause
  }
}

/**
 * The re-read that classifies a refused write. Rust reports a mismatch only as
 * an `io` message, so the file itself is the evidence: if it can't be read,
 * the original refusal is what surfaces.
 */
async function rereadAfterRefusal(
  io: NotePatchIo,
  path: string,
  refusal: unknown,
): Promise<string | null> {
  try {
    return await io.read(path)
  } catch {
    throw refusal
  }
}

/**
 * Apply `patch` to the note at `path` through `io` (see {@link patchNote}).
 * After a refused write the note is re-read. Bytes equal to the patched text
 * mean the write landed and failed only afterwards (a throwing change
 * listener), or a concurrent writer produced the same text: either way it is
 * written, and running the patch again would apply it twice. Unchanged bytes
 * mean the write failed for its own reason (a full disk, a graph switch),
 * which surfaces as is. Other bytes are a concurrent change, and the patch
 * runs again on them until `attempts` writes have been refused, when
 * {@link NoteChangedError} surfaces.
 */
export async function patchNoteWith(
  io: NotePatchIo,
  path: string,
  patch: NotePatch,
  options: PatchNoteOptions = {},
): Promise<PatchNoteResult> {
  const attempts = options.attempts ?? PATCH_NOTE_ATTEMPTS
  let source = await io.read(path)
  for (let attempt = 1; ; attempt += 1) {
    const patched = await patch(source)
    if (patched === null || patched === source) {
      return { source, patched, written: false }
    }
    try {
      await io.write(path, patched, source)
      return { source, patched, written: true }
    } catch (refusal) {
      const current = await rereadAfterRefusal(io, path, refusal)
      if (current === patched) {
        return { source, patched, written: true }
      }
      if (current === source) {
        throw refusal
      }
      if (attempt >= attempts) {
        throw new NoteChangedError(path, { cause: refusal })
      }
      source = current
    }
  }
}

/**
 * Read the note at `path`, apply `patch`, and write the result checked
 * against the bytes the patch saw, all pinned to `generation`. A concurrent
 * change re-runs the patch on the new bytes, up to {@link PATCH_NOTE_ATTEMPTS}
 * writes, and then the conflict surfaces as {@link NoteChangedError}.
 */
export async function patchNote(
  path: string,
  patch: NotePatch,
  generation: number,
  options?: PatchNoteOptions,
): Promise<PatchNoteResult> {
  return await patchNoteWith(
    {
      read: (notePath) => readNoteOrNull(notePath, generation),
      write: (notePath, contents, expectedContents) =>
        writeNote(notePath, contents, generation, expectedContents),
    },
    path,
    patch,
    options,
  )
}
