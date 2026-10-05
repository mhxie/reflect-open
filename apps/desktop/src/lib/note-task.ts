import {
  applyTaskEdits,
  detectConflictMarkers,
  isLocalOnlyPath,
  isLocalOnlyReadOnlyPath,
  notePrivate,
  patchNote,
  ReflectError,
  type TaskEdit,
  type TaskEditResult,
  type TaskLocator,
  type TaskSnapshot,
} from '@reflect/core'
import { openSession } from '@/editor/open-documents.ts'

/** A task's locator ({@link TaskLocator}) plus the note it lives in. */
export interface TaskRef extends TaskLocator {
  notePath: string
}

/** An inserted task with note flags from the source successfully written by its mutation. */
export interface InsertedNoteTask extends TaskSnapshot {
  readonly isPrivate: boolean
  readonly hasConflict: boolean
}

export interface ContinuedTaskInContext {
  /** The new empty task, as the written note addresses it. */
  readonly created: InsertedNoteTask
  /** Where every pre-existing task of the note ended up after the write. */
  readonly moved: TaskEditResult['moved']
}

/**
 * A task couldn't be written because its note is open with unsaved edits that
 * the session can't persist right now — it's read-only/protected, or a sync
 * conflict is parked. Distinct from `TaskStaleError` (a stale index): the
 * recovery is "save or resolve the note", not "reindex". We refuse rather than
 * write to disk, which would clobber the live buffer.
 */
export class NoteBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NoteBusyError'
  }
}

/**
 * One pending-write chain per graph generation and note path. Task writes read-modify-write a note,
 * so two firing at once on the same note (two checkbox clicks, a bulk delete
 * racing a checkbox) could each read the pre-write source and clobber. Routing
 * every write through the graph's path chain serializes them — the next only reads
 * after the previous has written. (The open-note path is already serialized by
 * the session's save chain; this closes the disk path and any open↔closed gap.)
 */
const writeChains = new Map<string, Promise<unknown>>()

function serializeByPath<T>(path: string, generation: number, op: () => Promise<T>): Promise<T> {
  // Every task write funnels through here, so this is where a note inside a
  // read-only local-only folder refuses them all. An editable folder's notes
  // take them: Rust keeps those writes inside the folder, checked against the
  // text they were computed from.
  if (isLocalOnlyReadOnlyPath(path)) {
    return Promise.reject(
      new Error('This note is in a read-only local-only folder and can’t be edited.'),
    )
  }
  const key = JSON.stringify([generation, path])
  const previous = writeChains.get(key) ?? Promise.resolve()
  // Run `op` whether the previous write resolved or rejected — one failure must
  // not wedge the chain for the note.
  const result = previous.then(op, op)
  const settled = result.then(
    () => {},
    () => {},
  )
  writeChains.set(key, settled)
  void settled.then(() => {
    // Drop the entry once the chain goes idle, so the map can't grow unbounded.
    if (writeChains.get(key) === settled) {
      writeChains.delete(key)
    }
  })
  return result
}

interface WriteTaskEditsOptions {
  /** Treat a missing note as empty: the first task creates it (today's daily). */
  readonly createIfMissing?: boolean
}

/**
 * Apply Tasks-view edits (Plan 18) to one note and persist them, routing the
 * same way every time: when the note is **open**, through its live session,
 * which transforms its in-memory buffer synchronously, so unsaved edits survive
 * and there's no read-then-write gap for a concurrent keystroke. The session
 * declines (and we refuse rather than clobber via disk) only when it can't
 * persist now (loading, protected/read-only, or a parked conflict), surfaced as
 * {@link NoteBusyError}. When the note is **not** open, disk is the source of
 * truth: the edits apply to the bytes on disk and are written back checked
 * against them, re-applied to a concurrent change rather than clobbering it
 * (`patchNote`). Every locator in `edits` describes the note as the index last
 * saw it; one whose task is gone surfaces as `TaskStaleError` from the core
 * edit rather than a silent wrong write. The result reports where every task
 * of the note ended up, so callers can re-address cached rows before the
 * reindex.
 */
export function writeTaskEdits(
  notePath: string,
  edits: readonly TaskEdit[],
  generation: number,
  options: WriteTaskEditsOptions = {},
): Promise<TaskEditResult> {
  // Serialize per note: a concurrent change to the same note must not read the
  // pre-write source and clobber this one.
  return serializeByPath(notePath, generation, async (): Promise<TaskEditResult> => {
    const owner = openSession(notePath, generation)
    if (owner !== null) {
      let result: TaskEditResult | undefined
      const applied = await owner.commitSourceEdit((source) => {
        result = applyTaskEdits(source, edits)
        return result.source
      })
      if (!applied || result === undefined) {
        throw new NoteBusyError('This note can’t be updated right now — try again in a moment.')
      }
      return result
    }
    let result: TaskEditResult | undefined
    await patchNote(
      notePath,
      (source) => {
        if (source === null && options.createIfMissing !== true) {
          throw new ReflectError('notFound', `${notePath} does not exist`)
        }
        result = applyTaskEdits(source ?? '', edits)
        return result.source
      },
      generation,
    )
    if (result === undefined) {
      throw new Error('The task edit was not applied.')
    }
    return result
  })
}

