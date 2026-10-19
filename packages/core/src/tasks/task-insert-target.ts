import { renderTaskSnapshot, type TaskSnapshot } from '../markdown/index.ts'
import type { OpenTask } from './open-task.ts'

/**
 * The note a new task is added to (Return-to-add, V1): its path plus the context
 * the optimistic row needs to render and bucket before the reindex.
 */
export type InsertTaskTarget = Pick<
  OpenTask,
  'notePath' | 'noteTitle' | 'dailyDate' | 'isPinned' | 'pinnedOrder'
>

/**
 * An inserted task with the note flags of the source its write landed.
 */
export interface InsertedNoteTask extends TaskSnapshot {
  /**
   * The written note is private: its frontmatter says so (or can't be read),
   * or it sits in a local-only folder.
   */
  readonly isPrivate: boolean
  /**
   * The written note carries sync conflict markers.
   */
  readonly hasConflict: boolean
}

/**
 * Build the optimistic open row for a just-written task from its persisted
 * address, the note flags of the source the write landed, and the write's
 * `updatedAt`.
 */
export function createInsertedTaskRow(
  target: InsertTaskTarget,
  created: InsertedNoteTask,
  updatedAt: number,
): OpenTask {
  const { notePath, noteTitle, dailyDate, isPinned, pinnedOrder } = target
  return {
    ...renderTaskSnapshot(created),
    notePath,
    noteTitle,
    dailyDate,
    isPinned,
    isPrivate: created.isPrivate,
    hasConflict: created.hasConflict,
    pinnedOrder,
    updatedAt,
  }
}
