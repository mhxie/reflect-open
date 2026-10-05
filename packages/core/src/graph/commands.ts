import { z } from 'zod'
import { echoLocalWrite } from '../indexing/local-write-echo.ts'
import { setDisplacedNotesGeneration } from '../indexing/note-displaced.ts'
import { getBridge, type Unlisten } from '../ipc/bridge.ts'
import { call } from '../ipc/invoke.ts'
import { setLocalOnlyFolders } from './local-only.ts'
import {
  fileMetaSchema,
  graphImportProgressSchema,
  graphImportSummarySchema,
  graphInfoSchema,
  noteCreateOutcomeSchema,
  noteDeleteOutcomeSchema,
  noteRecoverySchema,
  pdfInfoSchema,
  recentGraphSchema,
  windowBootstrapSchema,
  type FileMeta,
  type GraphImportProgress,
  type GraphImportSummary,
  type GraphInfo,
  type NoteCreateOutcome,
  type NoteDeleteOutcome,
  type NoteRecovery,
  type PdfInfo,
  type RecentGraph,
  type WindowBootstrap,
} from './schemas.ts'

/** Commands that return `()` from Rust serialize as `null` over IPC. */
const voidSchema = z.null()

/** The graph session whose local-only folders and displacement records this window holds. */
let adoptedGraphGeneration = -Infinity

/**
 * Record a graph session's local-only folders, and which of them are
 * editable, as this window's (see `./local-only.ts`). Generations only grow,
 * so a response for an older session that lands late never replaces a newer
 * graph's names. The predicates are the UI's and a first gate; every path
 * off this machine, and every write into a local-only folder, is also
 * decided by Rust against the graph that serves the bytes.
 */
function adoptGraphSession(info: GraphInfo): void {
  if (info.generation < adoptedGraphGeneration) {
    return
  }
  adoptedGraphGeneration = info.generation
  setLocalOnlyFolders(info.localOnlyFolders, info.localOnlyEditableFolders)
  setDisplacedNotesGeneration(info.generation)
}

/**
 * Open an existing graph at `path` (ensures the standard layout exists) and
 * record its local-only folders as the session's: Rust's graph state
 * switches with this call, so the predicate does too.
 */
export async function openGraph(path: string): Promise<GraphInfo> {
  const info = await call('graph_open', { path }, graphInfoSchema)
  adoptGraphSession(info)
  return info
}

/**
 * Open (or focus) a secondary note window on a `reflect://` route link
 * (⌘-click a note link). Desktop-only; requires an open graph, which the new
 * window adopts — see {@link windowBootstrap}.
 */
export async function openNoteWindow(deepLink: string): Promise<void> {
  await call('open_note_window', { deepLink }, voidSchema)
}

/**
 * Adopt the already-open graph for a secondary note window: a pure read of
 * the current graph + index sessions (never `graph_open`/`index_open`, whose
 * generation bumps would strand the main window's pinned commands) plus the
 * one-shot deep link the window was created for. Errors when no graph is open.
 */
export async function windowBootstrap(): Promise<WindowBootstrap> {
  const boot = await call('window_bootstrap', {}, windowBootstrapSchema)
  adoptGraphSession(boot.graph)
  return boot
}

/**
 * Close every note window and wait (bounded) for their flushes to land.
 * Call BEFORE anything that bumps the graph/index generations (switch,
 * delete): note windows adopted the outgoing session, and a bump-first
 * ordering would reject their final saves as stale.
 */
export async function closeNoteWindows(): Promise<void> {
  await call('close_note_windows', {}, voidSchema)
}

/** Create a new graph at `path` and open it (see {@link openGraph}). */
export async function createGraph(path: string): Promise<GraphInfo> {
  const info = await call('graph_create', { path }, graphInfoSchema)
  adoptGraphSession(info)
  return info
}

/**
 * Import a Reflect V1 export `.zip` into the open graph. V1 exports already use
 * Reflect Open's graph-folder layout; Rust extracts safe entries under the
 * active graph root without ever replacing an existing file (identical files
 * skip, conflicting notes rename, conflicting daily notes merge). Attachments
 * the notes link to on Firebase Storage or Reflect's asset CDN are downloaded
 * into `assets/` and the links rewritten, so the call can take a while on
 * attachment-heavy graphs — observe {@link subscribeImportProgress} and offer
 * {@link cancelReflectV1Import} while it runs.
 */
