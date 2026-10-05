import { buildFileMarkdown } from '@meowdown/core'
import {
  assetFileName,
  assetLinkDestination,
  createAsset,
  errorMessage,
  untitledNotePath,
} from '@reflect/core'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry.ts'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import { shouldEmbedFile } from '@/editor/embed-file.ts'
import { noteTitleFromFile } from '@/editor/file-title.ts'
import type { CommandContext } from '@/lib/commands/types.ts'
import { startOperation } from '@/lib/operations.ts'
import { routesEqual } from '@/routing/route.ts'

/** How long the new note's editor gets to mount before the files give up on it. */
const MOUNT_TIMEOUT_MS = 3000

/** How often the wait checks for the editor: a timer, which runs even in a hidden window. */
const MOUNT_POLL_MS = 16

/** What creating the note needs from the app: where the user is, and a way to go. */
export type NoteFromFilesNavigation = Pick<CommandContext, 'navigate' | 'route'>

/** The note's markdown: the first titled file's name as its heading, then a line per file. */
export function noteMarkdownForFiles(
  files: readonly { name: string; type?: string }[],
  assetPaths: readonly string[],
): string {
  const title = files.map(noteTitleFromFile).find((name) => name !== undefined)
  const links = files.map((file, index) =>
    buildFileMarkdown(file, assetPaths[index]!, shouldEmbedFile),
  )
  // The heading is spelled out: the blank note's empty one is replaced, not filled.
  return [title === undefined ? '#' : `# ${title}`, ...links].join('\n\n')
}

function waitForEditor(path: string): Promise<NoteEditorHandle | null> {
  const deadline = Date.now() + MOUNT_TIMEOUT_MS
  return new Promise((resolve) => {
    const check = (): void => {
      const handle = noteEditorHandleFor(path)
      if (handle !== null || Date.now() > deadline) {
        resolve(handle)
        return
      }
      setTimeout(check, MOUNT_POLL_MS)
    }
    check()
  })
}

/**
 * Files dropped on the sidebar become a new note, as a link dragged to Arc's
 * sidebar becomes a tab: each file is copied into `assets/`, a fresh note
 * opens, and its editor receives the first titled file's name as the heading
 * (images carry none) and each file embedded or linked as a drop into the editor would — one undoable edit that
 * saves like typing, so the lazy note is created by it. Copying can take a
 * while: if the user has moved on by the time it finishes, the note doesn't
 * open over where they went, and the files stay in `assets/`.
 */
export async function createNoteFromFiles(
  files: readonly File[],
  generation: number,
  app: NoteFromFilesNavigation,
): Promise<void> {
  const operation = startOperation('Creating note from files')
  const startRoute = app.route()
  // Named before the uploads: the note an attachment is for decides where
  // it lands (a fresh note's go to the graph's `assets/`).
  const path = untitledNotePath()
  const saved: { file: File; assetPath: string }[] = []
  const failed: string[] = []
  for (const file of files) {
    try {
      const assetPath = await createAsset(assetFileName(file.name), file, path, generation)
      saved.push({ file, assetPath: assetLinkDestination(assetPath) })
    } catch (cause) {
      failed.push(`${file.name}: ${errorMessage(cause)}`)
    }
  }
  if (saved.length === 0) {
    operation.fail(failed.join('; '))
    return
  }
  if (!routesEqual(app.route(), startRoute)) {
    operation.warn('You moved on before the files were copied; they are in assets/.')
    return
  }
  app.navigate({ kind: 'note', path })
  const handle = await waitForEditor(path)
  if (handle === null) {
    operation.fail('The new note didn’t open; the files are in assets/.')
    return
  }
  handle.insertMarkdown(
    noteMarkdownForFiles(
      saved.map((entry) => entry.file),
      saved.map((entry) => entry.assetPath),
    ),
  )
  if (failed.length > 0) {
    operation.warn(`Not added: ${failed.join('; ')}`)
  } else {
    operation.done()
  }
}
