import type { RoundTripFidelity } from '@meowdown/markdown'
import type { NoteRecovery } from '../graph/schemas.ts'
import type { NoteTitleMetadata } from '../markdown/note-title.ts'
import type { FrontmatterPatch } from './note-session-frontmatter.ts'

export type NoteSessionStatus = 'loading' | 'ready' | 'error'

/** The observable document state, emitted to `onSnapshot` whenever it changes. */
export interface NoteSessionSnapshot {
  /**
   * The live header's display metadata (`display_title`, `lang`); absent when
   * it sets neither. It never changes the note's canonical title.
   */
  titleMetadata?: NoteTitleMetadata
  status: NoteSessionStatus
  /**
   * Markdown to seed the editor with once `status` is `ready` — the body
   * (the editor never sees frontmatter). While `protected` it is the **full**
   * file instead: the read-only view's job is honest display of a file we
   * refuse to touch, frontmatter included.
   */
  initialContent: string
  /**
   * True when the editor cannot faithfully round-trip this note (a converter
   * gap, e.g. task lists today) — the note opens read-only and is **never**
   * auto-rewritten, so no content can be silently lost.
   */
  protected: boolean
  /** True while the buffer has changes not yet written to disk. */
  dirty: boolean
  /**
   * True when the initial load found no file (the lazy-create contract): the
   * note exists only as this buffer until the first save lands.
   */
  missing: boolean
  /** External content waiting on the user's choice (set only when dirty). */
  conflict: string | null
  error: string | null
  /**
   * True when the live frontmatter, the header the next save writes, keeps
   * the note on the device: `private: true`, or a block the shared fail-closed
   * classifier can't read. It follows in-app frontmatter patches and adopted
   * external changes before the index catches up, and starts `true` until the
   * note has loaded.
   */
  privateHeader: boolean
  /**
   * Unsaved text an earlier session kept when this note couldn't be saved
   * (only notes in an editable local-only folder keep it), offered until the
   * user restores or discards it; `null` when there is none.
   */
  recovery: NoteRecovery | null
  /**
   * True while saves fail in a way retrying alone won't fix (only notes in an
   * editable local-only folder): the local-only folder is unavailable, a link
   * changed, the file's bytes aren't on this Mac, or the OS refused the
   * write. The editor stops taking input, without remounting, until a save
   * lands; the unsaved text is kept meanwhile.
   */
  saveBlocked: boolean
}

/** The snapshot before a session has loaded anything. */
export const INITIAL_NOTE_SNAPSHOT: NoteSessionSnapshot = {
  status: 'loading',
  initialContent: '',
  protected: false,
  dirty: false,
  missing: false,
  conflict: null,
  error: null,
  privateHeader: true,
  recovery: null,
  saveBlocked: false,
}

/** Why {@link NoteSessionOptions.onContent} fired. */
export type NoteContentOrigin = 'load' | 'external' | 'saved'

export interface NoteSessionOptions {
  /** Graph-relative path of the note this session owns. */
  path: string
  /**
   * True for a session that tracks dirtiness but never writes, as is every
   * session created while no graph is open, and every session of a note in a
   * read-only local-only folder (the app reads those but never edits them).
   * Otherwise every write is pinned to the generation of the graph open at
   * creation, read at write time so a reopen of that graph carries over. A
   * writable note in an editable local-only folder also keeps its unsaved
   * text when a save can't land ({@link NoteSessionSnapshot.recovery}).
   */
  readOnly?: boolean
  /**
   * Round-trip fidelity check gating editability (meowdown's `checkRoundTrip`).
   */
  classify: (markdown: string) => RoundTripFidelity
  /** Receives every state change. Not called after `dispose()`. */
  onSnapshot: (snapshot: NoteSessionSnapshot) => void
  /**
   * Receives the full document (frontmatter + body) whenever it transitions
   * to a known-on-disk state: the initial load, an adopted external change
   * (including "load theirs"), or a landed save. `saved` is the only
   * user-driven origin — the title-rename tracker (Plan 07b) keys off it.
   */
  onContent?: ((content: string, origin: NoteContentOrigin) => void) | undefined
  /**
   * Push content into the live editor (external reload / "load theirs"). The
   * editor's change handler may fire synchronously during this call; the
   * session recognizes the re-entry and won't treat it as a user edit.
   */
  applyContent: (markdown: string) => void
  /**
   * Ask the live editor to reconcile pending native input immediately before
   * persistence. When reconciliation changes the document, the implementation
   * must deliver that change to {@link NoteSession.editorChanged} synchronously
   * before returning. A normalized but unchanged snapshot must not be emitted
   * as an edit.
   */
  reconcilePendingEditorInput?: (() => void) | undefined
  /**
   * Treat a missing file as an empty note on load instead of an error; the
   * file is then created by the first save — Plan 06's lazy daily-note
   * contract: opening a day never litters the graph, writing does. Applies
   * only to the initial load: a note deleted mid-session still reconciles to
   * a no-op rather than silently emptying the editor.
   */
  createIfMissing?: boolean | undefined
  /**
   * Markdown to seed a **missing** note's buffer with (only meaningful with
   * `createIfMissing`) — the new-note title template. The seed is adopted as
   * the clean dirty-comparison baseline, so opening still writes nothing: the
   * file is created only once the user edits, lazy contract intact. The
   * rename tracker baselines on the real (empty) disk content, so the first
   * authored title stays a birth, not a rename.
   */
  missingSeed?: string | undefined
  saveDebounceMs?: number
}
/**
 * One open note's document lifecycle. Create via {@link NoteSessionService.create}.
 */
