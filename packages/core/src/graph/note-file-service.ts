import { z } from 'zod'
import type { ClockService } from '../ports/clock-service.ts'
import type { FileChangeService } from '../indexing/file-change-service.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import {
  fileMetaSchema,
  noteCreateOutcomeSchema,
  noteDeleteOutcomeSchema,
  noteRecoverySchema,
  type FileMeta,
  type NoteCreateOutcome,
  type NoteDeleteOutcome,
  type NoteRecovery,
} from './schemas.ts'

/**

 * Commands that return `()` from Rust serialize as `null` over IPC.

 */
const voidSchema = z.null()

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

/**

 * How a {@link NoteFileService.readLocal} request found the note on disk.

 */
export type LocalNoteRead = z.infer<typeof localNoteReadSchema>

const shareableNoteReadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('content'), content: z.string() }),
  z.object({ kind: z.literal('localOnly') }),
])

/**
 * How a {@link NoteFileService.readShareable} request found the note.
 */
export type ShareableNoteRead = z.infer<typeof shareableNoteReadSchema>

const deviceNoteReadSchema = z.object({ content: z.string(), localOnly: z.boolean() })

/**
 * A visible Markdown read whose local-only status is checked by the native
 * filesystem boundary ({@link NoteFileService.readForDevice}).
 */
export type DeviceNoteRead = z.infer<typeof deviceNoteReadSchema>

const vaultScanStatsSchema = z.object({
  notes: z.number(),
  attachments: z.number(),
  skipped: z.number(),
})

export type VaultScanStats = z.infer<typeof vaultScanStatsSchema>

const noteWriteOutcomeSchema = z.object({
  modifiedMs: z.number().nullable(),
  merged: z.string().nullable(),
})

/**
 * The outcome of {@link NoteFileService.write}.
 */
export interface NoteWriteResult {
  /**
   * The full text now on disk when the write merged with a newer disk text, else `null`.
   */
  merged: string | null
}

/**
 * Markdown notes by graph-relative path. Every write, create and delete is
 * reported to {@link FileChangeService.reportOwnWrite} after it lands.
 */