export async function importReflectV1Zip(
  path: string,
  generation: number,
): Promise<GraphImportSummary> {
  return await call('graph_import_reflect_v1_zip', { path, generation }, graphImportSummarySchema)
}

/** Event name the running import emits {@link GraphImportProgress} ticks on. */
export const IMPORT_PROGRESS_EVENT = 'import:progress'

/** Live progress ticks of the running Reflect V1 import. */
export function subscribeImportProgress(
  handler: (progress: GraphImportProgress) => void,
): Promise<Unlisten> {
  return getBridge().listen(IMPORT_PROGRESS_EVENT, (payload) => {
    const parsed = graphImportProgressSchema.safeParse(payload)
    if (parsed.success) {
      handler(parsed.data)
    } else {
      console.error('invalid import:progress payload:', parsed.error)
    }
  })
}

/**
 * Cancel the running Reflect V1 import (a no-op when none runs). The import
 * aborts before anything lands in the graph, so cancelling is always safe;
 * the pending {@link importReflectV1Zip} call rejects.
 */
export async function cancelReflectV1Import(): Promise<void> {
  await call('graph_import_cancel', {}, voidSchema)
}

/**
 * Mark files imported by {@link importReflectV1Zip} as this device's writes.
 * Call only after the UI confirms the imported graph is still the active graph:
 * these paths are graph-relative and the own-write channel is scoped to the
 * currently running iCloud controller.
 */
export function markReflectV1ImportOwnWrites(summary: GraphImportSummary): void {
  const modifiedMs = Date.now()
  for (const changedPath of summary.changedPaths) {
    echoLocalWrite({ path: changedPath, kind: 'upsert', modifiedMs })
  }
}

/**
 * Read a note's markdown by graph-relative path. `generation`, when given,
 * pins the read to the issuing graph session — background passes that can
 * span a graph switch must pin every read; UI reads of the open graph omit it.
 */
export async function readNote(path: string, generation?: number): Promise<string> {
  return await call('note_read', { path, generation }, z.string())
}

const localNoteReadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('content'),
    content: z.string(),
    // Rust's verdict from the entry the path resolves to, not the spelling.
    // Required: a privacy flag must never default to "shareable".
    localOnly: z.boolean(),
  }),
  z.object({ kind: z.literal('evicted') }),
])

/** How a {@link readNoteLocal} request found the note on disk. */
export type LocalNoteRead = z.infer<typeof localNoteReadSchema>

/**
 * Read a note's markdown **only when its bytes are local**, reporting an
 * iCloud-evicted note as `{ kind: 'evicted' }` instead of reading it. Bulk
 * background passes (the embedding backfill, asset-description gathering)
 * must use this instead of {@link readNote}: reading an evicted note blocks
 * while the OS materializes it on demand, and a whole-graph pass over an
 * evicted iCloud graph becomes thousands of serial blocking downloads.
 * Missing files still reject with `notFound`, exactly like {@link readNote}.
 */
export async function readNoteLocal(path: string, generation?: number): Promise<LocalNoteRead> {
  return await call('note_read_local', { path, generation }, localNoteReadSchema)
}

const shareableNoteReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content'), content: z.string() }),
  z.object({ kind: z.literal('localOnly') }),
])

/** How a {@link readNoteShareable} request found the note. */
export type ShareableNoteRead = z.infer<typeof shareableNoteReadSchema>

/**
 * Read a note bound for somewhere beyond this machine (the AI tools, whose
 * paths are model-supplied). Rust decides whether the note lies in a
 * local-only folder from the entry the path resolves to, so a case-folded or
 * aliased spelling answers `localOnly` exactly like the canonical path, and
 * nothing is read. Only a visible `.md` file is served: a hidden or
 * non-Markdown path rejects with a `traversal` error.
 */
export async function readNoteShareable(
  path: string,
  generation?: number,
): Promise<ShareableNoteRead> {
  return await call('note_read_shareable', { path, generation }, shareableNoteReadSchema)
}

const deviceNoteReadSchema = z.object({ content: z.string(), localOnly: z.boolean() })

