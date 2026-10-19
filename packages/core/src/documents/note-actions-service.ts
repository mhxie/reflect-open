import { isIsoDate } from '@reflect/utils'
import {
  requireGraphSession,
  type GraphSession,
  type GraphSessionSource,
} from '../graph/graph-session.ts'
import type { IdService } from '../ports/id-service.ts'
import type { ProgressPort } from '../ports/progress-port.ts'
import type { PathService } from '../ports/path-service.ts'
import { errorMessage } from '../errors.ts'
import { isLocalOnlyPath, isLocalOnlyReadOnlyPath } from '../graph/local-only.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { dateFromDailyPath, isDaily } from '../graph/paths.ts'
import type { NoteDeleteOutcome } from '../graph/schemas.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import type { IndexQueryService, PinnedNote } from '../indexing/index-query-service.ts'
import { parseNote } from '../markdown/extract.ts'
import { dailyDeepLink, noteDeepLink } from '../navigation/deep-link-format.ts'
import { isPinned, type ParsedNote } from '../markdown/model.ts'
import type { NoteDocumentService } from './note-document-service.ts'
import {
  applyPinnedNoteOverlays,
  type NoteRowOverlayPatch,
  type NoteRowService,
} from './note-row-service.ts'
import type { OpenDocumentsService } from './open-documents-service.ts'
import { getNextPinOrder, isValidPinOrder } from './pin-order.ts'

/**
 * How a deduped, self-reporting note action ended:
 *
 * - `done`: the action ran; the result carries what the note now holds.
 * - `skipped`: the action left the note alone on purpose, with nothing to
 *   report (a read-only local-only note's pin, a local-only note's privacy).
 * - `failed`: the action failed and reported the error through operations.
 */
export type NoteActionOutcome<Result> =
  | ({ readonly status: 'done' } & Result)
  | { readonly status: 'skipped' }
  | { readonly status: 'failed' }

/**
 * What a pin action left in the note's frontmatter.
 */
export interface NotePinResult {
  readonly pinned: boolean
  /**
   * The written shelf order; `null` for an unpinned note and for a bare `pinned: true`.
   */
  readonly pinOrder: number | null
}

/**
 * One pin order that {@link NoteActionsService.reorderPinned} wrote.
 */
export interface NotePinOrderWrite {
  readonly path: string
  readonly pinOrder: number
}

/**
 * What a privacy action left in the note's frontmatter.
 */
export interface NotePrivacyResult {
  readonly isPrivate: boolean
  /**
   * Whether the flag changed. False when the note already held the asked-for
   * value: its file then keeps its bytes.
   */
  readonly changed: boolean
}

/**
 * What {@link NoteActionsService.setNotesPrivate} did, for the caller's own
 * feedback (the Undo that sets `changed` back).
 */
export interface NotePrivacyBatchResult {
  /**
   * The notes whose flag changed, in request order.
   */
  readonly changed: readonly string[]
  /**
   * Notes left alone: local-only, unreadable, already being written, or failed.
   */
  readonly skipped: number
}

export interface NoteTrashFailure {
  readonly path: string
  readonly cause: unknown
}

/**
 * Which notes went to the trash and which could not, each in request order.
 */
export interface NoteTrashResult {
  readonly succeeded: readonly string[]
  readonly failed: readonly NoteTrashFailure[]
  /**
   * Of `succeeded`, the notes the system Trash refused, which stay in the
   * graph's own `.reflect/trash/` (a note from an editable local-only folder).
   */
  readonly keptInGraph: readonly string[]
}

/**
 * The status line's caveat for a delete the system Trash did not take: an
 * editable local-only note stays in the graph's own trash folder.
 */
export const KEPT_IN_GRAPH_TRASH = 'Moved to .reflect/trash in this graph'

/**
 * What the Lock control says for a note whose frontmatter can't be read: the
 * shared classifier treats it as locked, and a toggle would rewrite YAML
 * Reflect couldn't parse.
 */
export const UNREADABLE_FRONTMATTER_LABEL = "Frontmatter can't be read — treated as locked"

/**
 * How to get an unreadable note's lock back.
 */
export const UNREADABLE_FRONTMATTER_HINT = "Fix this note's frontmatter to lock or unlock it."

