import {
  appendBlock,
  detectConflictMarkers,
  errorMessage,
  frontmatterPrivacy,
  isAppError,
  notePrivate,
  parseFrontmatter,
  splitFrontmatter,
  upsertFrontmatter,
  type NoteRecovery,
  type NoteTitleMetadata,
} from '@reflect/core'
import { splitDoc } from './note-session-doc.ts'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
import type {
  NoteSession,
  NoteSessionOptions,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from './note-session-types.ts'
import { isSaveBlockingError } from './save-blocking-error.ts'

const DEFAULT_SAVE_DEBOUNCE_MS = 800

/** Create the document session for one note. See note-session.ts for semantics. */
export function createNoteSession(options: NoteSessionOptions): NoteSession {
  const { io, classify, onSnapshot, applyContent, onContent, reconcilePendingEditorInput } = options
  /** Mutable: a rename retargets the session in place (Plan 17). */
  let path = options.path
  const createIfMissing = options.createIfMissing ?? false
  const missingSeed = options.missingSeed
  const saveDebounceMs = options.saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS

  // Snapshot state (surfaces via onSnapshot).
  let status: NoteSessionStatus = 'loading'
  let initialContent = ''
  let isProtected = false
  let dirty = false
  let missing = false
  let conflict: string | null = null
  let error: string | null = null
  let privateHeader = true
  let titleMetadata: NoteTitleMetadata | undefined
  let recovery: NoteRecovery | null = null
  let saveBlocked = false

  // Pipeline state (never surfaces).
  /** The **body** as of the last editor change (the editor never sees frontmatter). */
  let buffer = ''
  /** The exact frontmatter bytes (with delimiters), `''` when none. */
  let header = ''
  /** The full content most recently read from or written to disk. */
  let disk = ''
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Serializes writes so a flush can't interleave with a debounced save. */
  let saveChain: Promise<void> = Promise.resolve()
  /** Settles when the current initial load has committed its state. */
  let loadPromise: Promise<void> = Promise.resolve()
  /**
   * Content of the write currently in flight (set when dispatched, before the
   * write resolves). The watcher event for our own save can arrive before the
   * write settles and `disk` updates — matching against this prevents a false
   * conflict when the user kept typing during the save.
   */
  let inFlightWrite: string | null = null
  /** True while we push external content into the editor via `applyContent`. */
  let applyingContent = false
  /** True while the initial `load()` read is in flight. */
  let loading = false
  /** A watcher event arrived during the load; replay reconciliation after it. */
  let missedChange = false
  let disposed = false
  /** True while deletion has paused this session's persistence pipeline. */
  let deleting = false
  // Set by `discard` — tells `dispose` to skip its flush (the file is being
  // deleted, so rewriting it would recreate it).
  let discarded = false
  /** This session has queued a draft; saves resolve only their captured versions. */
  let recoveryHeld = false
  /** The text this session last put into the recovery copy. */
  let heldContents: string | null = null
  let heldRecovery: NoteRecovery | null = null
  let restoredRecovery: NoteRecovery | null = null
  let recoveryVersion = 0
  let heldVersion = 0
  /** Serializes recovery-copy IO, so a drop never overtakes an earlier keep. */
  let recoveryChain: Promise<void> = Promise.resolve()

  let lastEmitted: NoteSessionSnapshot | null = null

  function emit(): void {
    if (disposed) {
      return
    }
    const next: NoteSessionSnapshot = {
      status,
      initialContent,
      protected: isProtected,
      dirty,
      missing,
      conflict,
      error,
      privateHeader,
      ...(titleMetadata === undefined ? {} : { titleMetadata }),
      recovery,
      saveBlocked,
    }
    if (
      lastEmitted !== null &&
      lastEmitted.status === next.status &&
      lastEmitted.initialContent === next.initialContent &&
      lastEmitted.protected === next.protected &&
      lastEmitted.dirty === next.dirty &&
      lastEmitted.missing === next.missing &&
      lastEmitted.conflict === next.conflict &&
      lastEmitted.error === next.error &&
      lastEmitted.privateHeader === next.privateHeader &&
      lastEmitted.titleMetadata?.displayTitle === next.titleMetadata?.displayTitle &&
      lastEmitted.titleMetadata?.lang === next.titleMetadata?.lang &&
      lastEmitted.recovery === next.recovery &&
      lastEmitted.saveBlocked === next.saveBlocked
    ) {
      return
    }
    lastEmitted = next
    onSnapshot(next)
  }

  /**
   * Re-classify the live header after it changed. The whole document is
   * classified, not the header alone: a frontmatter block behind a leading
   * byte-order mark splits as body, yet the shared classifier counts it.
   */
  function classifyHeader(): void {
    privateHeader = notePrivate(header + buffer)
    const data = parseFrontmatter(splitFrontmatter(header).raw).data
    titleMetadata =
      data.display_title || data.lang
        ? { displayTitle: data.display_title, lang: data.lang }
        : undefined
  }

  /** Queue recovery-copy IO behind any earlier; a failure is logged, never thrown. */
  function enqueueRecovery(step: () => Promise<void>): void {
    recoveryChain = recoveryChain.then(step).catch((cause: unknown) => {
      console.error('failed to keep or drop unsaved note text:', cause)
    })
  }

  /**
   * Keep this session's unsaved document where a later open finds it.
   * Runs after `dispose` too: a teardown flush that fails is exactly when the
   * text must survive the pane.
   */
  function preserveBuffer(): void {
    const keep = io.recovery?.preserve
    if (keep === undefined || discarded) {
      return
    }
    const forPath = path
    const contents = header + buffer
    if (recoveryHeld && heldContents === contents) {
      return // already kept (a teardown flushes, then disposes)
    }
    recoveryHeld = true
    heldContents = contents
    const version = ++recoveryVersion
    const sourceRevision = missing ? null : disk
    if (recovery !== null) {
      recovery = null
      emit()
    }
    enqueueRecovery(async () => {
      try {
        heldRecovery = await keep(forPath, contents, sourceRevision)
        heldVersion = version
      } catch (cause) {
        if (recoveryVersion === version) {
          recoveryHeld = heldRecovery !== null
          heldContents = heldRecovery?.contents ?? null
        }
        throw cause
      }
    })
  }

  async function refreshRecovery(forPath: string): Promise<void> {
    const next = await io.recovery?.read(forPath)
    if (!disposed && path === forPath && restoredRecovery === null) {
      recovery = next ?? null
      emit()
    }
  }

  /** A write clears only copies that existed when it began. */
  function clearHeldRecovery(throughVersion: number, restored: NoteRecovery | null): void {
    const clear = io.recovery?.clear
    if (clear === undefined || (!recoveryHeld && restored === null)) {
      return
    }
    const forPath = path
    enqueueRecovery(async () => {
      if (heldRecovery !== null && heldVersion <= throughVersion) {
        await clear(forPath, heldRecovery)
        heldRecovery = null
      }
      if (restored !== null) {
        await clear(forPath, restored)
        if (restoredRecovery?.token === restored.token) {
          restoredRecovery = null
        }
      }
      if (recoveryVersion <= throughVersion) {
        recoveryHeld = false
        heldContents = null
      }
      await refreshRecovery(forPath)
    })
  }

  function save(): void {
    // A discarded session never writes: its file is being deleted, so any
    // save — including a teardown `flush()` (the pane unmounts via flush →
    // dispose) or an already-queued step — would recreate it. A parked
    // conflict likewise pauses all saves: writing the buffer before the user
    // chooses Keep mine / Load theirs would clobber the external change and
    // defeat the non-destructive flow.
    if (discarded || deleting || io.write === null || !dirty || isProtected || conflict !== null) {
      return
    }
    const write = io.write
    saveChain = saveChain
      .then(async () => {
        // Re-check at execution time and take the freshest buffer — a queued
        // step can run behind a slow prior write, during which the user may
        // have reverted or kept typing, or the session may have been discarded
        // for a delete. (After dispose the buffer is frozen, so this same step
        // doubles as the final flush.)
        if (discarded || deleting || !dirty || isProtected || conflict !== null) {
          return
        }
        const content = header + buffer
        const throughVersion = recoveryVersion
        const restored = restoredRecovery
        inFlightWrite = content
        try {
          await write(path, content, missing ? null : disk)
          disk = content
          dirty = header + buffer !== content
          missing = false // the landed write created the file if it was missing
          error = null // a previous save failure is resolved by this success
          saveBlocked = false
          emit()
          clearHeldRecovery(throughVersion, restored)
          onContent?.(content, 'saved')
        } finally {
          inFlightWrite = null
        }
      })
      .catch(async (cause) => {
        console.error('failed to save note:', cause)
        error = errorMessage(cause)
        saveBlocked = io.recovery !== undefined && isSaveBlockingError(cause)
        // Kept before the reconcile reads disk: the text must outlive this
        // session even when the read fails or the pane is already gone.
        preserveBuffer()
        await reconcileFromDisk()
        emit()
      })
  }

  function scheduleSave(): void {
    if (deleting) {
      return
    }
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
    }
    saveTimer = setTimeout(() => {
      saveTimer = null
      save()
    }, saveDebounceMs)
  }

  function cancelScheduledSave(): void {
    if (saveTimer !== null) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  }

  function flush(): Promise<void> {
    reconcilePendingEditorInput?.()
    cancelScheduledSave()
    save()
    if (dirty && conflict !== null) {
      // A parked conflict pauses saves, so a teardown or quit flush writes
      // nothing: keep the unsaved text instead.
      preserveBuffer()
    }
    // save() extended the chain synchronously (or left it settled when there
    // was nothing to do) — the chain as of now is exactly this flush's write.
    // Any recovery copy it keeps is queued before that write settles, so
    // waiting on the recovery chain after it covers the copy too.
    return saveChain.then(() => recoveryChain)
  }

  function editorChanged(markdown: string): void {
    if (applyingContent) {
      // This change is our own applyContent pushing disk content, not a user
      // edit. The editor's serialization may normalize (trailing newline, loose
      // lists) and differ from the disk bytes — that must not dirty the buffer
      // or schedule a save, or a reload would rewrite a file the user never
      // touched. Track the serialized form; dirtiness resumes with the next
      // real edit.
      buffer = markdown
      return
    }
    buffer = markdown
    dirty = header + markdown !== disk
    if (missing && markdown.trim() === '') {
      // A still-unwritten note cleared back to nothing (e.g. the seeded
      // empty-title template deleted wholesale) stays unwritten: creating an
      // empty file would break the lazy no-litter contract. Dirtiness — and
      // the file's birth — resume with the next real content.
      dirty = false
    }
    emit()
    if (dirty) {
      scheduleSave()
    }
  }

  /** Apply external content to the live editor without entering the save path. */
  function applyToEditor(content: string): void {
    applyingContent = true
    try {
      // The editor dispatches synchronously, so its change handler runs (and is
      // suppressed) within this call.
      applyContent(content)
    } finally {
      applyingContent = false
    }
  }

  /** Adopt `content` as the new clean document state, re-gating protection. */
  function adoptCleanContent(content: string): void {
    const doc = splitDoc(content)
    header = doc.header
    buffer = doc.body
    classifyHeader()
    disk = content
    dirty = false
    missing = false // external content means the file exists on disk now
    // Nothing unsaved is left to protect, so the editor takes input again; a
    // later save that still can't land blocks it anew.
    saveBlocked = false
    // Re-gate: the content may have introduced (or removed) syntax the editor
    // can't round-trip. When protection flips the pane remounts via
    // initialContent; otherwise reload the live editor in place.
    const unsafe = detectConflictMarkers(content) || classify(doc.body) === 'lossy'
    const flipped = unsafe !== isProtected
    isProtected = unsafe
    initialContent = unsafe ? content : doc.body
    emit()
    // While protected there is no live editor mounted (the pane shows the
    // read-only view), and unsafe content must never enter one regardless.
    if (!flipped && !unsafe) {
      applyToEditor(doc.body)
    }
    onContent?.(content, 'external')
  }

  /**
   * Re-read the note and reconcile the buffer with what's on disk (the
   * external-change path).
   */
  async function reconcileFromDisk(): Promise<void> {
    let content: string
    try {
      content = await io.read(path)
    } catch (cause) {
      if (!disposed && isAppError(cause) && cause.kind === 'notFound') {
        missing = true
        emit()
      }
      return // preserve the buffer if the file disappeared or cannot be read
    }
    if (disposed) {
      return
    }
    if (content === disk || content === inFlightWrite) {
      // Nothing to reconcile (stale, or an echo of our own possibly
      // still-settling save) — but a successful read of a previously-missing
      // note means the file exists now (e.g. another device wrote the seed
      // verbatim), so record that transition before skipping.
      if (missing) {
        missing = false
        emit()
      }
      return
    }
    if (dirty) {
      // Never clobber unsaved edits — park the external content and pause the
      // save pipeline (cancel any pending debounce) until the user chooses; a
      // save landing now would overwrite "theirs" first. The unsaved text is
      // kept meanwhile, so closing the pane can't lose it.
      cancelScheduledSave()
      conflict = content
      emit()
      preserveBuffer()
      return
    }
    adoptCleanContent(content)
  }

  /** The initial read; with `createIfMissing`, a missing file is an empty note. */
  async function readInitial(): Promise<{ content: string; fileMissing: boolean }> {
    try {
      return { content: await io.read(path), fileMissing: false }
    } catch (cause) {
      if (createIfMissing && isAppError(cause) && cause.kind === 'notFound') {
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
  async function readRecovery(): Promise<NoteRecovery | null> {
    const read = io.recovery?.read
    if (read === undefined) {
      return null
    }
    try {
      return await read(path)
    } catch (cause) {
      console.error('failed to read kept unsaved note text:', cause)
      return null
    }
  }

  function load(): void {
    loading = true
    missedChange = false
    status = 'loading'
    conflict = null
    error = null
    emit()
    loadPromise = (async () => {
      try {
        const kept = readRecovery()
        const { content, fileMissing } = await readInitial()
        const keptCopy = await kept
        if (disposed) {
          return
        }
        // A missing note adopts the seed as its clean baseline: the editor
        // shows the template, but disk-comparison sees no difference, so
        // nothing is written until a real edit (the lazy no-litter contract).
        const adopted = fileMissing && missingSeed !== undefined ? missingSeed : content
        const doc = splitDoc(adopted)
        header = doc.header
        buffer = doc.body
        classifyHeader()
        disk = adopted
        dirty = false
        missing = fileMissing
        // The data-loss gate: a note the editor can't reproduce opens read-only.
        // Conflict markers need their own check: the round trip mangles them
        // but still classifies `normalizing` (meowdown 0.65.3).
        isProtected = detectConflictMarkers(adopted) || classify(doc.body) === 'lossy'
        initialContent = isProtected ? adopted : doc.body
        if (keptCopy !== null && keptCopy.contents === content) {
          // The text did reach disk after all: nothing to offer.
          clearHeldRecovery(recoveryVersion, keptCopy)
        } else {
          recovery = keptCopy
        }
        status = 'ready'
        emit()
        // The real disk content, not the seed: the rename tracker must
        // baseline untitled so the first authored title is a birth.
        onContent?.(content, 'load')
      } catch (cause) {
        if (!disposed) {
          error = errorMessage(cause)
          status = 'error'
          emit()
        }
      } finally {
        if (!disposed) {
          loading = false
          // A change event during the load was deferred (reconciling mid-load
          // could be overwritten by this load's older read committing later);
          // replay it now against the committed state.
          if (missedChange) {
            missedChange = false
            void reconcileFromDisk()
          }
        }
      }
    })()
    void loadPromise
  }

  function externalChanged(): void {
    if (disposed) {
      return
    }
    if (loading) {
      missedChange = true // deferred; replayed when the load commits
      return
    }
    void reconcileFromDisk()
  }

  /** The live document's frontmatter locks it (or can't be read): fail closed. */
  function livePrivate(): boolean {
    return status === 'ready' && frontmatterPrivacy(header + buffer).kind !== 'public'
  }

  function followDisplacement(
    to: string,
    incomingAtFrom: string | null,
    keptOut: boolean,
  ): boolean {
    if (disposed) {
      return false
    }
    if (!keptOut && !dirty && conflict === null && !livePrivate()) {
      // A clean, public note: the other device's note now holds the path,
      // and this document adopts it like any external change.
      externalChanged()
      return false
    }
    if (conflict !== null && (incomingAtFrom === null || conflict === incomingAtFrom)) {
      // The parked "theirs" is the other device's note, which keeps the old
      // path: it is no longer this document's conflict. When the old path
      // couldn't be read there is no telling, so the conflict is re-derived
      // from the moved bytes below; kept, a stale one would make Keep mine
      // write against bytes the copy never held.
      conflict = null
    }
    path = to
    emit()
    externalChanged()
    if (dirty && conflict === null) {
      // Saves resume at the new path, checked against the moved bytes.
      scheduleSave()
    }
    return true
  }

  function keepMine(): void {
    if (conflict !== null) {
      disk = conflict
      missing = false
    }
    conflict = null
    dirty = true // force the rewrite even if content drifted equal
    emit()
    save()
  }

  function loadTheirs(): void {
    if (conflict === null) {
      return
    }
    const content = conflict
    conflict = null
    // Same re-gating as the clean-reload path: never load lossy content into a
    // live editor whose next save would drop what it can't model.
    adoptCleanContent(content)
    // Choosing theirs discards the unsaved text: drop the copy kept for it
    // (and a restored one), or the next open would offer it back.
    clearHeldRecovery(recoveryVersion, restoredRecovery)
  }

  function restoreRecovery(): void {
    if (
      recovery === null ||
      disposed ||
      isProtected ||
      status !== 'ready' ||
      conflict !== null ||
      io.write === null
    ) {
      return
    }
    const kept = recovery
    const doc = splitDoc(kept.contents)
    // The kept copy stays until this text lands (or Load theirs drops it),
    // then goes like this session's own.
    restoredRecovery = kept
    recovery = null
    header = doc.header
    buffer = doc.body
    classifyHeader()
    applyToEditor(doc.body)
    if (!missing && kept.sourceRevision !== disk) {
      // Disk moved on since the text was kept: restoring must not silently
      // replace that newer version. Park it exactly like an external change
      // over unsaved edits — the kept revision is the base, the current file
      // is "theirs" — so Keep mine / Load theirs decides.
      cancelScheduledSave()
      conflict = disk
      disk = kept.sourceRevision ?? ''
      dirty = true
      emit()
      return
    }
    dirty = header + buffer !== disk
    emit()
    if (dirty) {
      save()
    } else {
      clearHeldRecovery(recoveryVersion, restoredRecovery)
    }
  }

  function discardRecovery(): void {
    if (recovery === null) {
      return
    }
    const discardedCopy = recovery
    recovery = null
    emit()
    const clear = io.recovery?.clear
    if (clear !== undefined) {
      const forPath = path
      enqueueRecovery(async () => {
        await clear(forPath, discardedCopy)
        await refreshRecovery(forPath)
      })
    }
  }

  function updateFrontmatter(patch: FrontmatterPatch): boolean {
    if (disposed || isProtected || status !== 'ready') {
      return false
    }
    const patched = splitDoc(upsertFrontmatter(header + buffer, frontmatterPatchToYaml(patch)))
    // Only the header is taken from the patch, so one that rewrote the body
    // (a block behind a byte-order mark, which the editor shows as body)
    // would leave that old block, `private` and all, below the new one.
    if (patched.body !== buffer) {
      throw new Error('refusing to update frontmatter the editor shows as body')
    }
    header = patched.header
    classifyHeader()
    dirty = header + buffer !== disk
    emit()
    if (dirty) {
      scheduleSave()
    }
    return true
  }

  async function commitFrontmatter(patch: FrontmatterPatch): Promise<boolean> {
    // No write channel (no graph generation yet) means the patch can't land —
    // say so, rather than riding `updateFrontmatter`'s in-memory success while
    // `save()` silently no-ops. A `true` here would let publish/pin/private
    // skip their disk fallback and treat an unwritten flag as persisted.
    if (io.write === null) {
      return false
    }
    const previousHeader = header
    if (!updateFrontmatter(patch)) {
      return false
    }
    const attemptedHeader = header
    try {
      if (conflict === null) {
        const shouldPersist = dirty
        await flush()
        if (shouldPersist && error !== null) {
          throw new Error(error)
        }
      } else {
        // Keep both conflict resolutions consistent with the persisted flag.
        // The parked text is what disk held: a newer version is refused.
        const patched = upsertFrontmatter(conflict, frontmatterPatchToYaml(patch))
        if (patched !== conflict) {
          await io.write(path, patched, conflict)
          conflict = patched
          disk = patched
          emit()
        }
      }
      return true
    } catch (cause) {
      // Preserve body edits and any newer metadata change made during the write.
      if (header === attemptedHeader) {
        header = previousHeader
        classifyHeader()
      }
      dirty = header + buffer !== disk
      emit()
      throw cause
    }
  }

  /**
   * Apply an out-of-editor body edit (the Tasks view's toggle / edit / delete,
   * the suggested-contact card's append) transactionally:
   * `transform` rewrites the live document — header plus the unsaved buffer, so
   * concurrent editor edits survive — then we land it now so the Tasks view
   * refreshes promptly. Returns false when the session can't safely take a body
   * edit (no write channel, disposed, protected/read-only, still loading, or a
   * parked conflict) so the caller refuses rather than clobber the buffer via disk.
   * `transform` runs before any mutation, so a `TaskStaleError` (the marker can't
   * be located) propagates with nothing changed. And the write is all-or-nothing:
   * a failed flush reverts the in-memory edit so the editor and the Tasks list
   * can't diverge, then re-throws the failure.
   */
  async function commitBodyEdit(transform: (full: string) => string): Promise<boolean> {
    if (io.write === null || disposed || isProtected || status !== 'ready' || conflict !== null) {
      return false
    }
    reconcilePendingEditorInput?.()
    const previousHeader = header
    const previousBuffer = buffer
    const doc = splitDoc(transform(header + buffer))
    header = doc.header
    buffer = doc.body
    classifyHeader()
    applyToEditor(doc.body) // the open editor shows the edited line
    dirty = header + buffer !== disk
    // A no-op edit (transform changed nothing) writes nothing, so a *prior*
    // surfaced save error must not be mistaken for this edit's failure.
    const shouldPersist = dirty
    emit()
    await flush()
    // `flush()` resolves even when the write failed (captured in `error`, not
    // thrown). Revert and surface the failure: it persists, or nothing changes.
    if (shouldPersist && error !== null) {
      const message = error
      if (header === doc.header) header = previousHeader
      if (buffer === doc.body) {
        buffer = previousBuffer
        applyToEditor(previousBuffer)
      }
      classifyHeader()
      dirty = header + buffer !== disk
      error = null
      saveBlocked = false
      emit()
      throw new Error(message)
    }
    return true
  }

  function commitBodyAppend(block: string): Promise<boolean> {
    if (block.trim() === '') {
      return Promise.resolve(false)
    }
    return commitBodyEdit((full) => appendBlock(full, block))
  }

  function dispose(): void {
    // A discarded session must not write: its file is being deleted, and a
    // flush would recreate it. Otherwise flush first — the queued save step
    // reads the (now frozen) buffer, so pending edits persist to this
    // session's path even after the UI moves on.
    if (!discarded) {
      void flush()
    }
    disposed = true
  }

  function discard(): void {
    cancelScheduledSave()
    discarded = true
    disposed = true
  }

  async function prepareDelete(): Promise<boolean> {
    deleting = true
    cancelScheduledSave()
    await loadPromise
    await saveChain
    return status === 'ready' && missing && inFlightWrite === null
  }

  function cancelDelete(): void {
    if (!deleting || discarded) {
      return
    }
    deleting = false
    if (!disposed && dirty) {
      scheduleSave()
    }
  }

  return {
    get path() {
      return path
    },
    retarget: (to: string) => {
      path = to
    },
    followDisplacement,
    load,
    editorChanged,
    externalChanged,
    flush,
    keepMine,
    loadTheirs,
    restoreRecovery,
    discardRecovery,
    content: () => header + buffer,
    liveContent: () => (status === 'ready' ? header + buffer : null),
    isDirty: () => dirty,
    isUnpersisted: () => status === 'ready' && missing && inFlightWrite === null,
    prepareDelete,
    cancelDelete,
    updateFrontmatter,
    commitFrontmatter,
    commitBodyAppend,
    commitSourceEdit: commitBodyEdit,
    dispose,
    discard,
  }
}