/** A visible Markdown read whose local-only status is checked by the native filesystem boundary. */
export type DeviceNoteRead = z.infer<typeof deviceNoteReadSchema>

/** Read visible Markdown for an on-device model, including approved local-only sources. */
export async function readNoteForDevice(
  path: string,
  generation?: number,
): Promise<DeviceNoteRead> {
  return await call('note_read_for_device', { path, generation }, deviceNoteReadSchema)
}

/**
 * Atomically write a note's markdown by graph-relative path. `generation` (from
 * `GraphInfo`) pins the write to the graph it was issued for — Rust rejects it
 * if the graph switched in between.
 *
 * `expectedContents` is the source the write replaces, exactly as it was read;
 * `null` means the file must not exist yet. Rust compares it with the file
 * and refuses a mismatch with an `io` error, leaving the newer bytes in place.
 * There is no unconditional write: a read-modify-write caller goes through
 * `patchNote`, which re-reads and re-applies its patch on a mismatch.
 *
 * The echo carries the file's on-disk mtime, which Rust returns from the
 * write: the index row it produces must compare equal to a later `listFiles`
 * mtime, or the reconcile's read-free skip never fires and the note is
 * re-read on every pass. `Date.now()` is a fallback for a platform that
 * can't report one.
 */
export async function writeNote(
  path: string,
  contents: string,
  generation: number,
  expectedContents: string | null,
): Promise<void> {
  const modifiedMs = await call(
    'note_write',
    { path, contents, generation, checkContents: true, expectedContents },
    z.number().nullable(),
  )
  echoLocalWrite({ path, kind: 'upsert', modifiedMs: modifiedMs ?? Date.now() })
}

/**
 * Atomically create a note only if `path` is still unoccupied. A collision is
 * returned as data and never overwrites the winner, closing the race between a
 * caller's availability check and a concurrent sync checkout or creator.
 */
export async function createNoteIfAbsent(
  path: string,
  contents: string,
  generation: number,
): Promise<NoteCreateOutcome> {
  const outcome = await call('note_create', { path, contents, generation }, noteCreateOutcomeSchema)
  if (outcome.kind === 'created') {
    echoLocalWrite({ path, kind: 'upsert', modifiedMs: outcome.modifiedMs ?? Date.now() })
  }
  return outcome
}

/**
 * Atomically write a binary asset (pasted/dropped image) by graph-relative
 * path. `contentsBase64` is the file's bytes, base64-encoded for the JSON IPC.
 */
export async function writeAsset(
  path: string,
  contentsBase64: string,
  generation: number,
): Promise<void> {
  await call('asset_write', { path, contentsBase64, generation }, voidSchema)
  echoLocalWrite({ path, kind: 'upsert', modifiedMs: Date.now() })
}

/**
 * Read a binary asset's bytes by graph-relative path, base64-encoded (the IPC
 * is JSON). E.g. an audio memo read back for transcription. `generation` pins
 * the read: background passes can span a graph switch, and an unpinned read
 * would resolve against the new graph's same-named file.
 */
export async function readAsset(path: string, generation: number): Promise<string> {
  return await call('asset_read', { path, generation }, z.string())
}

/**
 * {@link readAsset} without the base64 detour: the bytes come back as a raw
 * IPC response. For large reads (a meeting-length audio memo read back for
 * transcription) the base64 route would inflate the payload ~1.33× inside one
 * giant JSON string. Only on binary-capable bridges (see `hasBinaryIpc`).
 */
export async function readAssetBinary(
  path: string,
  generation: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await call('asset_read_binary', { path, generation }, z.instanceof(ArrayBuffer))
  return new Uint8Array(buffer)
}

/** Generation-pinned attachment bytes for verified on-device OCR, including local-only sources. */
export async function readAssetForDevice(
  path: string,
  generation: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await call(
    'asset_read_for_device',
    { path, generation },
    z.instanceof(ArrayBuffer),
  )
  return new Uint8Array(buffer)
}

/** Render a 1-based PDF page to PNG for local vision models (macOS). */
export async function readPdfPageForDevice(
  path: string,
  page: number,
  generation: number,
  sourceHash: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const buffer = await call(
    'pdf_page_read_for_device',
    { path, page, generation, sourceHash },
    z.instanceof(ArrayBuffer),
  )
  return new Uint8Array(buffer)
}

