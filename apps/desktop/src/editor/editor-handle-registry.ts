import type { NoteEditorHandle } from '@/editor/note-editor.tsx'

/**
 * The mounted note editors, keyed by graph-relative note path. Commands that
 * act on "the current note's editor" (Attach file…) resolve the handle for
 * `CommandContext.notePath()` here — the same path the context sidebar and
 * note-scoped commands target, so an insertion can never land in a different
 * note than the one those commands describe.
 *
 * Module-level rather than a provider: registrations come from render-phase
 * ref callbacks and reads from command dispatch, neither of which needs
 * React state or re-renders (the same shape as `operations.ts`).
 */
interface EditorRegistration {
  handle: NoteEditorHandle
  generation: number | null
}

const handles = new Map<string, EditorRegistration>()

/** Make `handle` the editor for `path` (the pane's ref callback, on mount). */
export function registerNoteEditorHandle(
  path: string,
  handle: NoteEditorHandle,
  generation: number | null,
): void {
  handles.set(path, { handle, generation })
}

/**
 * Remove `handle`'s registration (the pane's ref callback, on unmount). A
 * no-op when another editor has since registered the same path, so an
 * unmount racing a remount never drops the live handle.
 */
export function unregisterNoteEditorHandle(path: string, handle: NoteEditorHandle): void {
  if (handles.get(path)?.handle === handle) {
    handles.delete(path)
  }
}

/** The mounted editor for a note path, or null when none is on screen. */
export function noteEditorHandleFor(path: string, generation?: number): NoteEditorHandle | null {
  const registered = handles.get(path)
  return registered !== undefined &&
    (generation === undefined || registered.generation === generation)
    ? registered.handle
    : null
}
