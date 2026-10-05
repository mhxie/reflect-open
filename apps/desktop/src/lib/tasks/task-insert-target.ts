import { renderInlineText, type OpenTask } from '@reflect/core'
import type { InsertedNoteTask } from '@/lib/note-task.ts'

/**
 * The note a new task is added to (Return-to-add, V1): its path plus the context
 * the optimistic row needs to render and bucket before the reindex.
 */
export interface InsertTaskTarget {
  notePath: string
  noteTitle: string
  dailyDate: string | null
  isPinned: boolean
  pinnedOrder: number | null
}

/** Build the optimistic open row for a just-written task from its persisted address. */
export function createInsertedTaskRow(
  target: InsertTaskTarget,
  created: InsertedNoteTask,
): OpenTask {
  return {
    notePath: target.notePath,
    astPath: created.astPath,
    markdown: created.markdown,
    checked: created.checked,
    text: renderInlineText(created.markdown),
    breadcrumbs: created.breadcrumbs.map((label) => renderInlineText(label)),
    noteTitle: target.noteTitle,
    dueDate: null,
    dailyDate: target.dailyDate,
    isPinned: target.isPinned,
    isPrivate: created.isPrivate,
    hasConflict: created.hasConflict,
    pinnedOrder: target.pinnedOrder,
    updatedAt: Date.now(),
  }
}
