import { deleteNote, isDaily, type NoteDeleteOutcome } from '@reflect/core'
import { openSession } from '@/editor/open-documents.ts'

/**
 * The status line's caveat for a desktop delete the system Trash did not
 * take: an editable local-only note stays in the graph's own trash folder.
 */
export const KEPT_IN_GRAPH_TRASH = 'Moved to .reflect/trash in this graph'

/**
 * Delete an open regular note and detach its editor session without flushing.
 *
 * `deleteNote` sends the file to the trash — the OS-native trash on desktop, the
 * graph-local `.reflect/trash/` on mobile (which has no OS trash) — recoverable
 * either way, and sync-ignored. A note in an editable local-only folder can
 * stay in `.reflect/trash/` on desktop too, when the system Trash refuses it;
 * the outcome says which trash took the note. The index and queries drop the
 * note once the change lands (the desktop watcher's reindex, or the mobile
 * write echo). Daily notes are intentionally blocked: they are the app's
 * chronological spine and cannot be deleted.
 *
 * The session first pauses persistence and settles its initial load plus any
 * write already in flight. A lazy-created note that still has no backing file
 * is deleted by discarding that session alone (the outcome is `null`: no file
 * went anywhere). Otherwise delete first, discard second. If the filesystem
 * delete fails, persistence resumes so the mounted editor remains intact.
 * Only once the file is in trash do we discard the session; otherwise a
 * normal teardown flush could recreate the deleted file.
 */
export async function deleteOpenNote(
  path: string,
  generation: number,
): Promise<NoteDeleteOutcome | null> {
  if (isDaily(path)) {
    throw new Error('Daily notes cannot be deleted')
  }
  const session = openSession(path)
  const unpersisted = await session?.prepareDelete()
  if (session !== null && unpersisted === true) {
    session.discard()
    return null
  }
  let outcome: NoteDeleteOutcome
  try {
    outcome = await deleteNote(path, generation)
  } catch (cause) {
    session?.cancelDelete()
    throw cause
  }
  session?.discard()
  const currentSession = openSession(path)
  if (currentSession !== session) {
    currentSession?.discard()
  }
  return outcome
}