/**
 * Whether a note may be moved to the trash. Daily notes are the app's
 * chronological spine and cannot be deleted.
 */
export function canTrashNote(path: string): boolean {
  return !isDaily(path)
}

/**
 * Whether the Lock control must leave a note alone: it is treated as locked,
 * but its frontmatter can't be parsed — unreadable, or locked by a `private:`
 * line in YAML that doesn't load — so a toggle would have to rewrite YAML
 * Reflect couldn't read.
 */
export function hasUnreadableLock(
  note: Pick<ParsedNote, 'frontmatterPrivacy' | 'frontmatterWarning'>,
): boolean {
  const { kind } = note.frontmatterPrivacy
  return kind === 'unreadable' || (kind === 'private' && note.frontmatterWarning !== undefined)
}

/**
 * The user's actions on one note that are not edits: pin, private, trash,
 * copy deep link, copy path. Markdown owns the final state; pin, private, and
 * trash record what they write in the note-row overlay ({@link NoteRowService})
 * so every reader shows it before the index catches up, and a failure drops
 * that overlay again.
 */
export interface NoteActionsService {
  /**
   * Toggle the pin from the state the note's frontmatter holds now. A pin
   * takes the shelf order after the highest on the shelf (index rows merged
   * with the overlay), or a bare `pinned: true` when the shelf cannot be read.
   * Deduped with {@link NoteActionsService.unpin} per generation and path: a
   * second call while one is in flight returns the first call's result. A
   * failure is reported as an "Updating pin" operation; with no graph open it
   * fails without a report. A note in a read-only local-only folder is
   * skipped: its frontmatter can't be written, so no pin flashes and nothing
   * is read or reported.
   */
  togglePinned(path: string): Promise<NoteActionOutcome<NotePinResult>>
  /**
   * Remove a pin directionally, without reading the current pin state. Skips
   * a read-only local-only note like {@link NoteActionsService.togglePinned}.
   */
  unpin(path: string): Promise<NoteActionOutcome<NotePinResult>>
  /**
   * Write the shelf order of each note that carries a valid one, and return
   * the orders written. Calls write one after another, in call order. Rejects
   * when a write fails. Writes nothing when no graph is open.
   */
  reorderPinned(
    notes: ReadonlyArray<Pick<PinnedNote, 'path' | 'pinnedOrder'>>,
  ): Promise<NotePinOrderWrite[]>
  /**
   * Toggle `private` from the state the note's frontmatter holds now; the
   * result's `isPrivate` is the new state, so an Undo sets `!isPrivate` back
   * ({@link NoteActionsService.setNotesPrivate}). The note is read before any
   * optimistic state is shown. A note inside a local-only folder is private by
   * its path and is skipped without a report. A locked note whose frontmatter
   * can't be read ({@link hasUnreadableLock}) stays locked and untouched: the
   * action fails with {@link UNREADABLE_FRONTMATTER_LABEL} and
   * {@link UNREADABLE_FRONTMATTER_HINT}. Deduped per generation and path like
   * {@link NoteActionsService.togglePinned}; a failure is reported as an
   * "Updating privacy" operation.
   */
  togglePrivate(path: string): Promise<NoteActionOutcome<NotePrivacyResult>>
  /**
   * Set every listed note's `private` flag to `isPrivate`, one note at a time,
   * under the same rules as {@link NoteActionsService.togglePrivate}. A note
   * already in that state keeps its file byte for byte, and a note whose
   * privacy is being written right now is skipped. Reports what changed, so
   * the caller can offer one Undo (`setNotesPrivate(changed, !isPrivate)`).
   * Writes nothing when no graph is open.
   */
  setNotesPrivate(paths: readonly string[], isPrivate: boolean): Promise<NotePrivacyBatchResult>
  /**
   * Whether `path` may be moved to the trash; see {@link canTrashNote}.
   */
  canTrash(path: string): boolean
  /**
   * Delete a regular note and detach its editor session without flushing.
   *
   * The file goes to the trash: the OS-native trash on desktop, the
   * graph-local `.reflect/trash/` on mobile (which has no OS trash). A note in
   * an editable local-only folder can stay in `.reflect/trash/` on desktop
   * too, when the system Trash refuses it (`keptInGraph`). It is recoverable
   * either way, and sync-ignored. Once it is in the trash, the note-row overlay
   * marks it `trashed` until the index drops it (the desktop watcher's
   * reindex, or the mobile write echo). Daily notes are intentionally blocked.
   *
   * The session first pauses persistence and settles its initial load plus any
   * write already in flight. A lazy-created note that still has no backing file
   * is deleted by discarding that session alone. Otherwise delete first, discard
   * second. If the filesystem delete fails, persistence resumes so the mounted
   * editor remains intact. Only once the file is in trash do we discard the
   * session; otherwise a normal teardown flush could recreate the deleted file.
   *
   * Never rejects and reports nothing: a failure comes back in `failed`.
   */
  trash(path: string): Promise<NoteTrashResult>
  /**
   * {@link NoteActionsService.trash}, resolving with which trash took the note
   * (`null`: a note with no file yet was only discarded), and rejecting with
   * the cause when the note could not be trashed.
   */
  trashOne(path: string): Promise<NoteDeleteOutcome | null>
  /**
   * {@link NoteActionsService.trash} for each path in order, under one
   * "Trashing notes" operation. A failure is recorded, not rethrown
   * mid-batch, so the remaining notes still trash; the operation then fails
   * with the last error, or with `No graph is open.` when none is. With no
   * failure but notes the system Trash refused, it ends with the
   * {@link KEPT_IN_GRAPH_TRASH} warning.
   */
  trashMany(paths: readonly string[]): Promise<NoteTrashResult>
  /**
   * The most durable deep link the note can have. A daily note is addressed
   * by its date. A regular note is addressed by its frontmatter `id`, minted
   * here on first use for notes that predate Plan 17's ids or were created
   * outside Reflect, so the link survives every rename; the id lands through
   * the session-or-disk frontmatter channel like pin and private do.
   */
  deepLinkFor(path: string): Promise<string>
  /**
   * Resolve the graph-relative `path` against the open graph's root to an
   * absolute filesystem path for use in tools outside Reflect (agent chats,
   * editors, terminals). Joining through the host preserves the host
   * platform's path syntax. Rejects when no graph is open.
   */
  absolutePathFor(path: string): Promise<string>
}

