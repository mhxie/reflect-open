import { isLocalOnlyReadOnlyPath } from '@reflect/core'
import { noteEditorHandleFor } from '@/editor/editor-handle-registry.ts'
import type { CommandContext } from '@/lib/commands/types.ts'

/**
 * The Attach file… command for the routed note: the native file picker, then
 * `AttachmentService.attachFilesToNote`, which copies each pick into the
 * note's attachment folder (the graph's `assets/`, or an editable local-only
 * note's own `<folder>/assets/`) and links it in the editor. No-ops without an
 * open graph, a routed note or a mounted editor, for a note inside a
 * read-only local-only folder (it takes no attachments, and its files must
 * never be copied into the synced `assets/`), and when the graph changed while
 * the picker was open. The editor is looked up for the session's generation,
 * so the same path's editor of another graph never receives the links.
 */
export async function attachFilesToNote(context: CommandContext): Promise<void> {
  const notePath = context.notePath()
  if (notePath === null) {
    return
  }
  const { attachments, graphSession } = context.services
  const { dialog } = context.app
  const { session } = graphSession.getState()
  if (session === null || isLocalOnlyReadOnlyPath(session.localOnly, notePath)) {
    return
  }
  const { generation } = session
  const findEditor = () => noteEditorHandleFor(notePath, generation)
  if (findEditor() === null) {
    return
  }
  const sources = await dialog.pickFiles({ multiple: true, title: 'Attach files' })
  if (sources === null || graphSession.getState().session !== session) {
    return
  }
  await attachments.attachFilesToNote({ notePath, sources, findEditor })
}