/** Read PDF page metadata from the same verified source snapshot as local OCR. */
export async function pdfInfoForDevice(
  path: string,
  generation: number,
  sourceHash: string,
): Promise<PdfInfo> {
  return await call('pdf_info_for_device', { path, generation, sourceHash }, pdfInfoSchema)
}

const localOcrSupportSchema = z.object({
  /** Safe device-only OCR cache writes (macOS and Linux). */
  cache: z.boolean(),
  /** PDF page rendering for OCR (macOS only). */
  pdf: z.boolean(),
})

/** What local OCR this native platform supports. */
export type LocalOcrSupport = z.infer<typeof localOcrSupportSchema>

/** What local OCR this native platform supports: cache writes, and PDF rendering. */
export async function localOcrSupported(generation: number): Promise<LocalOcrSupport> {
  return await call('asset_ocr_supported', { generation }, localOcrSupportSchema)
}

/** Read a derived OCR cache entry; missing entries throw `notFound`. */
export async function readAssetOcrCache(key: string, generation?: number): Promise<string> {
  return await call('asset_ocr_cache_read', { key, generation }, z.string())
}

/** List derived OCR digest keys in the active graph's runtime cache. */
export async function listAssetOcrCacheKeys(generation: number): Promise<string[]> {
  return await call(
    'asset_ocr_cache_keys',
    { generation },
    z.array(z.string().regex(/^[a-f\d]{64}$/u)),
  )
}

/** Atomically write a complete OCR cache entry into `.reflect/asset-ocr/`. */
export async function writeAssetOcrCache(
  key: string,
  contents: string,
  generation: number,
): Promise<void> {
  await call('asset_ocr_cache_write', { key, contents, generation }, voidSchema)
}

/**
 * Per-segment transcript cache IO (`.reflect/transcripts/<name>`): derived
 * data outside the attachment fence, so it rides its own narrow commands.
 * The read throws `notFound` while nothing is cached.
 */
export async function readTranscriptCache(name: string, generation: number): Promise<string> {
  return await call('transcript_cache_read', { name, generation }, z.string())
}

export async function writeTranscriptCache(
  name: string,
  contents: string,
  generation: number,
): Promise<void> {
  await call('transcript_cache_write', { name, contents, generation }, voidSchema)
}

/**
 * Delete one recording under `audio-memos/` — cancelling a session discards
 * its already-landed segments. Idempotent; scoped in Rust to `audio-memos/`
 * so this can never become a general file-delete IPC.
 */
export async function deleteAudioMemo(path: string, generation: number): Promise<void> {
  await call('audio_memo_delete', { path, generation }, voidSchema)
}

/**
 * Copy a recording from an OS path (the mobile recorder's staging directory)
 * into `audio-memos/` at an exact path. Rust copies file-to-file, so the
 * bytes never enter webview memory. Idempotent: re-importing a segment that
 * already landed is a no-op, which is what makes a re-scan after a failed
 * staged-file delete safe.
 */
export async function importAudioMemo(
  sourcePath: string,
  path: string,
  generation: number,
): Promise<void> {
  await call('audio_memo_import', { sourcePath, path, generation }, voidSchema)
  echoLocalWrite({ path, kind: 'upsert', modifiedMs: Date.now() })
}

/**
 * Open an asset by graph-relative path in the system default application.
 * `generation` pins the request to the graph whose markdown produced the
 * image, so a delayed click after a graph switch cannot open another graph's
 * same-named file.
 */
export async function openAsset(path: string, generation: number): Promise<void> {
  await call('asset_open', { path, generation }, voidSchema)
}

/**
 * Reveal a graph file in the OS file manager, the fallback when
 * {@link openAsset} refuses a file type. Pinned to `generation` for the same
 * reason.
 */
export async function revealAsset(path: string, generation: number): Promise<void> {
  await call('asset_reveal', { path, generation }, voidSchema)
}

/**
 * The page sizes of the PDF at a graph-relative path, for an inline preview
 * (Plan 25). Pinned to `generation` like {@link openAsset}. Rejects with an
 * `unsupported` app error off macOS, `locked` for a password-protected PDF,
 * and `invalid` for a file that is not a readable PDF.
 */
