import type { NoteActionsService, NotePrivacyBatchResult } from '@reflect/core'
import { toast } from '@/components/ui/toast.tsx'

/**
 * Toggle one note's privacy — the command, the context sidebar, the status
 * menu and the mobile actions all land here — and confirm the change with a
 * toast whose Undo puts the note back. A note the toggle left alone
 * (local-only, an unreadable lock, a failure it already reported) gets no
 * toast: there is nothing to undo.
 */
export async function toggleNotePrivate(
  noteActions: NoteActionsService,
  path: string,
): Promise<void> {
  const outcome = await noteActions.togglePrivate(path)
  if (outcome.status === 'done' && outcome.changed) {
    announcePrivacy(
      noteActions,
      outcome.isPrivate ? 'Marked private' : 'No longer private',
      [path],
      !outcome.isPrivate,
    )
  }
}

/**
 * Set every listed note's privacy to `isPrivate`, one note at a time, and
 * offer one Undo for the notes that changed. Notes already in that state are
 * left as they are; the result says what changed and what was skipped.
 */
export async function setNotesPrivate(
  noteActions: NoteActionsService,
  paths: readonly string[],
  isPrivate: boolean,
): Promise<NotePrivacyBatchResult> {
  const result = await noteActions.setNotesPrivate(paths, isPrivate)
  const count = result.changed.length
  if (count > 0) {
    const notes = count === 1 ? '1 note' : `${count} notes`
    announcePrivacy(
      noteActions,
      isPrivate ? `Marked ${notes} private` : `${notes} no longer private`,
      result.changed,
      !isPrivate,
    )
  }
  return result
}

/**
 * Confirm a privacy change with a toast whose Undo sets `paths` back to `previous`.
 */
function announcePrivacy(
  noteActions: NoteActionsService,
  title: string,
  paths: readonly string[],
  previous: boolean,
): void {
  toast.add({
    title,
    actionProps: {
      children: 'Undo',
      onClick: () => void noteActions.setNotesPrivate(paths, previous),
    },
  })
}