export interface NoteSession {
  /** The graph-relative path this session is bound to (mutable via {@link NoteSession.retarget}). */
  readonly path: string
  /**
   * Rebind the session to a renamed path (Plan 17). The *file* moved; the
   * document didn't — buffer, header, dirtiness, and conflict state are all
   * untouched, and every subsequent read/write uses `to`. Call after flushing,
   * right before the file move lands, so a racing save can never resurrect
   * the old path.
   */
  retarget(to: string): void
  /**
   * The file generation this session's reads and writes carry right now: the
   * open graph's when it is the graph the session was created on (a reopen
   * of that graph carries over), else the creation graph's own, which Rust
   * rejects. `null` for a session created while no graph was open.
   */
  generation(): number | null
  /**
   * A pull moved this note's file aside to `to` (`name (this device).ext`)
   * and wrote the other device's note at the session's path, whose bytes
   * were `incomingAtFrom` (`null` when they couldn't be read). The document
   * follows its bytes to `to` when the moved note was kept out (`keptOut`),
   * the buffer is dirty, a conflict is parked, or the live header reads as
   * private: otherwise its next save would put this device's text back over
   * the other device's note. Following first drops a parked conflict equal
   * to `incomingAtFrom` (that note keeps the old path), or any parked
   * conflict when `incomingAtFrom` is unknown, then reconciles against
   * `to` — equal bytes change nothing, a dirty buffer parks them, a clean
   * one adopts them. A clean, public note stays and adopts the
   * incoming note instead. Returns whether the session moved; the caller
   * re-keys the open-documents registry and announces the move.
   */
  followDisplacement(to: string, incomingAtFrom: string | null, keptOut: boolean): boolean
  /** Read the note and emit `ready` (or `error`). Call once after creation. */
  load(): void
  /** Every editor document change enters the pipeline here. */
  editorChanged(markdown: string): void
  /** The watcher reported an on-disk change to this note; reconcile. */
  externalChanged(): void
  /**
   * Persist pending edits now (e.g. on window blur). Resolves once the
   * flushed write has settled — quit-time teardown awaits this so the webview
   * can't die before the bytes land. When the write can't land (a parked
   * conflict, a failed save), it resolves once the unsaved text is kept
   * ({@link NoteSessionSnapshot.recovery}) for a note that keeps it.
   */
  flush(): Promise<void>
  /** Resolve a conflict by keeping the buffer (rewrites the file). */
  keepMine(): void
  /** Resolve a conflict by loading the external content (discards the buffer). */
  loadTheirs(): void
  /**
   * Put the offered {@link NoteSessionSnapshot.recovery} into the buffer as an
   * edit and save it now, checked against what disk holds like any save —
   * when disk still holds the revision the copy was kept against (or the
   * note is gone). When the note changed since, nothing is written: the
   * current file is parked as the conflict, so Keep mine / Load theirs
   * decides. A no-op without an offer, before the note has loaded, while
   * protected, or while a conflict is parked (resolve that first).
   */
  restoreRecovery(): void
  /**
   * Drop the offered {@link NoteSessionSnapshot.recovery} and its kept copy.
   */
  discardRecovery(): void
  /** The full current document (frontmatter + buffer), as a save would write it. */
  content(): string
  /**
   * The live document **only when the session has loaded** (`status` is
   * `ready`), else `null`. Distinguishes a genuinely-empty loaded note (return
   * `''` — authoritative) from one still loading (return `null` — the buffer
   * is `''` only because the read hasn't landed). Callers that read the live
   * buffer for an out-of-band use (e.g. sharing) fall back to disk on `null`
   * rather than treating the loading buffer's emptiness as the truth.
   */
  liveContent(): string | null
  /**
   * Whether the buffer holds unsaved edits right now. A pull accessor for
   * out-of-band consumers (the iCloud conflict sweep skips dirty notes,
   * Plan 21) — everything reactive should keep using snapshots.
   */
  isDirty(): boolean
  /**
   * Whether this lazy-created note still exists only in the editor session.
   * Returns false while loading, once a file is known to exist, or while a
   * first write is already in flight. An unpersisted session can be discarded
   * without issuing a filesystem delete.
   */
  isUnpersisted(): boolean
  /**
   * Pause new saves and wait for the initial load plus any write already in
   * flight before deletion chooses between local discard and filesystem
   * trash. Returns true when no backing file exists. The caller must finish
   * with {@link NoteSession.discard} on success or
   * {@link NoteSession.cancelDelete} when filesystem deletion fails.
   */
  prepareDelete(): Promise<boolean>
  /** Resume normal persistence after a prepared filesystem deletion fails. */
  cancelDelete(): void
  /**
   * Patch frontmatter keys (e.g. `aliases`, Plan 07b) without touching the
   * editor: the header is updated in place and saved through the normal
   * pipeline. Returns false (and does nothing) when the session can't take
   * the patch — disposed, protected, or not yet `ready`. All three mean the
   * same thing to a caller: this channel is unavailable, use the fallback
   * (the rename coordinator writes straight to disk, which a live session
   * then reconciles like any external change). Throws, changing nothing,
   * when the patch would rewrite what the editor shows as body (a block
   * behind a byte-order mark): taking only the new header would leave the
   * old block, `private` and all, below it.
   */
  updateFrontmatter(patch: FrontmatterPatch): boolean
  /**
   * {@link NoteSession.updateFrontmatter}, but the patch **lands on disk now**
   * regardless of session state. Normally that's a flush; under a parked
   * conflict — where saves are paused and a flush is a deliberate no-op — the
   * contested content is patched and written through too, checked against
   * the parked text so a newer version is refused, so the index sees the
   * change immediately and *both* resolutions keep it ("keep mine" writes
   * the patched header, "load theirs" adopts the patched park). Same gating
   * and false-return as `updateFrontmatter`. For patches that should ride the
   * resolution instead (the rename alias), use `updateFrontmatter`.
   */
  commitFrontmatter(patch: FrontmatterPatch): Promise<boolean>
  /**
   * Append a markdown block to the end of the body (own paragraph, blank-line
   * separated — `appendBlock`) from an out-of-editor action like the
   * suggested-contact card's Add, applied to the live buffer so unsaved edits
   * survive, reflected in the open editor, and flushed now. Same gating,
   * `false`-when-busy, and transactional revert as {@link commitSourceEdit}.
   * A blank block is refused (`false`) — there is nothing to write.
   */
  commitBodyAppend(block: string): Promise<boolean>
  /**
   * Apply a synchronous full-source transform to the live buffer (so unsaved
   * edits survive), reflect it in the open editor, and flush now. The Tasks
   * view routes its edits here whenever the note is open: the buffer is read
   * synchronously, so there is no read/write race with the editor. A session
   * still loading waits for the load, then applies the edit to the loaded
   * buffer. Returns false when the session can't take it (failed to load,
   * protected, disposed, or a parked conflict) so the caller refuses rather
   * than clobber the buffer; an
   * error thrown by `transform` (a stale task locator) propagates untouched,
   * and a failed flush reverts the in-memory edit before rethrowing.
   */
  commitSourceEdit(transform: (source: string) => string): Promise<boolean>
  /** Flush pending edits and detach: no further snapshots are emitted. */
  dispose(): void
  /**
   * Detach **without** flushing — for deleting the note: a final flush (which
   * `dispose` performs) would rewrite the buffer and recreate the file we are
   * removing. After `discard`, a later `dispose` (e.g. on the pane's unmount)
   * is a no-op. Pending saves are cancelled.
   */
  discard(): void
}

/**
 * Creates the document session of each open note.
 */
export interface NoteSessionService {
  /**
   * The save pipeline + external-change reconciliation for one open note
   * (Plan 05 steps 4-5), as a pure state machine.
   */
  create(options: NoteSessionOptions): NoteSession
}