export async function pdfInfo(path: string, generation: number): Promise<PdfInfo> {
  return await call('pdf_info', { path, generation }, pdfInfoSchema)
}

/**
 * List every file (any extension) under a graph-relative directory, e.g.
 * `audio-memos`. A missing directory lists as empty, and files in a
 * local-only folder (or a directory linked into one) are never listed.
 * Pinned to `generation` for the same reason as {@link readAsset}.
 */
export async function listDir(dir: string, generation: number): Promise<FileMeta[]> {
  return await call('dir_list', { dir, generation }, z.array(fileMetaSchema))
}

/**
 * Does a graph-relative path currently exist as a file on disk? Probes the
 * filesystem directly — unlike an index lookup, this can't lag the watcher.
 */
export async function noteExists(path: string): Promise<boolean> {
  return await call('note_exists', { path }, z.boolean())
}

/**
 * Send a note to the trash (recoverable; pinned to `generation`) and report
 * which one took it: the system Trash on desktop, the graph's own
 * `.reflect/trash/` on mobile. A note in an editable local-only folder moves
 * into `.reflect/trash/` first and from there to the system Trash, and stays
 * in `.reflect/trash/` when the system Trash refuses it (`graph`).
 */
export async function deleteNote(path: string, generation: number): Promise<NoteDeleteOutcome> {
  const outcome = await call('note_delete', { path, generation }, noteDeleteOutcomeSchema)
  echoLocalWrite({ path, kind: 'remove' })
  return outcome
}

/**
 * Keep `contents` as this session's unsaved text of the local-only note at `path`
 * in `.reflect/recovery/`, replacing only its own earlier version, for when
 * a save inside a local-only folder cannot land. Rust refuses any other path:
 * a backed-up note's unsaved text has no business outside the note.
 */
export async function writeNoteRecovery(
  path: string,
  contents: string,
  ownerId: string,
  sourceRevision: string | null,
  generation: number,
): Promise<NoteRecovery> {
  return await call(
    'note_recovery_write',
    { path, contents, ownerId, sourceRevision, generation },
    noteRecoverySchema,
  )
}

/** The newest unresolved session copy of the local-only note at `path`, or `null`. */
export async function readNoteRecovery(
  path: string,
  generation: number,
): Promise<NoteRecovery | null> {
  return await call('note_recovery_read', { path, generation }, noteRecoverySchema.nullable())
}

/** Drop the specified session version; missing and newer copies stay untouched. */
export async function clearNoteRecovery(
  path: string,
  ownerId: string,
  token: string,
  generation: number,
): Promise<void> {
  await call('note_recovery_clear', { path, ownerId, token, generation }, voidSchema)
}

/**
 * List eligible Markdown notes at the graph root and in visible nested
 * folders. `generation` pins the listing like {@link readNote}'s.
 */
export async function listFiles(generation?: number): Promise<FileMeta[]> {
  return await call('list_files', { generation }, z.array(fileMetaSchema))
}

/**
 * List supported local attachments anywhere in the vault, from the same
 * cached catalog as {@link listFiles}.
 */
export async function listAttachments(generation?: number): Promise<FileMeta[]> {
  return await call('list_attachments', { generation }, z.array(fileMetaSchema))
}

const vaultScanStatsSchema = z.object({
  notes: z.number(),
  attachments: z.number(),
  skipped: z.number(),
})

export type VaultScanStats = z.infer<typeof vaultScanStatsSchema>

/**
 * Counts from the vault catalog. `skipped` is what the walk refused or failed
 * to list (unreadable directories, symlinks, default-pruned trees) — surfaced
 * so "why isn't my file showing up" stays diagnosable.
 */
export async function vaultScanStats(generation?: number): Promise<VaultScanStats> {
  return await call('vault_scan_stats', { generation }, vaultScanStatsSchema)
}

/**
 * Point the capture host at the active graph (pointer file + inbox dir) and
 * rewrite native-messaging manifests for detected browsers. Called after
 * every graph open — rewriting self-heals app moves (Plan 11).
 */
export async function captureHostRegister(): Promise<void> {
  await call('capture_host_register', {}, voidSchema)
}