export interface NoteFileService {
  /**
   * A note's markdown, pinned to the issuing graph session's `generation`.
   */
  read(path: string, generation: number): Promise<string>
  /**
   * A note's markdown only when its bytes are local: an iCloud-evicted note
   * reports `evicted` instead of being downloaded. A missing file still
   * rejects with `notFound`. The content carries Rust's local-only verdict
   * for the entry the path resolves to. `sharing` marks bytes about to leave
   * the device (the cloud summary engine): the read then refuses while
   * sharing is paused, as {@link readShareable} does.
   */
  readLocal(
    path: string,
    generation: number,
    options?: { readonly sharing?: boolean },
  ): Promise<LocalNoteRead>
  /**
   * Read a note bound for somewhere beyond this machine (the AI tools, whose
   * paths are model-supplied). Rust decides whether the note lies in a
   * local-only folder from the entry the path resolves to, so a case-folded
   * or aliased spelling answers `localOnly` exactly like the canonical path,
   * and nothing is read. Only a visible `.md` file is served: a hidden or
   * non-Markdown path rejects with a `traversal` error.
   */
  readShareable(path: string, generation: number): Promise<ShareableNoteRead>
  /**
   * Read visible Markdown for an on-device model, including approved
   * local-only sources.
   */
  readForDevice(path: string, generation: number): Promise<DeviceNoteRead>
  /**
   * Write a note atomically, pinned to `generation`. Every write is checked:
   * `expectedContents` is the source the write replaces, exactly as it was
   * read, and `null` means the file must not exist yet. A note whose disk
   * text moved past `expectedContents` is merged with it (see
   * {@link NoteWriteResult.merged}); a file that appeared where `null` was
   * named, or vanished where a revision was, is refused with an `io` error.
   * There is no unconditional write.
   */
  write(
    path: string,
    contents: string,
    generation: number,
    expectedContents: string | null,
  ): Promise<NoteWriteResult>
  /**
   * {@link write} for a change that is not an edit (the background AI
   * summary's frontmatter block): the file keeps its modification time, so
   * the note neither jumps to the top of the recency-sorted lists nor reads
   * as "Updated just now". The note must exist and still hold
   * `expectedContents`; a note in a local-only folder is refused
   * (`unsupported`). The own-write report asks the index to re-read the note
   * on every platform: with the time unchanged, the watcher's report of this
   * write reads as already indexed.
   */
  writeKeepingModified(
    path: string,
    contents: string,
    generation: number,
    expectedContents: string,
  ): Promise<void>
  /**
   * Create a note only when `path` is free. A collision is returned, never overwritten.
   */
  create(path: string, contents: string, generation: number): Promise<NoteCreateOutcome>
  /**
   * Whether a file exists at `path` on disk right now.
   */
  exists(path: string): Promise<boolean>
  /**
   * Send a note to the trash and report which one took it: the system Trash
   * on desktop, the graph's own `.reflect/trash/` on mobile. A note in an
   * editable local-only folder moves into `.reflect/trash/` first and from
   * there to the system Trash, and stays in `.reflect/trash/` when the
   * system Trash refuses it (`graph`).
   */
  delete(path: string, generation: number): Promise<NoteDeleteOutcome>
  /**
   * Keep `contents` as this session's unsaved text of the local-only note at
   * `path` in `.reflect/recovery/`, replacing only its own earlier version,
   * for when a save inside a local-only folder cannot land. Rust refuses any
   * other path: a backed-up note's unsaved text has no business outside the
   * note.
   */
  writeRecovery(
    path: string,
    contents: string,
    ownerId: string,
    sourceRevision: string | null,
    generation: number,
  ): Promise<NoteRecovery>
  /**
   * The newest unresolved session copy of the local-only note at `path`, or `null`.
   */
  readRecovery(path: string, generation: number): Promise<NoteRecovery | null>
  /**
   * Drop the specified session version; missing and newer copies stay untouched.
   */
  clearRecovery(path: string, ownerId: string, token: string, generation: number): Promise<void>
  /**
   * Every eligible Markdown note in the graph.
   */
  listNotes(generation: number): Promise<FileMeta[]>
  /**
   * Every supported local attachment in the graph.
   */
  listAttachments(generation: number): Promise<FileMeta[]>
  /**
   * Every file under a graph-relative directory. A missing directory lists as
   * empty, and files in a local-only folder (or a directory linked into one)
   * are never listed.
   */
  listDir(dir: string, generation: number): Promise<FileMeta[]>
  /**
   * Counts from the vault catalog, including what the walk skipped.
   */
  vaultScanStats(generation: number): Promise<VaultScanStats>
}

export interface NoteFileServiceDeps {
  readonly ipc: IpcBridgeService
  readonly clock: ClockService
  readonly fileChanges: FileChangeService
}

class NoteFileServiceImpl implements NoteFileService {
  readonly #deps: NoteFileServiceDeps

  constructor(deps: NoteFileServiceDeps) {
    this.#deps = deps
  }

  async read(path: string, generation: number): Promise<string> {
    return await this.#deps.ipc.call('note_read', { path, generation }, z.string())
  }

