import type { ReactElement } from 'react'
import { isLocalOnlyPath, type OpenTask } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'

/**
 * Render a task's Markdown (its first paragraph, marker excluded) through
 * Reflect's read-only markdown preview. The focused row swaps this for the
 * inline editor; unfocused rows should look like rendered markdown, not raw
 * source text.
 */
export function TaskText({ task }: { task: OpenTask }): ReactElement {
  return (
    <MarkdownPreview
      content={task.markdown}
      remoteEmbeds={!isLocalOnlyPath(task.notePath)}
      className="reflect-task-preview pointer-events-none text-sm"
    />
  )
}
