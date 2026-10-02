import { clearTaskDueDate, setTaskDueDate } from '@reflect/core'

/**
 * Draft-side due-date writes for the mobile quick-edit sheet. The sheet holds
 * the task's content as an editable markdown draft, and scheduling edits the
 * draft rather than writing through — so text and date changes land as one
 * write when the sheet commits. The date rule is the projection's
 * (`getTaskDueDate`): the first calendar-valid `[[YYYY-MM-DD]]` link.
 */

/** The draft with its due-date link set to `isoDate`, or removed when null. */
export function withDraftDueDate(content: string, isoDate: string | null): string {
  return isoDate === null ? clearTaskDueDate(content) : setTaskDueDate(content, isoDate)
}
