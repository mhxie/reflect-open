import type { ClockService, TimerHandle } from '../ports/clock-service.ts'
import {
  writeGenerationFor,
  type GraphSession,
  type GraphSessionSource,
} from '../graph/graph-session.ts'
import type { IdService } from '../ports/id-service.ts'
import type { LoggerService } from '../ports/logger-service.ts'
import { errorMessage, isAppError, AppError } from '../errors.ts'
import { isEditableLocalOnlyPath, isLocalOnlyReadOnlyPath } from '../graph/local-only.ts'
import type { NoteFileService, NoteWriteResult } from '../graph/note-file-service.ts'
import type { NoteRecovery } from '../graph/schemas.ts'
import { appendBlock } from '../markdown/append-section.ts'
import { hasAuthoredTitle, parseNote } from '../markdown/extract.ts'
import {
  frontmatterPrivacy,
  parseFrontmatter,
  splitFrontmatter,
  upsertFrontmatter,
} from '../markdown/frontmatter.ts'
import type { NoteTitleMetadata } from '../markdown/note-title.ts'
import { splitDoc } from './note-session-doc.ts'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
import type {
  NoteSession,
  NoteSessionOptions,
  NoteSessionService,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from './note-session-types.ts'
import { isSaveBlockingError } from './save-blocking-error.ts'

export { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
export {
  INITIAL_NOTE_SNAPSHOT,
  type NoteContentOrigin,
  type NoteSession,
  type NoteSessionOptions,
  type NoteSessionService,
  type NoteSessionSnapshot,
  type NoteSessionStatus,
} from './note-session-types.ts'

/**
 * Where a session keeps its unsaved text when a save can't land: one copy per
 * note and session in the graph's `.reflect/recovery/`, each call pinned to
 * the session's graph generation. Built only for notes in an editable
 * local-only folder, which have no Git history to fall back on.
 */
interface NoteRecoveryIo {
  /**
   * Keep this session's text and return the ownership receipt for this version.
   */
  readonly preserve: (
    path: string,
    contents: string,
    sourceRevision: string | null,
  ) => Promise<NoteRecovery>
  /**
   * The newest unresolved session copy, or `null`.
   */
  readonly read: (path: string) => Promise<NoteRecovery | null>
  /**
   * Drop this exact version; missing and newer copies stay untouched.
   */
  readonly clear: (path: string, copy: NoteRecovery) => Promise<void>
}

/**
 * File access of one session, with the graph generation bound to its calls.
 */
interface NoteSessionIo {
  readonly read: (path: string) => Promise<string>
  /**
   * Atomic checked write: it names the revision the text was typed on
   * (`null`: the file must not exist yet), and a file that moved past it is
   * merged with it. `null` when the session never writes: it then tracks
   * dirtiness but every save and commit declines.
   */
  readonly write:
    | ((
        path: string,
        contents: string,
        expectedContents: string | null,
      ) => Promise<NoteWriteResult>)
    | null
  /**
   * Unsaved-text recovery; `null` everywhere but editable local-only notes.
   * With it, the session keeps the buffer whenever it can't be saved (a
   * failed save, a teardown or quit with one), drops the copy it kept once a
   * save lands, offers an earlier session's copy on load, and blocks input
   * while saves are blocked ({@link NoteSessionSnapshot.saveBlocked}).
   */
  readonly recovery: NoteRecoveryIo | null
}

const DEFAULT_SAVE_DEBOUNCE_MS = 800

export interface NoteSessionServiceDeps {
  readonly noteFile: NoteFileService
  readonly clock: ClockService
  readonly logger: LoggerService
  readonly id: IdService
  readonly graphSession: GraphSessionSource
}

class NoteSessionServiceImpl implements NoteSessionService {
  readonly #deps: NoteSessionServiceDeps

  constructor(deps: NoteSessionServiceDeps) {
    this.#deps = deps
  }

  create(options: NoteSessionOptions): NoteSession {
    return new NoteSessionImpl(this.#deps, options)
  }
}

export function createNoteSessionService(deps: NoteSessionServiceDeps): NoteSessionService {
  return new NoteSessionServiceImpl(deps)
}

/**
 * The file access a session gets for the graph open at its creation. A note
 * in a read-only local-only folder never gets a write channel, whatever the
 * pane asked for, and only a writable note in an editable local-only folder
 * keeps its unsaved text outside itself.
 */
function sessionIo(
  deps: NoteSessionServiceDeps,
  graph: GraphSession | null,
  options: NoteSessionOptions,
): NoteSessionIo {
  const { noteFile, graphSession, id } = deps
  if (graph === null) {
    return {
      read: () => Promise.reject(new AppError('noGraph', 'No graph is open.')),
      write: null,
      recovery: null,
    }
  }
  const generation = (): number => writeGenerationFor(graphSession, graph)
  const read = async (forPath: string): Promise<string> =>
    await noteFile.read(forPath, generation())
  if (options.readOnly === true || isLocalOnlyReadOnlyPath(graph.localOnly, options.path)) {
    return { read, write: null, recovery: null }
  }
  const write = async (
    forPath: string,
    contents: string,
    expectedContents: string | null,
  ): Promise<NoteWriteResult> =>
    await noteFile.write(forPath, contents, generation(), expectedContents)
  if (!isEditableLocalOnlyPath(graph.localOnly, options.path)) {
    return { read, write, recovery: null }
  }
  // One owner per session: Rust replaces only this owner's earlier copy.
  const ownerId = id.uuid().replaceAll('-', '')
  return {
    read,
    write,
    recovery: {
      preserve: async (forPath, contents, sourceRevision) =>
        await noteFile.writeRecovery(forPath, contents, ownerId, sourceRevision, generation()),
      read: async (forPath) => await noteFile.readRecovery(forPath, generation()),
      clear: async (forPath, copy) => {
        await noteFile.clearRecovery(forPath, copy.ownerId, copy.token, generation())
      },
    },
  }
}

/**
 * The document session for one note. See note-session-types.ts for semantics.
 */
class NoteSessionImpl implements NoteSession {
  readonly #deps: NoteSessionServiceDeps
  /**
   * The graph open when the session was created, `null` when none was.
   */
  readonly #graph: GraphSession | null
  readonly #io: NoteSessionIo
  readonly #classify: NoteSessionOptions['classify']
  readonly #onSnapshot: NoteSessionOptions['onSnapshot']
  readonly #applyContent: NoteSessionOptions['applyContent']
  readonly #onContent: NoteSessionOptions['onContent']
  readonly #reconcilePendingEditorInput: NoteSessionOptions['reconcilePendingEditorInput']
  readonly #createIfMissing: boolean
  readonly #missingSeed: NoteSessionOptions['missingSeed']
  readonly #saveDebounceMs: number

  /**
   * Mutable: a rename retargets the session in place (Plan 17).
   */
  path: string

  // Snapshot state (surfaces via onSnapshot).
  #status: NoteSessionStatus = 'loading'
  #initialContent = ''
  #isProtected = false
  #dirty = false
  #missing = false
  #error: string | null = null
  #privateHeader = true
  #titleMetadata: NoteTitleMetadata | undefined = undefined
  #recovery: NoteRecovery | null = null
  #saveBlocked = false

  // Pipeline state (never surfaces).
  /**
   * The **body** as of the last editor change (the editor never sees frontmatter).
   */
  #buffer = ''
  /**
   * The exact frontmatter bytes (with delimiters), `''` when none.
   */
  #header = ''
  /**
   * The full content most recently read from or written to disk.
   */
  #disk = ''
  /**
   * The text the buffer was typed on: the base a checked write names. It
   * differs from `#disk` only after a merged write raced newer keystrokes.
   */
  #writeBase = ''
  #saveTimer: TimerHandle | null = null
  /**
   * Serializes writes so a flush can't interleave with a debounced save.
   */
  #saveChain: Promise<void> = Promise.resolve()
  /**
   * Settles when the current initial load has committed its state.
   */
  #loadPromise: Promise<void> = Promise.resolve()
  /**
   * Content of the write currently in flight (set when dispatched, before the
   * write resolves). The watcher event for our own save can arrive before the
   * write settles and `disk` updates — matching against this prevents a false
   * conflict when the user kept typing during the save.
   */
  #inFlightWrite: string | null = null
  /**
   * True while we push external content into the editor via `applyContent`.
   */
  #applyingContent = false
  /**
   * True while the initial `load()` read is in flight.
   */
  #loading = false
  /**
   * A watcher event arrived during the load; replay reconciliation after it.
   */
  #missedChange = false
  #disposed = false
  /**
   * True while deletion has paused this session's persistence pipeline.
   */
  #deleting = false
  // Set by `discard` — tells `dispose` to skip its flush (the file is being
  // deleted, so rewriting it would recreate it).
  #discarded = false

  /**
   * True after a failed save retried once from its reconciliation; a landed write clears it.
   */
  #retriedFailedSave = false
  /**
   * This session has queued a draft; saves resolve only their captured versions.
   */
  #recoveryHeld = false
  /**
   * The text this session last put into the recovery copy.
   */
  #heldContents: string | null = null
  #heldRecovery: NoteRecovery | null = null
  #restoredRecovery: NoteRecovery | null = null
  #recoveryVersion = 0
  #heldVersion = 0
  /**
   * Serializes recovery-copy IO, so a drop never overtakes an earlier keep.
   */
  #recoveryChain: Promise<void> = Promise.resolve()

  #lastEmitted: NoteSessionSnapshot | null = null

  constructor(deps: NoteSessionServiceDeps, options: NoteSessionOptions) {
    this.#deps = deps
    this.#classify = options.classify
    this.#onSnapshot = options.onSnapshot
    this.#applyContent = options.applyContent
    this.#onContent = options.onContent
    this.#reconcilePendingEditorInput = options.reconcilePendingEditorInput
    this.#graph = deps.graphSession.getState().session
    this.#io = sessionIo(deps, this.#graph, options)
    this.path = options.path
    this.#createIfMissing = options.createIfMissing ?? false
    this.#missingSeed = options.missingSeed
    this.#saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS
  }

  retarget(to: string): void {
    this.path = to
  }

  generation(): number | null {
    return this.#graph === null ? null : writeGenerationFor(this.#deps.graphSession, this.#graph)
  }

  content(): string {
    return this.#header + this.#buffer
  }

  liveContent(): string | null {
    return this.#status === 'ready' ? this.#header + this.#buffer : null
  }

  isDirty(): boolean {
    return this.#dirty
  }

  isUnpersisted(): boolean {
    return this.#status === 'ready' && this.#missing && this.#inFlightWrite === null
  }

  #emit(): void {
    if (this.#disposed) {
      return
    }
    const next: NoteSessionSnapshot = {
      status: this.#status,
      initialContent: this.#initialContent,
      protected: this.#isProtected,
      dirty: this.#dirty,
      missing: this.#missing,
      error: this.#error,
      privateHeader: this.#privateHeader,
      ...(this.#titleMetadata === undefined ? {} : { titleMetadata: this.#titleMetadata }),
      recovery: this.#recovery,
      saveBlocked: this.#saveBlocked,
    }
    const last = this.#lastEmitted
    if (
      last !== null &&
      last.status === next.status &&
      last.initialContent === next.initialContent &&
      last.protected === next.protected &&
      last.dirty === next.dirty &&
      last.missing === next.missing &&
      last.error === next.error &&
      last.privateHeader === next.privateHeader &&
      last.titleMetadata?.displayTitle === next.titleMetadata?.displayTitle &&
      last.titleMetadata?.lang === next.titleMetadata?.lang &&
      last.recovery === next.recovery &&
      last.saveBlocked === next.saveBlocked
    ) {
      return
    }
    this.#lastEmitted = next
    this.#onSnapshot(next)
  }

  /**
   * Re-classify the live header after it changed. The whole document is
   * classified, not the header alone: a frontmatter block behind a leading
   * byte-order mark splits as body, yet the shared fail-closed classifier
   * counts it.
   */
  #classifyHeader(): void {
    this.#privateHeader = frontmatterPrivacy(this.#header + this.#buffer).kind !== 'public'
    const { data } = parseFrontmatter(splitFrontmatter(this.#header).raw)
    this.#titleMetadata =
      data.display_title || data.lang
        ? { displayTitle: data.display_title, lang: data.lang }
        : undefined
  }

  /**
   * Queue recovery-copy IO behind any earlier; a failure is logged, never thrown.
   */
  #enqueueRecovery(step: () => Promise<void>): void {
    this.#recoveryChain = this.#recoveryChain.then(step).catch((cause: unknown) => {
      this.#deps.logger.error('failed to keep or drop unsaved note text:', cause)
    })
  }

  /**
   * Keep this session's unsaved document where a later open finds it. Runs
   * after `dispose` too: a teardown flush that fails is exactly when the text
   * must survive the pane.
   */
  #preserveBuffer(): void {
    const recovery = this.#io.recovery
    if (recovery === null || this.#discarded) {
      return
    }
    const forPath = this.path
    const contents = this.#header + this.#buffer
    if (this.#recoveryHeld && this.#heldContents === contents) {
      return // already kept (a teardown flushes, then disposes)
    }
    this.#recoveryHeld = true
    this.#heldContents = contents
    this.#recoveryVersion += 1
    const version = this.#recoveryVersion
    const sourceRevision = this.#missing ? null : this.#writeBase
    if (this.#recovery !== null) {
      this.#recovery = null
      this.#emit()
    }
    this.#enqueueRecovery(async () => {
      try {
        this.#heldRecovery = await recovery.preserve(forPath, contents, sourceRevision)
        this.#heldVersion = version
      } catch (cause) {
        if (this.#recoveryVersion === version) {
          this.#recoveryHeld = this.#heldRecovery !== null
          this.#heldContents = this.#heldRecovery?.contents ?? null
        }
        throw cause
      }
    })
  }

  async #refreshRecovery(forPath: string): Promise<void> {
    const next = await this.#io.recovery?.read(forPath)
    if (!this.#disposed && this.path === forPath && this.#restoredRecovery === null) {
      this.#recovery = next ?? null
      this.#emit()
    }
  }

  /**
   * A write clears only copies that existed when it began.
   */
  #clearHeldRecovery(throughVersion: number, restored: NoteRecovery | null): void {
    const recovery = this.#io.recovery
    if (recovery === null || (!this.#recoveryHeld && restored === null)) {
      return
    }
    const forPath = this.path
    this.#enqueueRecovery(async () => {
      if (this.#heldRecovery !== null && this.#heldVersion <= throughVersion) {
        await recovery.clear(forPath, this.#heldRecovery)
        this.#heldRecovery = null
      }
      if (restored !== null) {
        await recovery.clear(forPath, restored)
        if (this.#restoredRecovery?.token === restored.token) {
          this.#restoredRecovery = null
        }
      }
      if (this.#recoveryVersion <= throughVersion) {
        this.#recoveryHeld = false
        this.#heldContents = null
      }
      await this.#refreshRecovery(forPath)
    })
  }

  #save(): void {
    // A discarded session never writes: its file is being deleted, so any
    // save — including a teardown `flush()` (the pane unmounts via flush →
    // dispose) or an already-queued step, would recreate it.
    if (
      this.#discarded ||
      this.#deleting ||
      this.#io.write === null ||
      !this.#dirty ||
      this.#isProtected
    ) {
      return
    }
    const write = this.#io.write
    this.#saveChain = this.#saveChain
      .then(async () => {
        // Re-check at execution time and take the freshest buffer — a queued
        // step can run behind a slow prior write, during which the user may
        // have reverted or kept typing, or the session may have been discarded
        // for a delete. (After dispose the buffer is frozen, so this same step
        // doubles as the final flush.)
        if (this.#discarded || this.#deleting || !this.#dirty || this.#isProtected) {
          return
        }
        const content = this.#header + this.#buffer
        const throughVersion = this.#recoveryVersion
        const restored = this.#restoredRecovery
        this.#inFlightWrite = content
        try {
          const result = await write(this.path, content, this.#missing ? null : this.#writeBase)
          this.#missing = false // the landed write created the file if it was missing
          this.#error = null // a previous save failure is resolved by this success
          this.#saveBlocked = false
          this.#retriedFailedSave = false
          // The text landed, merged or not: a copy kept for it is not needed.
          this.#clearHeldRecovery(throughVersion, restored)
          if (result.merged === null) {
            this.#disk = content
            this.#writeBase = content
            this.#dirty = this.#header + this.#buffer !== content
            this.#emit()
            this.#onContent?.(content, 'saved')
          } else {
            this.#adoptMergedWrite(content, result.merged)
          }
        } finally {
          this.#inFlightWrite = null
        }
      })
      .catch(async (cause) => {
        this.#deps.logger.error('failed to save note:', cause)
        this.#error = errorMessage(cause)
        this.#saveBlocked = this.#io.recovery !== null && isSaveBlockingError(cause)
        // Kept before the reconcile reads disk: the text must outlive this
        // session even when the read fails or the pane is already gone.
        this.#preserveBuffer()
        const retry = !this.#retriedFailedSave
        this.#retriedFailedSave = true
        await this.#reconcileFromDisk(retry)
        this.#emit()
      })
  }

  /**
   * Take the text a write merged into the file. `sent` is the content given to that write.
   */
  #adoptMergedWrite(sent: string, merged: string): void {
    this.#inFlightWrite = null
    // A merge that kept the title we sent is a local save for the rename tracker
    // (it may still hold a pending rename); any other title comes from elsewhere.
    const keptTitle = this.#titleOf(merged) === this.#titleOf(sent)
    this.#onContent?.(merged, keptTitle ? 'saved' : 'external')
    if (this.#header + this.#buffer !== sent) {
      // Keystrokes arrived during the write. They were typed on `sent`, so the
      // next save names it as the base and merges them with the file again.
      this.#disk = merged
      this.#writeBase = sent
      this.#dirty = true
      this.#emit()
      return
    }
    this.#adoptCleanContent(merged)
  }

  #titleOf(content: string): string | null {
    const parsed = parseNote({ path: this.path, source: content })
    return hasAuthoredTitle(parsed) ? parsed.title : null
  }

  #scheduleSave(): void {
    if (this.#deleting) {
      return
    }
    if (this.#saveTimer !== null) {
      this.#deps.clock.clearTimeout(this.#saveTimer)
    }
    this.#saveTimer = this.#deps.clock.setTimeout(() => {
      this.#saveTimer = null
      this.#save()
    }, this.#saveDebounceMs)
  }

  #cancelScheduledSave(): void {
    if (this.#saveTimer !== null) {
      this.#deps.clock.clearTimeout(this.#saveTimer)
      this.#saveTimer = null
    }
  }

  async flush(): Promise<void> {
    this.#reconcilePendingEditorInput?.()
    this.#cancelScheduledSave()
    this.#save()
    await this.#settleSaves()
    // A failed save queues its recovery copy before it settles, so waiting on
    // the recovery chain after the saves covers the copy too.
    await this.#recoveryChain
  }

  /**
   * Wait for the save chain, including the one retry a failed save queues behind itself.
   */
  async #settleSaves(): Promise<void> {
    let chain: Promise<void>
    do {
      chain = this.#saveChain
      await chain
    } while (chain !== this.#saveChain)
  }

  editorChanged(markdown: string): void {
    if (this.#applyingContent) {
      // This change is our own applyContent pushing disk content, not a user
      // edit. The editor's serialization may normalize (trailing newline, loose
      // lists) and differ from the disk bytes — that must not dirty the buffer
      // or schedule a save, or a reload would rewrite a file the user never
      // touched. Track the serialized form; dirtiness resumes with the next
      // real edit.
      this.#buffer = markdown
      return
    }
    this.#buffer = markdown
    this.#dirty = this.#header + markdown !== this.#disk
    if (!this.#dirty) {
      this.#writeBase = this.#disk
    }
    if (this.#missing && markdown.trim() === '') {
      // A still-unwritten note cleared back to nothing (e.g. the seeded
      // empty-title template deleted wholesale) stays unwritten: creating an
      // empty file would break the lazy no-litter contract. Dirtiness — and
      // the file's birth — resume with the next real content.
      this.#dirty = false
    }
    this.#emit()
    if (this.#dirty) {
      this.#scheduleSave()
    }
  }

  /**
   * Apply external content to the live editor without entering the save path.
   */
  #applyToEditor(content: string): void {
    this.#applyingContent = true
    try {
      // The editor dispatches synchronously, so its change handler runs (and is
      // suppressed) within this call.
      this.#applyContent(content)
    } finally {
      this.#applyingContent = false
    }
  }

  /**
   * Adopt `content` as the new clean document state, re-gating protection.
   */
  #adoptCleanContent(content: string): void {
    const doc = splitDoc(content)
    this.#header = doc.header
    this.#buffer = doc.body
    this.#classifyHeader()
    this.#disk = content
    this.#writeBase = content
    this.#dirty = false
    this.#missing = false // external content means the file exists on disk now
    // Nothing unsaved is left to protect, so the editor takes input again; a
    // later save that still can't land blocks it anew.
    this.#saveBlocked = false
    // Re-gate: the content may have introduced (or removed) syntax the editor
    // can't round-trip. When protection flips the pane remounts via
    // initialContent; otherwise reload the live editor in place.
    const unsafe = this.#classify(doc.body) === 'lossy'
    const flipped = unsafe !== this.#isProtected
    this.#isProtected = unsafe
    this.#initialContent = unsafe ? content : doc.body
    this.#emit()
    // While protected there is no live editor mounted (the pane shows the
    // read-only view), and unsafe content must never enter one regardless.
    if (!flipped && !unsafe && !this.#disposed) {
      this.#applyToEditor(doc.body)
    }
  }

  /**
   * Re-read the note and reconcile the buffer with what's on disk (the
   * external-change path).
   */
  async #reconcileFromDisk(saveIfDirty: boolean): Promise<void> {
    let content: string
    try {
      content = await this.#io.read(this.path)
    } catch (cause) {
      if (!this.#disposed && isAppError(cause) && cause.kind === 'notFound') {
        this.#missing = true
        this.#emit()
      }
      return // preserve the buffer if the file disappeared or cannot be read
    }
    if (this.#disposed) {
      return
    }
    if (content === this.#disk || content === this.#inFlightWrite) {
      // Nothing to reconcile (stale, or an echo of our own possibly
      // still-settling save) — but a successful read of a previously-missing
      // note means the file exists now (e.g. another device wrote the seed
      // verbatim), so record that transition before skipping.
      if (this.#missing) {
        this.#missing = false
        this.#emit()
      }
      return
    }
    if (this.#dirty) {
      // The file exists now, so the save is a checked write against the base
      // the buffer was typed on, and the write merges it with this content.
      if (this.#missing) {
        this.#missing = false
        this.#emit()
      }
      if (saveIfDirty) {
        this.#cancelScheduledSave()
        this.#save()
      }
      return
    }
    this.#adoptCleanContent(content)
    this.#onContent?.(content, 'external')
  }

  /**
   * The initial read; with `createIfMissing`, a missing file is an empty note.
   */
  async #readInitial(): Promise<{ content: string; fileMissing: boolean }> {
    try {
      return { content: await this.#io.read(this.path), fileMissing: false }
    } catch (cause) {
      if (this.#createIfMissing && isAppError(cause) && cause.kind === 'notFound') {
        return { content: '', fileMissing: true } // lazy note: created by the first save
      }
      throw cause
    }
  }

  /**
   * An earlier session's kept unsaved text, read alongside the note so the
   * offer is in place before the editor can take (and fail to save) an edit.
   * Failing to read it never fails the load.
   */
  async #readRecovery(): Promise<NoteRecovery | null> {
    const recovery = this.#io.recovery
    if (recovery === null) {
      return null
    }
    try {
      return await recovery.read(this.path)
    } catch (cause) {
      this.#deps.logger.error('failed to read kept unsaved note text:', cause)
      return null
    }
  }

  load(): void {
    this.#loading = true
    this.#missedChange = false
    this.#status = 'loading'
    this.#error = null
    this.#emit()
    this.#loadPromise = (async () => {
      try {
        const kept = this.#readRecovery()
        const { content, fileMissing } = await this.#readInitial()
        const keptCopy = await kept
        if (this.#disposed) {
          return
        }
        // A missing note adopts the seed as its clean baseline: the editor
        // shows the template, but disk-comparison sees no difference, so
        // nothing is written until a real edit (the lazy no-litter contract).
        const adopted = fileMissing && this.#missingSeed !== undefined ? this.#missingSeed : content
        const doc = splitDoc(adopted)
        this.#header = doc.header
        this.#buffer = doc.body
        this.#classifyHeader()
        this.#disk = adopted
        this.#writeBase = adopted
        this.#dirty = false
        this.#missing = fileMissing
        // The data-loss gate: a note the editor can't reproduce opens read-only.
        this.#isProtected = this.#classify(doc.body) === 'lossy'
        this.#initialContent = this.#isProtected ? adopted : doc.body
        if (keptCopy !== null && keptCopy.contents === content) {
          // The text did reach disk after all: nothing to offer.
          this.#clearHeldRecovery(this.#recoveryVersion, keptCopy)
        } else {
          this.#recovery = keptCopy
        }
        this.#status = 'ready'
        this.#emit()
        // The real disk content, not the seed: the rename tracker must
        // baseline untitled so the first authored title is a birth.
        this.#onContent?.(content, 'load')
      } catch (cause) {
        if (!this.#disposed) {
          this.#error = errorMessage(cause)
          this.#status = 'error'
          this.#emit()
        }
      } finally {
        if (!this.#disposed) {
          this.#loading = false
          // A change event during the load was deferred (reconciling mid-load
          // could be overwritten by this load's older read committing later);
          // replay it now against the committed state.
          if (this.#missedChange) {
            this.#missedChange = false
            void this.#reconcileFromDisk(true)
          }
        }
      }
    })()
    void this.#loadPromise
  }

  externalChanged(): void {
    if (this.#disposed) {
      return
    }
    if (this.#loading) {
      this.#missedChange = true // deferred; replayed when the load commits
      return
    }
    void this.#reconcileFromDisk(true)
  }

  followDisplacement(to: string, incomingAtFrom: string | null, keptOut: boolean): boolean {
    if (this.#disposed) {
      return false
    }
    if (incomingAtFrom !== null && incomingAtFrom === this.#disk) {
      // A reload or a merged save took the note now at the old path in before
      // this event: the document's bytes are the ones there, so it stays.
      return false
    }
    if (!keptOut && !this.#dirty && !this.#livePrivate()) {
      // A clean, public note: the other device's note now holds the path,
      // and this document adopts it like any external change.
      this.externalChanged()
      return false
    }
    this.path = to
    this.externalChanged()
    if (this.#dirty) {
      // Saves resume at the new path, checked against the base the buffer
      // was typed on.
      this.#scheduleSave()
    }
    return true
  }

  /**
   * The live document's frontmatter locks it (or can't be read): fail closed.
   */
  #livePrivate(): boolean {
    return (
      this.#status === 'ready' && frontmatterPrivacy(this.#header + this.#buffer).kind !== 'public'
    )
  }

  restoreRecovery(): void {
    if (
      this.#recovery === null ||
      this.#disposed ||
      this.#isProtected ||
      this.#status !== 'ready' ||
      this.#io.write === null
    ) {
      return
    }
    const kept = this.#recovery
    const doc = splitDoc(kept.contents)
    // The kept copy stays until this text lands, then goes like this
    // session's own.
    this.#restoredRecovery = kept
    this.#recovery = null
    this.#header = doc.header
    this.#buffer = doc.body
    this.#classifyHeader()
    this.#applyToEditor(doc.body)
    this.#dirty = this.#header + this.#buffer !== this.#disk
    if (this.#dirty && !this.#missing) {
      // The kept text was typed on the revision it was kept against: named as
      // the base, a note that changed since merges with the restored text
      // instead of being replaced by it.
      this.#writeBase = kept.sourceRevision ?? ''
    }
    this.#emit()
    if (this.#dirty) {
      this.#save()
    } else {
      this.#clearHeldRecovery(this.#recoveryVersion, this.#restoredRecovery)
    }
  }

  discardRecovery(): void {
    if (this.#recovery === null) {
      return
    }
    const discardedCopy = this.#recovery
    this.#recovery = null
    this.#emit()
    const recovery = this.#io.recovery
    if (recovery !== null) {
      const forPath = this.path
      this.#enqueueRecovery(async () => {
        await recovery.clear(forPath, discardedCopy)
        await this.#refreshRecovery(forPath)
      })
    }
  }

  updateFrontmatter(patch: FrontmatterPatch): boolean {
    if (this.#disposed || this.#isProtected || this.#status !== 'ready') {
      return false
    }
    const patched = splitDoc(
      upsertFrontmatter(this.#header + this.#buffer, frontmatterPatchToYaml(patch)),
    )
    // Only the header is taken from the patch, so one that rewrote the body
    // (a block behind a byte-order mark, which the editor shows as body)
    // would leave that old block, `private` and all, below the new one.
    if (patched.body !== this.#buffer) {
      throw new Error('refusing to update frontmatter the editor shows as body')
    }
    this.#header = patched.header
    this.#classifyHeader()
    this.#dirty = this.#header + this.#buffer !== this.#disk
    this.#emit()
    if (this.#dirty) {
      this.#scheduleSave()
    }
    return true
  }

  async commitFrontmatter(patch: FrontmatterPatch): Promise<boolean> {
    // No write channel (no graph generation yet) means the patch can't land —
    // say so, rather than riding `updateFrontmatter`'s in-memory success while
    // `save()` silently no-ops. A `true` here would let publish/pin/private
    // skip their disk fallback and treat an unwritten flag as persisted.
    if (this.#io.write === null) {
      return false
    }
    const previousHeader = this.#header
    if (!this.updateFrontmatter(patch)) {
      return false
    }
    const attemptedHeader = this.#header
    try {
      const shouldPersist = this.#dirty
      await this.flush()
      if (shouldPersist && this.#error !== null) {
        throw new Error(this.#error)
      }
      return true
    } catch (cause) {
      // Preserve body edits and any newer metadata change made during the write.
      if (this.#header === attemptedHeader) {
        this.#header = previousHeader
        this.#classifyHeader()
      }
      this.#dirty = this.#header + this.#buffer !== this.#disk
      this.#emit()
      throw cause
    }
  }

  /**
   * Apply an out-of-editor body edit (the Tasks view's toggle / edit / delete,
   * the suggested-contact card's append) transactionally:
   * `transform` rewrites the live document — header plus the unsaved buffer, so
   * concurrent editor edits survive — then we land it now so the Tasks view
   * refreshes promptly. A session still loading waits for the load first:
   * navigating to a note (⌘D to today) opens its session in the same tick the
   * Tasks view's unmount flush writes to it, and the pending read is a moment,
   * not a reason to refuse. Returns false when the session can't safely take a
   * body edit (no write channel, disposed, protected/read-only, or failed to
   * load) so the caller refuses rather than clobber the buffer
   * via disk. `transform` runs before any mutation, so a `TaskStaleError` (the
   * marker can't be located) propagates with nothing changed. And the write is
   * all-or-nothing: a failed flush reverts the in-memory edit so the editor and
   * the Tasks list can't diverge, then re-throws the failure.
   */
  async commitSourceEdit(transform: (full: string) => string): Promise<boolean> {
    // What the load can't change is refused at once; a stalled read must not
    // hold a session that could never write.
    if (this.#io.write === null || this.#disposed) {
      return false
    }
    if (this.#status === 'loading') {
      // Never rejects: a failed load settles as `status === 'error'`, which the
      // gate below refuses like any other unready session.
      await this.#loadPromise
    }
    // Protection is decided by the load, so this gate runs after the wait.
    if (this.#disposed || this.#isProtected || this.#status !== 'ready') {
      return false
    }
    this.#reconcilePendingEditorInput?.()
    const previousHeader = this.#header
    const previousBuffer = this.#buffer
    const previousInitialContent = this.#initialContent
    const doc = splitDoc(transform(this.#header + this.#buffer))
    this.#header = doc.header
    this.#buffer = doc.body
    this.#classifyHeader()
    // The pane seeds a mounting editor from `initialContent`; after a wait on
    // the load no editor is mounted yet, so the seed must carry the edit too.
    this.#initialContent = doc.body
    this.#applyToEditor(doc.body) // an already open editor shows the edited line
    this.#dirty = this.#header + this.#buffer !== this.#disk
    // A no-op edit (transform changed nothing) writes nothing, so a *prior*
    // surfaced save error must not be mistaken for this edit's failure.
    const shouldPersist = this.#dirty
    this.#emit()
    await this.flush()
    // `flush()` resolves even when the write failed (captured in `error`, not
    // thrown). Revert and surface the failure: it persists, or nothing changes.
    if (shouldPersist && this.#error !== null) {
      const message = this.#error
      if (this.#header === doc.header) this.#header = previousHeader
      if (this.#buffer === doc.body) {
        this.#buffer = previousBuffer
        this.#initialContent = previousInitialContent
        this.#applyToEditor(previousBuffer)
      }
      this.#classifyHeader()
      this.#dirty = this.#header + this.#buffer !== this.#disk
      this.#error = null
      this.#saveBlocked = false
      this.#emit()
      throw new Error(message)
    }
    return true
  }

  commitBodyAppend(block: string): Promise<boolean> {
    if (block.trim() === '') {
      return Promise.resolve(false)
    }
    return this.commitSourceEdit((full) => appendBlock(full, block))
  }

  dispose(): void {
    // A discarded session must not write: its file is being deleted, and a
    // flush would recreate it. Otherwise flush first — the queued save step
    // reads the (now frozen) buffer, so pending edits persist to this
    // session's path even after the UI moves on.
    if (!this.#discarded) {
      void this.flush()
    }
    this.#disposed = true
  }

  discard(): void {
    this.#cancelScheduledSave()
    this.#discarded = true
    this.#disposed = true
  }

  async prepareDelete(): Promise<boolean> {
    this.#deleting = true
    this.#cancelScheduledSave()
    await this.#loadPromise
    await this.#saveChain
    return this.#status === 'ready' && this.#missing && this.#inFlightWrite === null
  }

  cancelDelete(): void {
    if (!this.#deleting || this.#discarded) {
      return
    }
    this.#deleting = false
    if (!this.#disposed && this.#dirty) {
      this.#scheduleSave()
    }
  }
}
