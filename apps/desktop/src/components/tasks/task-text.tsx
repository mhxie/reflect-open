import type { ReactElement } from 'react'
import type { OpenTask } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { usePrivateNote } from '@/hooks/use-private-note.ts'

/**
 * Render a task's Markdown (its first paragraph, marker excluded) through
 * Reflect's read-only markdown preview, as one paragraph: a task whose text
 * starts with `+ [ ] ` or `# ` shows that text, not a second checkbox or a
 * heading. The focused row swaps this for the inline editor; unfocused rows
 * should look like rendered markdown, not raw source text. A task in a private
 * note renders with no remote media, under the same verdict as its inline
 * editor.
 */
export function TaskText({ task }: { task: OpenTask }): ReactElement {
  const privateNote = usePrivateNote(task.notePath, { sessionEpoch: null, privateHeader: false })
  return (
    <MarkdownPreview
      content={task.markdown}
      remoteEmbeds={!privateNote}
      singleParagraph
      className="reflect-task-preview pointer-events-none text-sm"
    />
  )
}
