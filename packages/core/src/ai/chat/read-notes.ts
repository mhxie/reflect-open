import { z } from 'zod'
import { isAppError } from '../../errors.ts'
import { readNoteForDevice, readNoteShareable, type DeviceNoteRead } from '../../graph/commands.ts'
import { isLocalOnlyPath } from '../../graph/local-only.ts'
import { isNotePath } from '../../graph/paths.ts'
import { parseNote } from '../../markdown/extract.ts'
import { splitFrontmatter } from '../../markdown/frontmatter.ts'
import {
  cloudSafeNoteContent,
  isPrivateNoteError,
  PrivateNoteError,
  type CloudNoteContent,
  type CloudSafe,
  notePrivate,
} from '../../privacy/checkers.ts'
import { localSafeNoteContent, type LocalSafe } from '../../privacy/local-checkers.ts'
import type { VerifiedModelTarget } from '../../privacy/on-device.ts'

/**
 * The read_notes tool's executor (Plan 10): resolve a graph-relative note
 * path to its body and gate it for the provider. The tool registration,
 * name, and transcript unions stay in `./tools` — this module only knows how
 * to read one note.
 */

/** The per-note refusal a private note's read returns — local-only notes share it. */
export const PRIVATE_NOTE_REFUSAL = 'This note is marked private and cannot be read by AI.'

/**
 * The per-path refusal for anything that is not a note: a hidden file
 * (`.git/config`, `.reflect/…`), an attachment, or an `assets/` description
 * sidecar, which read_assets reads instead.
 */
export const NOT_A_NOTE_REFUSAL =
  'Not a note path — pass .md note paths exactly as search_notes or the listings return them; read attachments with read_assets.'

/** Cap on returned note content so one huge note can't flood the context. */
export const MAX_NOTE_CONTENT_CHARS = 24_000

/**
 * Cap on notes one read_notes call returns. Each note is itself capped at
 * {@link MAX_NOTE_CONTENT_CHARS}, so this bounds a single batch read to roughly
 * the per-turn token reserve — past it the model splits the read across calls.
 */
export const MAX_READ_NOTES = 10

/** One note in a {@link ReadNotesOutput}: its content, or a structured refusal/miss. */
export type ReadNoteResult =
  | { ok: true; note: CloudSafe<CloudNoteContent> | LocalSafe<CloudNoteContent> }
  | { ok: false; path: string; error: string }

/** The read_notes output: one {@link ReadNoteResult} per requested path, in order. */
export interface ReadNotesOutput {
  notes: ReadNoteResult[]
}

export const readNotesInput = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1)
    .max(MAX_READ_NOTES)
    .describe(
      'Graph-relative note paths to read, e.g. ["notes/abc.md"] (from search_notes ' +
        `results). Pass every note you need in one call, up to ${MAX_READ_NOTES}.`,
    ),
})

/**
 * The chat tools' note reader: Rust refuses a note in a local-only folder
 * however its path is spelled, and the refusal surfaces as a
 * {@link PrivateNoteError}, which every tool already treats as private.
 */
export async function readShareableNote(path: string): Promise<string> {
  const read = await readNoteShareable(path)
  if (read.kind === 'localOnly') {
    throw new PrivateNoteError(path)
  }
  return read.content
}

/** The effects {@link buildReadOneNote} needs, already defaulted by the caller. */
export interface ReadNoteDeps {
  readNoteFn: (path: string) => Promise<string>
  readDeviceNoteFn?: (path: string, generation?: number) => Promise<DeviceNoteRead>
  target?: VerifiedModelTarget | undefined
  generation?: number | undefined
}

/**
 * Build the per-note reader for read_notes: the body (frontmatter stripped,
 * capped), or a structured per-note miss/refusal so one bad path never fails
 * the batch. Content is minted CloudSafe only after the live private re-check
 * (the frontmatter flag and the local-only path rule).
 *
 * Only note paths are read. The gate lives here rather than in
 * {@link readShareableNote}, which read_assets also uses to read the
 * `assets/` description sidecars.
 */
export function buildReadOneNote(deps: ReadNoteDeps) {
  return async function readOneNote(path: string): Promise<ReadNoteResult> {
    // The path is model-supplied: anything but a note is refused unread, and
    // so is a note inside a local-only folder, whatever its frontmatter says.
    if (!isNotePath(path)) {
      return { ok: false, path, error: NOT_A_NOTE_REFUSAL }
    }
    if (deps.target?.kind !== 'on-device' && isLocalOnlyPath(path)) {
      return { ok: false, path, error: PRIVATE_NOTE_REFUSAL }
    }
    let source: string
    let localOnly = false
    try {
      if (deps.target?.kind === 'on-device') {
        const read = await (deps.readDeviceNoteFn ?? readNoteForDevice)(path, deps.generation)
        source = read.content
        localOnly = read.localOnly
      } else {
        source = await deps.readNoteFn(path)
      }
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        return { ok: false, path, error: 'No note exists at this path.' }
      }
      if (isPrivateNoteError(cause)) {
        return { ok: false, path, error: PRIVATE_NOTE_REFUSAL }
      }
      throw cause
    }
    const parsed = parseNote({ path, source })
    const { body } = splitFrontmatter(source)
    const truncated = body.length > MAX_NOTE_CONTENT_CHARS
    const content = {
      path,
      isPrivate: localOnly || notePrivate(source),
      title: parsed.title,
      content: truncated ? body.slice(0, MAX_NOTE_CONTENT_CHARS) : body,
      truncated,
    }
    try {
      return {
        ok: true,
        note:
          deps.target?.kind === 'on-device'
            ? localSafeNoteContent(deps.target, content)
            : cloudSafeNoteContent(content),
      }
    } catch (cause) {
      if (isPrivateNoteError(cause)) {
        return { ok: false, path, error: PRIVATE_NOTE_REFUSAL }
      }
      throw cause
    }
  }
}
