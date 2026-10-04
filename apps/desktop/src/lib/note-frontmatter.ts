import { patchNote, ReflectError, upsertFrontmatter } from '@reflect/core'
import { frontmatterPatchToYaml, type FrontmatterPatch } from '@/editor/note-session.ts'
import { openSession } from '@/editor/open-documents.ts'
import { readNoteOrEmpty } from '@/lib/note-read.ts'

/**
 * The single safe way to read and write a note's frontmatter from an in-app
 * action (pin, private, gist publish). Each used to hand-roll the same
 * session-or-disk dance; the two sharp edges live here once instead of three
 * times:
 *
 * - **Reads** prefer the open session's *loaded* buffer, never a still-loading
 *   one. A loading session reports `liveContent() === null` (its empty buffer
 *   isn't the truth yet), so we fall back to disk rather than act on a
 *   placeholder — the trap behind empty publishes and mis-read toggle states.
 * - **Writes** go through the session when it can take the patch (so our own
 *   write never parks a conflict under a dirty buffer), else a checked
 *   read-patch-write on disk (`patchNote`) that a loading/clean session
 *   reconciles like any external edit. Both encode the flag through
 *   {@link frontmatterPatchToYaml}, so a value lands identically whichever
 *   channel wins.
 */

/**
 * The note's current source, read from the freshest authoritative place: the
 * open session's loaded buffer, or disk when no session has it loaded.
 */
export async function readNoteSource(path: string): Promise<string> {
  return openSession(path)?.liveContent() ?? (await readNoteOrEmpty(path))
}

/**
 * Land `patch` on the note's frontmatter, returning once it has persisted.
 * Routes through the live session when one can take the patch; otherwise
 * patches disk directly. A patch that changes nothing is a no-op.
 *
 * A missing note (a daily before its first keystroke) is created holding just
 * the frontmatter, but only while it is still missing: a file that appears in
 * between is re-read and patched instead, never replaced by the stub. A note
 * deleted while the patch is in flight stays deleted, and the patch fails
 * rather than bringing it back as a frontmatter-only file.
 */
export async function commitNoteFrontmatter(
  path: string,
  patch: FrontmatterPatch,
  generation: number,
): Promise<void> {
  const owner = openSession(path)
  if (owner !== null && (await owner.commitFrontmatter(patch))) {
    return
  }
  const yaml = frontmatterPatchToYaml(patch)
  let firstRead = true
  await patchNote(
    path,
    (source) => {
      const missingFromStart = firstRead
      firstRead = false
      if (source === null && !missingFromStart) {
        throw new ReflectError('notFound', `${path} was deleted`)
      }
      const onDisk = source ?? ''
      const patched = upsertFrontmatter(onDisk, yaml)
      return patched === onDisk ? null : patched
    },
    generation,
  )
}
