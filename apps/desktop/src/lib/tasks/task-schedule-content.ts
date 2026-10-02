import { clearTaskDueDate, setTaskDueDate, type OpenTask } from '@reflect/core'

/** The task's Markdown after setting or clearing its scheduled date link. */
export function getScheduledMarkdown(task: OpenTask, isoDate: string | null): string {
  return isoDate === null ? clearTaskDueDate(task.markdown) : setTaskDueDate(task.markdown, isoDate)
}