export interface NoteActionsServiceDeps {
  readonly noteDocuments: NoteDocumentService
  readonly noteFile: NoteFileService
  readonly openDocuments: OpenDocumentsService
  readonly indexLifecycle: IndexLifecycleService
  readonly indexQuery: IndexQueryService
  readonly noteRows: NoteRowService
  readonly progress: ProgressPort
  readonly path: PathService
  readonly id: IdService
  readonly graphSession: GraphSessionSource
}

/**
 * The pin and privacy toggles' outcome with no graph open: failed, with nothing to report.
 */
const NO_GRAPH: { readonly status: 'failed' } = { status: 'failed' }

/**
 * An action that left the note alone on purpose.
 */
const SKIPPED: { readonly status: 'skipped' } = { status: 'skipped' }

class NoteActionsServiceImpl implements NoteActionsService {
  readonly #deps: NoteActionsServiceDeps
  readonly #pendingPins = new Map<string, Promise<NoteActionOutcome<NotePinResult>>>()
  readonly #pendingPrivacy = new Map<string, Promise<NoteActionOutcome<NotePrivacyResult>>>()
  #reorderChain: Promise<unknown> = Promise.resolve()

  constructor(deps: NoteActionsServiceDeps) {
    this.#deps = deps
  }

  async togglePinned(path: string): Promise<NoteActionOutcome<NotePinResult>> {
    const session = this.#deps.graphSession.getState().session
    if (session === null) {
      return NO_GRAPH
    }
    if (isLocalOnlyReadOnlyPath(session.localOnly, path)) {
      return SKIPPED
    }
    const { generation } = session
    return await this.#dedupe(this.#pendingPins, path, generation, () => {
      return this.#updatePin(path, generation, 'toggle')
    })
  }

  async unpin(path: string): Promise<NoteActionOutcome<NotePinResult>> {
    const session = this.#deps.graphSession.getState().session
    if (session === null) {
      return NO_GRAPH
    }
    if (isLocalOnlyReadOnlyPath(session.localOnly, path)) {
      return SKIPPED
    }
    const { generation } = session
    return await this.#dedupe(this.#pendingPins, path, generation, () => {
      return this.#updatePin(path, generation, 'unpin')
    })
  }

  async reorderPinned(
    notes: ReadonlyArray<Pick<PinnedNote, 'path' | 'pinnedOrder'>>,
  ): Promise<NotePinOrderWrite[]> {
    const { noteRows, graphSession } = this.#deps
    const session = graphSession.getState().session
    if (session === null) {
      return []
    }
    const { generation } = session
    const writes: NotePinOrderWrite[] = []
    for (const note of notes) {
      const order = note.pinnedOrder
      if (isValidPinOrder(order)) {
        writes.push({ path: note.path, pinOrder: order })
        noteRows.setOverlay(note.path, generation, { pinnedOrder: order })
      }
    }
    // The overlay shows every reorder at once; the writes land in call order.
    const run = this.#reorderChain.then(() => this.#writePinOrders(writes, generation))
    this.#reorderChain = run.catch(() => undefined)
    return await run
  }

  async togglePrivate(path: string): Promise<NoteActionOutcome<NotePrivacyResult>> {
    const session = this.#deps.graphSession.getState().session
    if (session === null) {
      return NO_GRAPH
    }
    if (isLocalOnlyPath(session.localOnly, path)) {
      return SKIPPED
    }
    const { generation } = session
    return await this.#dedupe(this.#pendingPrivacy, path, generation, () => {
      return this.#writePrivacy(path, generation, (current) => !current)
    })
  }

  async setNotesPrivate(
    paths: readonly string[],
    isPrivate: boolean,
  ): Promise<NotePrivacyBatchResult> {
    const session = this.#deps.graphSession.getState().session
    if (session === null) {
      return { changed: [], skipped: paths.length }
    }
    const { generation, localOnly } = session
    const changed: string[] = []
    let skipped = 0
    for (const path of paths) {
      const key = JSON.stringify([generation, path])
      if (isLocalOnlyPath(localOnly, path) || this.#pendingPrivacy.has(key)) {
        skipped += 1
        continue
      }
      const outcome = await this.#dedupe(this.#pendingPrivacy, path, generation, () => {
        return this.#writePrivacy(path, generation, () => isPrivate)
      })
      if (outcome.status !== 'done') {
        skipped += 1
      } else if (outcome.changed) {
        changed.push(path)
      }
    }
    return { changed, skipped }
  }

  canTrash(path: string): boolean {
    return canTrashNote(path)
  }

  async trash(path: string): Promise<NoteTrashResult> {
    try {
      const outcome = await this.#trashOne(
        path,
        requireGraphSession(this.#deps.graphSession).generation,
      )
      return {
        succeeded: [path],
        failed: [],
        keptInGraph: outcome?.trashed === 'graph' ? [path] : [],
      }
    } catch (cause) {
      return { succeeded: [], failed: [{ path, cause }], keptInGraph: [] }
    }
  }

  async trashOne(path: string): Promise<NoteDeleteOutcome | null> {
    return await this.#trashOne(path, requireGraphSession(this.#deps.graphSession).generation)
  }

  async trashMany(paths: readonly string[]): Promise<NoteTrashResult> {
    const { progress, graphSession } = this.#deps
    const succeeded: string[] = []
    const failed: NoteTrashFailure[] = []
    const keptInGraph: string[] = []
    if (paths.length === 0) {
      return { succeeded, failed, keptInGraph }
    }
    let session: GraphSession
    try {
      session = requireGraphSession(graphSession)
    } catch (cause) {
      progress.fail('Trashing notes', errorMessage(cause))
      return { succeeded, failed: paths.map((path) => ({ path, cause })), keptInGraph }
    }
    const operation = progress.start('Trashing notes')
    operation.progress(0, paths.length)
    let attempted = 0
    for (const path of paths) {
      try {
        const outcome = await this.#trashOne(path, session.generation)
        succeeded.push(path)
        if (outcome?.trashed === 'graph') {
          keptInGraph.push(path)
        }
      } catch (cause) {
        failed.push({ path, cause })
      }
      attempted += 1
      operation.progress(attempted, paths.length)
    }
    const last = failed.at(-1)
    if (last !== undefined) {
      operation.fail(errorMessage(last.cause))
    } else if (keptInGraph.length > 0) {
      operation.warn(
        keptInGraph.length === 1
          ? KEPT_IN_GRAPH_TRASH
          : `${KEPT_IN_GRAPH_TRASH}: ${keptInGraph.length} notes`,
      )
    } else {
      operation.done()
    }
    return { succeeded, failed, keptInGraph }
  }

  async deepLinkFor(path: string): Promise<string> {
    return await this.#deepLinkFor(path, requireGraphSession(this.#deps.graphSession))
  }

  async absolutePathFor(path: string): Promise<string> {
    const session = requireGraphSession(this.#deps.graphSession)
    return await this.#deps.path.join(session.root, path)
  }

  /**
   * Run `action` once per key at a time; a call while it runs gets the same promise.
   */
  #dedupe<Result>(
    pending: Map<string, Promise<Result>>,
    path: string,
    generation: number,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const key = JSON.stringify([generation, path])
    const inFlight = pending.get(key)
    if (inFlight !== undefined) {
      return inFlight
    }
    const run = action().finally(() => {
      pending.delete(key)
    })
    pending.set(key, run)
    return run
  }

  /**
   * The pinned notes the index lists, or `null` when the index cannot say.
   */
  async #readIndexedShelf(): Promise<PinnedNote[] | null> {
    const { indexQuery } = this.#deps
    try {
      return await indexQuery.getPinnedNotes()
    } catch {
      return null
    }
  }

  #pinOverlay(pinned: boolean, order: number | null): NoteRowOverlayPatch {
    return pinned ? { isPinned: true, pinnedOrder: order } : { isPinned: false }
  }

  async #updatePin(
    path: string,
    generation: number,
    kind: 'toggle' | 'unpin',
  ): Promise<NoteActionOutcome<NotePinResult>> {
    const { noteRows, noteDocuments, progress } = this.#deps
    let written: NoteRowOverlayPatch | null = null
    try {
      // Predict from what readers show now, so the overlay lands before the note is read.
      let order: number | null = null
      let predicted = false
      if (kind === 'toggle') {
        const indexed = await this.#readIndexedShelf()
        // Merged with the overlay after the await, so a concurrent pin's order counts.
        const shelf =
          indexed === null
            ? null
            : applyPinnedNoteOverlays(indexed, noteRows.getOverlaysOn(generation), (notePath) => ({
                path: notePath,
                title: '',
                dailyDate: null,
                pinnedOrder: null,
              }))
        // A shelf the index cannot read can't say what the next order is. A
        // bare `pinned: true` still pins; the note sorts last until a reorder numbers it.
        order = shelf === null ? null : getNextPinOrder(shelf)
        predicted = shelf?.some((note) => note.path === path) !== true
      }
      written = this.#pinOverlay(predicted, order)
      noteRows.setOverlay(path, generation, written)
      const pinned =
        kind === 'unpin'
          ? false
          : !isPinned(parseNote({ path, source: await noteDocuments.readSource(path) }).frontmatter)
      const pinOrder = pinned ? order : null
      if (pinned !== predicted) {
        written = this.#pinOverlay(pinned, order)
        noteRows.setOverlay(path, generation, written)
      }
      await noteDocuments.commitFrontmatter(
        path,
        { pinned: pinned ? (pinOrder ?? true) : false },
        generation,
      )
      return { status: 'done', pinned, pinOrder }
    } catch (cause) {
      if (written !== null) {
        noteRows.dropOverlay(path, generation, written)
      }
      progress.fail('Updating pin', errorMessage(cause))
      return { status: 'failed' }
    }
  }

  /**
   * Set one note's `private` flag to what `decide` picks from its current
   * value. The note is read first, so an unreadable lock never shows unlocked,
   * not even for a moment; the overlay then shows the decided value before the
   * write lands.
   */
  async #writePrivacy(
    path: string,
    generation: number,
    decide: (current: boolean) => boolean,
  ): Promise<NoteActionOutcome<NotePrivacyResult>> {
    const { noteRows, noteDocuments, progress } = this.#deps
    let written: NoteRowOverlayPatch | null = null
    try {
      const parsed = parseNote({ path, source: await noteDocuments.readSource(path) })
      if (hasUnreadableLock(parsed)) {
        progress.fail(
          'Updating privacy',
          `${UNREADABLE_FRONTMATTER_LABEL}. ${UNREADABLE_FRONTMATTER_HINT}`,
        )
        return { status: 'failed' }
      }
      const current = parsed.frontmatter.private === true
      const isPrivate = decide(current)
      written = { isPrivate }
      noteRows.setOverlay(path, generation, written)
      // A note already in the asked-for state keeps its file byte for byte.
      if (isPrivate !== current) {
        await noteDocuments.commitFrontmatter(path, { private: isPrivate }, generation)
      }
      return { status: 'done', isPrivate, changed: isPrivate !== current }
    } catch (cause) {
      if (written !== null) {
        noteRows.dropOverlay(path, generation, written)
      }
      progress.fail('Updating privacy', errorMessage(cause))
      return { status: 'failed' }
    }
  }

  async #writePinOrders(
    writes: readonly NotePinOrderWrite[],
    generation: number,
  ): Promise<NotePinOrderWrite[]> {
    const { noteRows, noteDocuments } = this.#deps
    try {
      await Promise.all(
        writes.map(async (write) => {
          await noteDocuments.commitFrontmatter(write.path, { pinned: write.pinOrder }, generation)
        }),
      )
      return [...writes]
    } catch (cause) {
      for (const write of writes) {
        noteRows.dropOverlay(write.path, generation, { pinnedOrder: write.pinOrder })
      }
      throw cause
    }
  }

  async #trashOne(path: string, generation: number): Promise<NoteDeleteOutcome | null> {
    const { noteFile, openDocuments, noteRows } = this.#deps
    if (!canTrashNote(path)) {
      throw new Error('Daily notes cannot be deleted')
    }
    const session = openDocuments.sessionFor(path)
    const unpersisted = await session?.prepareDelete()
    if (session !== null && unpersisted === true) {
      noteRows.setOverlay(path, generation, { trashed: true })
      session.discard()
      return null
    }
    let outcome: NoteDeleteOutcome
    try {
      outcome = await noteFile.delete(path, generation)
    } catch (cause) {
      session?.cancelDelete()
      throw cause
    }
    // Marked only once the file is gone: a note that fails stays listed.
    noteRows.setOverlay(path, generation, { trashed: true })
    session?.discard()
    const currentSession = openDocuments.sessionFor(path)
    if (currentSession !== session) {
      currentSession?.discard()
    }
    return outcome
  }

  async #deepLinkFor(path: string, session: GraphSession): Promise<string> {
    const { noteDocuments, id, indexLifecycle } = this.#deps
    if (isDaily(path)) {
      const date = dateFromDailyPath(path)
      // Calendar-validated like the router: a daily/ file with an impossible
      // date (2026-02-31) routes as a plain note everywhere else, so it gets a
      // note address too: a date form would be a link the parser rejects.
      if (date !== null && isIsoDate(date)) {
        return dailyDeepLink(date)
      }
    }
    const source = await noteDocuments.readSource(path)
    // A blank `id:` counts as no id (same rule as the CLI's `reflect open`):
    // linking it would emit `reflect://note/`, which the parser rejects.
    const existing = parseNote({ path, source }).frontmatter.id
    if (existing !== undefined && existing.trim() !== '') {
      return noteDeepLink(existing)
    }
    const minted = id.noteId()
    await noteDocuments.commitFrontmatter(path, { id: minted }, session.generation)
    // Resolution reads the index, which trails local writes by a watcher
    // debounce: index the mint now so the copied link resolves immediately.
    // Best-effort: the watcher pass covers this on its own schedule anyway.
    if (session.indexGeneration !== null) {
      try {
        await indexLifecycle.indexNote(path, {
          generation: session.indexGeneration,
          fileGeneration: session.generation,
        })
      } catch {
        // the copied link still works once the watcher reindexes the note
      }
    }
    return noteDeepLink(minted)
  }
}

export function createNoteActionsService(deps: NoteActionsServiceDeps): NoteActionsService {
  return new NoteActionsServiceImpl(deps)
}