/**
 * List the capture inbox (`.reflect/inbox/`): spooled `.json` envelopes and
 * their screenshot siblings. A missing inbox lists as empty. Pinned to
 * `generation` like every background-pass read.
 */
export async function captureInboxList(generation: number): Promise<FileMeta[]> {
  return await call('capture_inbox_list', { generation }, z.array(fileMetaSchema))
}

/** Read one spooled envelope's JSON text by spool filename (e.g. `<id>.json`). */
export async function captureInboxRead(name: string, generation: number): Promise<string> {
  return await call('capture_inbox_read', { name, generation }, z.string())
}

/**
 * Spool an envelope this app produced (deep-link text captures) into the
 * inbox, atomically — it then flows through the same watcher-triggered drain
 * as browser captures. The caller validates the envelope shape; the Rust side
 * only moves bytes (with a defensive size cap).
 */
export async function captureInboxSpool(
  name: string,
  json: string,
  generation: number,
): Promise<void> {
  await call('capture_inbox_spool', { name, json, generation }, voidSchema)
}

/** Remove a spool file by filename. Idempotent — crash re-drains re-remove. */
export async function captureInboxRemove(name: string, generation: number): Promise<void> {
  await call('capture_inbox_remove', { name, generation }, voidSchema)
}

/**
 * Relay envelopes the iOS share extension spooled into the App Group inbox
 * into the graph's capture inbox, returning how many moved. iOS-only in
 * effect (elsewhere there is no shared container and the relay is zero);
 * called by the mobile capture controller before every drain pass.
 */
export async function captureSharedInboxRelay(generation: number): Promise<number> {
  return await call('capture_shared_inbox_relay', { generation }, z.number())
}

/**
 * Quarantine an unparseable spool file into `.reflect/inbox-rejected/` —
 * moved, never deleted: "the raw link is never lost" holds even for an
 * envelope a newer extension wrote that this app version can't read yet.
 */
export async function captureInboxReject(name: string, generation: number): Promise<void> {
  await call('capture_inbox_reject', { name, generation }, voidSchema)
}

/**
 * Copy a spooled screenshot into the graph as a downscaled JPEG asset (the
 * spool file stays until the drain removes it — crash-safe copy semantics).
 */
export async function promoteCaptureScreenshot(
  spoolName: string,
  assetPath: string,
  maxDim: number,
  generation: number,
): Promise<void> {
  await call('capture_screenshot_promote', { spoolName, assetPath, maxDim, generation }, voidSchema)
}

/**
 * Ask the native platform for one representative image for a captured URL.
 * Returns a base64-encoded normalized JPEG, or `null` when unavailable.
 */
export async function captureLinkPreview(url: string): Promise<string | null> {
  return await call('capture_link_preview', { url }, z.string().nullable())
}

/**
 * Fetch a captured page's HTML for meta-tag scraping — the Rust side caps
 * scheme/timeout/size/redirects, so arbitrary capture URLs never widen the
 * webview's own HTTP capability. The privacy gate runs before any call here.
 */
export async function captureMetaFetch(url: string): Promise<string> {
  return await call('capture_meta_fetch', { url }, z.string())
}

/**
 * Fetch an oEmbed endpoint's JSON answer as text. The Rust side only bounds
 * the transport (https only, JSON only, a small byte cap, no redirects);
 * which URLs are oEmbed endpoints is policy in `actions/oembed`. The privacy
 * gate runs before any call here, exactly as for {@link captureMetaFetch}.
 */
export async function captureOEmbedFetch(url: string): Promise<string> {
  return await call('capture_oembed_fetch', { url }, z.string())
}

/** The recently-opened graphs, newest first. */
export async function recentGraphs(): Promise<RecentGraph[]> {
  return await call('recent_graphs', {}, z.array(recentGraphSchema))
}

/** Drop a graph from the recents list (by root path). */
export async function forgetRecent(root: string): Promise<void> {
  await call('forget_recent', { root }, voidSchema)
}

/**
 * Move the open graph's whole directory to the OS trash (recoverable) and
 * drop it from recents. Pinned to `generation` so a delete can never race a
 * graph switch and trash the newly opened graph. Desktop-only.
 */
export async function deleteGraph(generation: number): Promise<void> {
  await call('graph_delete', { generation }, voidSchema)
}