  async readLocal(
    path: string,
    generation: number,
    options: { readonly sharing?: boolean } = {},
  ): Promise<LocalNoteRead> {
    return await this.#deps.ipc.call(
      'note_read_local',
      { path, generation, sharing: options.sharing },
      localNoteReadSchema,
    )
  }

  async readShareable(path: string, generation: number): Promise<ShareableNoteRead> {
    return await this.#deps.ipc.call(
      'note_read_shareable',
      { path, generation },
      shareableNoteReadSchema,
    )
  }

  async readForDevice(path: string, generation: number): Promise<DeviceNoteRead> {
    return await this.#deps.ipc.call(
      'note_read_for_device',
      { path, generation },
      deviceNoteReadSchema,
    )
  }

  async write(
    path: string,
    contents: string,
    generation: number,
    expectedContents: string | null,
  ): Promise<NoteWriteResult> {
    const { ipc, clock, fileChanges } = this.#deps
    const outcome = await ipc.call(
      'note_write',
      { path, contents, generation, checkContents: true, expectedContents },
      noteWriteOutcomeSchema,
    )
    const modifiedMs = outcome.modifiedMs ?? clock.now()
    fileChanges.reportOwnWrite([{ path, kind: 'upsert', modifiedMs }])
    return { merged: outcome.merged }
  }

  async writeKeepingModified(
    path: string,
    contents: string,
    generation: number,
    expectedContents: string,
  ): Promise<void> {
    const { ipc, fileChanges } = this.#deps
    const modifiedMs = await ipc.call(
      'note_write_keep_modified',
      { path, contents, generation, expectedContents },
      z.number().nullable(),
    )
    fileChanges.reportOwnWrite([
      { path, kind: 'upsert', reread: true, ...(modifiedMs === null ? {} : { modifiedMs }) },
    ])
  }

  async create(path: string, contents: string, generation: number): Promise<NoteCreateOutcome> {
    const { ipc, clock, fileChanges } = this.#deps
    const outcome = await ipc.call(
      'note_create',
      { path, contents, generation },
      noteCreateOutcomeSchema,
    )
    if (outcome.kind === 'created') {
      fileChanges.reportOwnWrite([
        { path, kind: 'upsert', modifiedMs: outcome.modifiedMs ?? clock.now() },
      ])
    }
    return outcome
  }

  async exists(path: string): Promise<boolean> {
    return await this.#deps.ipc.call('note_exists', { path }, z.boolean())
  }

  async delete(path: string, generation: number): Promise<NoteDeleteOutcome> {
    const outcome = await this.#deps.ipc.call(
      'note_delete',
      { path, generation },
      noteDeleteOutcomeSchema,
    )
    this.#deps.fileChanges.reportOwnWrite([{ path, kind: 'remove' }])
    return outcome
  }

  async writeRecovery(
    path: string,
    contents: string,
    ownerId: string,
    sourceRevision: string | null,
    generation: number,
  ): Promise<NoteRecovery> {
    return await this.#deps.ipc.call(
      'note_recovery_write',
      { path, contents, ownerId, sourceRevision, generation },
      noteRecoverySchema,
    )
  }

  async readRecovery(path: string, generation: number): Promise<NoteRecovery | null> {
    return await this.#deps.ipc.call(
      'note_recovery_read',
      { path, generation },
      noteRecoverySchema.nullable(),
    )
  }

  async clearRecovery(
    path: string,
    ownerId: string,
    token: string,
    generation: number,
  ): Promise<void> {
    await this.#deps.ipc.call(
      'note_recovery_clear',
      { path, ownerId, token, generation },
      voidSchema,
    )
  }

  async listNotes(generation: number): Promise<FileMeta[]> {
    return await this.#deps.ipc.call('list_files', { generation }, z.array(fileMetaSchema))
  }

  async listAttachments(generation: number): Promise<FileMeta[]> {
    return await this.#deps.ipc.call('list_attachments', { generation }, z.array(fileMetaSchema))
  }

  async listDir(dir: string, generation: number): Promise<FileMeta[]> {
    return await this.#deps.ipc.call('dir_list', { dir, generation }, z.array(fileMetaSchema))
  }

  async vaultScanStats(generation: number): Promise<VaultScanStats> {
    return await this.#deps.ipc.call('vault_scan_stats', { generation }, vaultScanStatsSchema)
  }
}

export function createNoteFileService(deps: NoteFileServiceDeps): NoteFileService {
  return new NoteFileServiceImpl(deps)
}