/** Only the locator goes to the core edit: the note path merely picks the owner. */
function toLocator(task: TaskRef): TaskLocator {
  return { astPath: task.astPath, markdown: task.markdown, checked: task.checked }
}

function requireInserted(result: TaskEditResult): TaskSnapshot {
  const created = result.inserted[0]
  if (created === undefined) {
    throw new Error('The new task was not written.')
  }
  return created
}

/**
 * Toggle a task's checkbox from the Tasks view (Plan 18). The open-tasks view
 * only ever flips `[ ]`→`[x]`, but the primitive toggles, hence the name.
 */
export function toggleTask(task: TaskRef, generation: number): Promise<TaskEditResult> {
  return writeTaskEdits(task.notePath, [{ kind: 'toggle', task: toLocator(task) }], generation)
}

/**
 * Replace a task's Markdown from the inline Tasks editor (Plan 18), keeping its
 * checked state. `markdown` is the task's first paragraph without the marker.
 */
export function editTask(
  task: TaskRef,
  markdown: string,
  generation: number,
): Promise<TaskEditResult> {
  return writeTaskEdits(
    task.notePath,
    [{ kind: 'setMarkdown', task: toLocator(task), markdown }],
    generation,
  )
}

/** Delete a task from the Tasks view (Plan 18), the ⌫/⌘⌫ path. Nested items move up. */
export function deleteTask(task: TaskRef, generation: number): Promise<TaskEditResult> {
  return writeTaskEdits(task.notePath, [{ kind: 'remove', task: toLocator(task) }], generation)
}

/**
 * Demote a task to a plain bullet from the Tasks view — "Convert to bullet"
 * (Plan 18 follow-up). Drops just the checkbox, keeping the bullet and its
 * content, so the item leaves the Tasks projection while staying in the note.
 */
export function convertTaskToBullet(task: TaskRef, generation: number): Promise<TaskEditResult> {
  return writeTaskEdits(task.notePath, [{ kind: 'toBullet', task: toLocator(task) }], generation)
}

/**
 * Save an inline edit and toggle the task's checkbox in one write. Both edits
 * address the task as the index knew it; the batch resolves them before it
 * changes anything, so the toggle lands on the rewritten task.
 */
export function editAndToggleTask(
  task: TaskRef,
  markdown: string,
  generation: number,
): Promise<TaskEditResult> {
  const locator = toLocator(task)
  return writeTaskEdits(
    task.notePath,
    [
      { kind: 'setMarkdown', task: locator, markdown },
      { kind: 'toggle', task: locator },
    ],
    generation,
  )
}

/** Save an inline edit and convert the task to a bullet in one write. */
export function editAndConvertTaskToBullet(
  task: TaskRef,
  markdown: string,
  generation: number,
): Promise<TaskEditResult> {
  const locator = toLocator(task)
  return writeTaskEdits(
    task.notePath,
    [
      { kind: 'setMarkdown', task: locator, markdown },
      { kind: 'toBullet', task: locator },
    ],
    generation,
  )
}

/**
 * Continue entry from a grouped task: resolve the current draft and add a new
 * empty task at the end of the same parent item, in one write. Changed content
 * replaces the anchor's Markdown; cleared content removes the anchor. The
 * result addresses the new row and every moved row in the written note, so the
 * Tasks view can select the new task and re-key cached rows before reindexing
 * catches up.
 */
export async function continueTaskInContext(
  task: TaskRef,
  content: string | null,
  generation: number,
): Promise<ContinuedTaskInContext> {
  const locator = toLocator(task)
  const edits: TaskEdit[] = [
    { kind: 'insert', at: { kind: 'contextEnd', task: locator }, markdown: '' },
  ]
  if (content === '') {
    edits.push({ kind: 'remove', task: locator })
  } else if (content !== null) {
    edits.push({ kind: 'setMarkdown', task: locator, markdown: content })
  }
  const result = await writeTaskEdits(task.notePath, edits, generation)
  return { created: insertedNoteTask(task.notePath, result), moved: result.moved }
}

/**
 * Insert a new empty `+ [ ]` task at the end of `notePath` (Plan 18's Return-
 * to-add) and return its address, so the Tasks view can select the new row and
 * open its inline editor. A missing note (today's daily not yet created)
 * starts empty.
 */
export async function insertTask(notePath: string, generation: number): Promise<InsertedNoteTask> {
  const result = await writeTaskEdits(
    notePath,
    [{ kind: 'insert', at: { kind: 'documentEnd' }, markdown: '' }],
    generation,
    { createIfMissing: true },
  )
  return insertedNoteTask(notePath, result)
}

function insertedNoteTask(notePath: string, result: TaskEditResult): InsertedNoteTask {
  return {
    ...requireInserted(result),
    isPrivate: notePrivate(result.source) || isLocalOnlyPath(notePath),
    hasConflict: detectConflictMarkers(result.source),
  }
}
