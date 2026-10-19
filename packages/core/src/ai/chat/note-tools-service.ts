import type { Tool, TypedToolCall, TypedToolResult } from '@reflect/modules/ai'
import { z } from 'zod'
import { readAssetOcrState } from '../../assets/asset-ocr-cache.ts'
import type { AssetPrivacyService } from '../../assets/asset-privacy-service.ts'
import type { DailyNoteRow, DailyNotesRange } from '../../daily/daily-note-service.ts'
import type { XArchiveService } from '../../embeds/x-archive-service.ts'
import type { RetrievalHit } from '../../embeddings/retrieval-hit.ts'
import type { RetrievalService, RetrieveOptions } from '../../embeddings/retrieval-service.ts'
import { ReflectError } from '../../errors.ts'
import type { AssetStoreService } from '../../graph/asset-store-service.ts'
import { isLocalOnlyPath, type LocalOnlyFolders } from '../../graph/local-only.ts'
import type { NoteFileService } from '../../graph/note-file-service.ts'
import type { AssetReferences } from '../../indexing/asset-refs.ts'
import type { NoteListService, RecentNoteRow } from '../../indexing/note-list-service.ts'
import { isTagName } from '../../markdown/extract.ts'
import {
  localSafeNoteListing,
  localSafeSearchHit,
  type LocalSafe,
} from '../../privacy/local-checkers.ts'
import type { VerifiedModelTarget, VerifiedOnDeviceTarget } from '../../privacy/on-device.ts'
import {
  notePrivate,
  PrivateNoteError,
  type CloudNoteListing,
  type CloudSafe,
  type CloudSearchHit,
  type CloudSendable,
  type PrivacyService,
} from '../../privacy/privacy-service.ts'
import type { ChatPrivacyService } from './chat-privacy-service.ts'
import { buildReadOneAsset, readAssetsInput, type ReadAssetsOutput } from './read-assets.ts'
import { buildReadOneNote, readNotesInput, type ReadNotesOutput } from './read-notes.ts'
import type { SearchSnapshot } from './tool-result-sources.ts'

/**
 * The read-only note tools the chat model can call (Plan 10, first wave),
 * and — deliberately in the same module — everything else that knows their
 * names: the {@link NoteToolCall}/{@link NoteToolResult} unions the engine
 * streams and the UI renders, and the mappers from SDK stream parts onto
 * them. Adding a tool means registering it here (batch executors live in
 * sibling `read-*.ts` modules), naming its sources (`./tool-result-sources`),
 * and extending the chip that renders it; nothing else switches on tool names.
 *
 * Note content enters tool outputs only as {@link CloudSafe} values, minted
 * by the injected `PrivacyService` — search drops private hits entirely, and
 * reads re-check the live frontmatter before any content is minted. Tools
 * bound to a verified on-device model read private and local-only notes too,
 * minted as {@link LocalSafe} values that carry their private provenance.
 */

/**
 * Default and ceiling for search hits per call (token budget, not recall).
 */
const DEFAULT_SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 20

/**
 * Default and ceiling for recent-note listings per call.
 */
const DEFAULT_RECENT_LIMIT = 10
const MAX_RECENT_LIMIT = 20

/**
 * Most days one daily-range call returns; past it the model narrows the range.
 */
export const MAX_DAILY_NOTE_DAYS = 31

/**
 * What {@link NoteToolsService.build} takes.
 */
export interface BuildNoteToolsOptions {
  /**
   * Whether note search can use embeddings for meaning-based recall. When
   * false, `search_notes` stays lexical so disabled semantic search is honored.
   */
  semanticSearchEnabled: boolean
  /**
   * The file generation of the graph session the tools read from.
   */
  generation: number
  /**
   * The local-only folders of that graph.
   */
  localOnly: LocalOnlyFolders
  /**
   * The verified destination of the model the tools serve: a cloud model
   * reads only what the privacy gate clears, a verified on-device model
   * reads every note of the graph.
   */
  target: VerifiedModelTarget
}

export interface SearchNotesOutput {
  hits: Array<CloudSafe<CloudSearchHit> | LocalSafe<CloudSearchHit>>
}

/**
 * A listing, or a corrective refusal for a `tag` the tag grammar can never
 * produce. Without the refusal a junk filter (`*`, `all`, whitespace…) reads
 * as a clean "0 notes" — indistinguishable from a real tag nothing carries —
 * and a model hunting for an "all notes" sentinel just keeps guessing.
 */
export type ListRecentNotesOutput =
  | { ok: true; notes: Array<CloudSafe<CloudNoteListing> | LocalSafe<CloudNoteListing>> }
  | { ok: false; tag: string; error: string }

/**
 * The refusal text — one string, read verbatim by both model and chip.
 */
export const INVALID_TAG_ERROR =
  'Not a tag — omit the tag to list all recent notes. Tags are single words like "book" or "project/atlas".'

export interface ListDailyNotesOutput {
  days: Array<CloudSafe<CloudNoteListing> | LocalSafe<CloudNoteListing>>
  /**
   * The range held more days than one call returns — narrow it to see the rest.
   */
  truncated: boolean
}

export const searchNotesInput = z.object({
  query: z.string().min(1).describe('Full-text search query over the note graph'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .optional()
    .describe(`How many notes to return (default ${DEFAULT_SEARCH_LIMIT})`),
})

export const listRecentNotesInput = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_RECENT_LIMIT)
    .optional()
    .describe(`How many notes to return (default ${DEFAULT_RECENT_LIMIT})`),
  tag: z
    .string()
    .nullish()
    .describe(
      'Only notes carrying this tag (case-insensitive, without the #). ' +
        'Omit, or pass null, to list all recent notes.',
    ),
})

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'an ISO date, YYYY-MM-DD')

export const listDailyNotesInput = z.object({
  start: isoDate.describe('First day of the range, inclusive (YYYY-MM-DD)'),
  end: isoDate.describe('Last day of the range, inclusive (YYYY-MM-DD)'),
})

/**
 * Shape one query row for the listings gate (epoch mtime → ISO timestamp).
 */
function listingCandidate(
  row: RecentNoteRow | DailyNoteRow,
): CloudSendable & Omit<CloudNoteListing, 'path'> {
  return {
    path: row.path,
    isPrivate: row.isPrivate,
    title: row.title,
    dailyDate: 'dailyDate' in row ? row.dailyDate : null,
    snippet: row.preview,
    modifiedAt: new Date(row.mtime).toISOString(),
  }
}

/**
 * The read-only tools the chat model can call, with the privacy gate inside.
 */
export interface NoteToolsService {
  /**
   * Build the tool set of one chat turn, bound to the turn's verified target.
   */
  build(options: BuildNoteToolsOptions): NoteTools
}

/**
 * The daily-note range query of `DailyNoteService`.
 */
export interface DailyNoteQueries {
  listDailyNotes(range: DailyNotesRange): Promise<DailyNoteRow[]>
}

export interface NoteToolsServiceDeps {
  readonly retrieval: RetrievalService
  readonly noteFile: NoteFileService
  readonly assetStore: AssetStoreService
  readonly noteList: NoteListService
  readonly dailyNotes: DailyNoteQueries
  readonly assetReferences: AssetReferences
  readonly assetPrivacy: AssetPrivacyService
  readonly xArchive: XArchiveService
  readonly privacy: PrivacyService
  readonly chatPrivacy: ChatPrivacyService
}

class NoteToolsServiceImpl implements NoteToolsService {
  readonly #deps: NoteToolsServiceDeps

  constructor(deps: NoteToolsServiceDeps) {
    this.#deps = deps
  }

  build(options: BuildNoteToolsOptions): NoteTools {
    const {
      retrieval,
      noteList,
      dailyNotes,
      privacy,
      chatPrivacy,
      noteFile,
      assetStore,
      assetReferences,
      assetPrivacy,
      xArchive,
    } = this.#deps
    const { generation, localOnly, target } = options
    const onDevice: VerifiedOnDeviceTarget | null = target.kind === 'on-device' ? target : null
    const readDeviceNote = async (path: string) => await noteFile.readForDevice(path, generation)
    // The tier's reader of notes and sidecars. Rust decides local-only status
    // by the entry a path resolves to, not its spelling: the cloud tier's
    // shareable read refuses such a note with a `PrivateNoteError`, which
    // every tool already treats as private; the on-device read reports it.
    const readNote =
      onDevice !== null
        ? async (path: string): Promise<string> => {
            const read = await readDeviceNote(path)
            if (read.localOnly) {
              throw new ReflectError('auth', 'Search source is local-only.')
            }
            return read.content
          }
        : async (path: string): Promise<string> => {
            const read = await noteFile.readShareable(path, generation)
            if (read.kind === 'localOnly') {
              throw new PrivateNoteError(path)
            }
            return read.content
          }

    // Only a search hit can carry attachment text (listings show the note's
    // own preview), so only a hit's snapshot has its attachments rechecked.
    const restrictedSources = async (
      path: string,
      source: string,
      snapshot: Pick<SearchSnapshot, 'assetTextHash'> | null,
    ): Promise<boolean> => {
      if (
        snapshot === null ||
        !(await chatPrivacy.snapshotHasAttachmentText(snapshot.assetTextHash))
      ) {
        return false
      }
      return await chatPrivacy.hasRestrictedSearchSources(path, source, {
        readNote,
        generation,
        localOnly,
        expectedAssetTextHash: snapshot.assetTextHash,
      })
    }

    // The on-device tier's live provenance probe: the index flag can lag a
    // just-saved `private: true`, so each candidate is re-read from disk.
    // A local-only note is private by its path; one that can't be read counts
    // as private too. The cloud tier's probe is the privacy gate's own.
    const isPrivateLive = async (
      path: string,
      snapshot: Pick<SearchSnapshot, 'assetTextHash'> | null = null,
    ): Promise<boolean> => {
      if (isLocalOnlyPath(localOnly, path)) {
        return true
      }
      try {
        const read = await readDeviceNote(path)
        return (
          read.localOnly ||
          notePrivate(read.content) ||
          (await restrictedSources(path, read.content, snapshot))
        )
      } catch {
        return true
      }
    }

    const readOneNote = buildReadOneNote({ readNote, readDeviceNote, privacy, target, localOnly })
    const readOneAsset = buildReadOneAsset({
      readNote,
      readDeviceNote,
      listAttachments: () => noteFile.listAttachments(generation),
      readOcrState: (assetPath) => readAssetOcrState(assetStore, assetPath, generation),
      assetReferences,
      assetPrivacy,
      xArchive,
      privacy,
      target,
      localOnly,
    })
    const searchMode: RetrieveOptions['mode'] = options.semanticSearchEnabled ? 'hybrid' : 'lexical'
    const privacyDescription =
      onDevice !== null
        ? 'Includes private and local-only notes; this tool is bound to a verified model on this Mac.'
        : 'Private notes are excluded.'

    const listings = async (
      rows: ReadonlyArray<RecentNoteRow | DailyNoteRow>,
    ): Promise<Array<CloudSafe<CloudNoteListing> | LocalSafe<CloudNoteListing>>> => {
      const entries = rows.map(listingCandidate)
      if (onDevice === null) {
        return await privacy.cloudSafeNoteListings(entries)
      }
      return await Promise.all(
        entries.map(async (entry) =>
          localSafeNoteListing(localOnly, onDevice, {
            ...entry,
            isPrivate: entry.isPrivate || (await isPrivateLive(entry.path)),
          }),
        ),
      )
    }

    const searchHits = async (
      hits: readonly RetrievalHit[],
    ): Promise<Array<CloudSafe<CloudSearchHit> | LocalSafe<CloudSearchHit>>> => {
      if (onDevice === null) {
        return await privacy.cloudSafeSearchHits(hits, (hit, source) =>
          restrictedSources(hit.path, source, hit),
        )
      }
      return await Promise.all(
        hits.map(async (hit) =>
          localSafeSearchHit(localOnly, onDevice, {
            ...hit,
            isPrivate: hit.isPrivate || (await isPrivateLive(hit.path, hit)),
          }),
        ),
      )
    }

    return {
      search_notes: {
        description: searchNotesDescription(options.semanticSearchEnabled, privacyDescription),
        inputSchema: searchNotesInput,
        execute: async ({ query, limit }): Promise<SearchNotesOutput> => {
          const hits = await retrieval.retrieve(query, {
            limit: limit ?? DEFAULT_SEARCH_LIMIT,
            mode: searchMode,
            excludePrivateContent: onDevice === null,
          })
          return { hits: await searchHits(hits) }
        },
      },

      list_recent_notes: {
        description:
          'List the most recently edited notes, newest first — call it with no tag to see ' +
          'what the user wrote or worked on lately. Pass a tag only to narrow to notes ' +
          'carrying it. Daily notes are not included — use list_daily_notes for those. ' +
          privacyDescription,
        inputSchema: listRecentNotesInput,
        execute: async ({ limit, tag }): Promise<ListRecentNotesOutput> => {
          if (tag != null && !isTagName(tag)) {
            return { ok: false, tag, error: INVALID_TAG_ERROR }
          }
          const rows = await noteList.listRecentNotes({
            limit: limit ?? DEFAULT_RECENT_LIMIT,
            tag: tag ?? null,
            ...(onDevice !== null ? { includePrivate: true } : {}),
          })
          return { ok: true, notes: await listings(rows) }
        },
      },

      list_daily_notes: {
        description:
          'List the daily notes (the user’s journal, one note per day) in an inclusive date ' +
          'range, most recent first. Only days the user wrote on appear. Returns at most ' +
          `${MAX_DAILY_NOTE_DAYS} days — when truncated, narrow the range. ` +
          privacyDescription,
        inputSchema: listDailyNotesInput,
        execute: async ({ start, end }): Promise<ListDailyNotesOutput> => {
          const rows = await dailyNotes.listDailyNotes({
            start,
            end,
            limit: MAX_DAILY_NOTE_DAYS + 1,
            ...(onDevice !== null ? { includePrivate: true } : {}),
          })
          const truncated = rows.length > MAX_DAILY_NOTE_DAYS
          const kept = truncated ? rows.slice(0, MAX_DAILY_NOTE_DAYS) : rows
          return { days: await listings(kept), truncated }
        },
      },

      read_notes: {
        description:
          'Read the full markdown content of one or more notes by their graph-relative ' +
          'paths (from search_notes results). Pass every note you need in a single call ' +
          `rather than reading them one at a time. ${privacyDescription}`,
        inputSchema: readNotesInput,
        execute: async ({ paths }): Promise<ReadNotesOutput> => {
          return { notes: await Promise.all(paths.map(readOneNote)) }
        },
      },

      read_assets: {
        description:
          'Read the stored text description and OCR transcription of image or PDF ' +
          'attachments that notes embed as assets/… markdown links, e.g. ' +
          '![sketch](assets/sketch.png). Returns descriptive text about each file, not ' +
          'the file itself. Pass every attachment you need in a single call. ' +
          (onDevice !== null
            ? 'Includes private attachments and on-device OCR text.'
            : 'Attachments of private notes cannot be read.'),
        inputSchema: readAssetsInput,
        execute: async ({ paths }): Promise<ReadAssetsOutput> => {
          return { assets: await Promise.all(paths.map(readOneAsset)) }
        },
      },
    }
  }
}

export function createNoteToolsService(deps: NoteToolsServiceDeps): NoteToolsService {
  return new NoteToolsServiceImpl(deps)
}

/**
 * Tool description for the active search mode and tier.
 */
function searchNotesDescription(
  semanticSearchEnabled: boolean,
  privacyDescription: string,
): string {
  const suffix = `Returns the best-matching notes with short snippets. Queries are plain language — there is no wildcard or operator syntax. ${privacyDescription}`
  if (semanticSearchEnabled) {
    return `Search the user’s notes by meaning and keywords. ${suffix}`
  }
  return `Search the user’s notes with lexical full-text search over titles and note bodies. ${suffix}`
}

/**
 * The tool set type, for typed stream parts in the chat engine. Written out
 * (rather than inferred from {@link NoteToolsService.build}) so the declaration the
 * composite build emits only names types this package can import.
 */
export type NoteTools = {
  search_notes: Tool<z.infer<typeof searchNotesInput>, SearchNotesOutput>
  list_recent_notes: Tool<z.infer<typeof listRecentNotesInput>, ListRecentNotesOutput>
  list_daily_notes: Tool<z.infer<typeof listDailyNotesInput>, ListDailyNotesOutput>
  read_notes: Tool<z.infer<typeof readNotesInput>, ReadNotesOutput>
  read_assets: Tool<z.infer<typeof readAssetsInput>, ReadAssetsOutput>
}

/**
 * The hit slice tool-activity UI renders (full hits stay engine-side).
 */
export type NoteHitSummary = Pick<CloudSearchHit, 'path' | 'title'>

/**
 * One note's outcome in a read_notes call, for the tool-activity UI.
 */
export interface ReadNoteSummary {
  path: string
  title: string | null
  /**
   * The per-note refusal/miss text, or `null` when the read succeeded.
   */
  error: string | null
}

/**
 * One asset's outcome in a read_assets call, for the tool-activity UI.
 */
export interface ReadAssetSummary {
  path: string
  /**
   * The per-asset refusal/miss text, or `null` when the read succeeded.
   */
  error: string | null
}

/**
 * One tool invocation, as the transcript sees it.
 */
export type NoteToolCall =
  | { tool: 'search'; toolCallId: string; query: string }
  | { tool: 'read'; toolCallId: string; paths: string[] }
  | { tool: 'assets'; toolCallId: string; paths: string[] }
  | { tool: 'recents'; toolCallId: string; tag: string | null }
  | { tool: 'dailies'; toolCallId: string; start: string; end: string }

/**
 * One settled tool invocation. A failed read or listing keeps its refusal.
 */
export type NoteToolResult =
  | { tool: 'search'; toolCallId: string; query: string; hits: NoteHitSummary[] }
  | { tool: 'read'; toolCallId: string; notes: ReadNoteSummary[] }
  | { tool: 'assets'; toolCallId: string; assets: ReadAssetSummary[] }
  | {
      tool: 'recents'
      toolCallId: string
      tag: string | null
      notes: NoteHitSummary[]
      error: string | null
    }
  | { tool: 'dailies'; toolCallId: string; start: string; end: string; days: NoteHitSummary[] }

/**
 * Map an SDK tool-call part onto {@link NoteToolCall} (null for dynamic).
 */
export function noteToolCall(part: TypedToolCall<NoteTools>): NoteToolCall | null {
  if (part.dynamic) {
    return null
  }
  switch (part.toolName) {
    case 'search_notes':
      return { tool: 'search', toolCallId: part.toolCallId, query: part.input.query }
    case 'read_notes':
      return { tool: 'read', toolCallId: part.toolCallId, paths: part.input.paths }
    case 'read_assets':
      return { tool: 'assets', toolCallId: part.toolCallId, paths: part.input.paths }
    case 'list_recent_notes':
      return { tool: 'recents', toolCallId: part.toolCallId, tag: part.input.tag ?? null }
    case 'list_daily_notes':
      return {
        tool: 'dailies',
        toolCallId: part.toolCallId,
        start: part.input.start,
        end: part.input.end,
      }
  }
}

/**
 * The path+title slice of one listing, for the tool-activity UI.
 */
function listingSummary(entry: CloudNoteListing): NoteHitSummary {
  return { path: entry.path, title: entry.title }
}

/**
 * Map an SDK tool-result part onto {@link NoteToolResult} (null for dynamic).
 */
export function noteToolResult(part: TypedToolResult<NoteTools>): NoteToolResult | null {
  if (part.dynamic) {
    return null
  }
  switch (part.toolName) {
    case 'search_notes':
      return {
        tool: 'search',
        toolCallId: part.toolCallId,
        query: part.input.query,
        hits: part.output.hits.map((hit) => ({ path: hit.path, title: hit.title })),
      }
    case 'read_notes':
      return {
        tool: 'read',
        toolCallId: part.toolCallId,
        notes: part.output.notes.map((entry) =>
          entry.ok
            ? { path: entry.note.path, title: entry.note.title, error: null }
            : { path: entry.path, title: null, error: entry.error },
        ),
      }
    case 'read_assets':
      return {
        tool: 'assets',
        toolCallId: part.toolCallId,
        assets: part.output.assets.map((entry) =>
          entry.ok
            ? { path: entry.asset.path, error: null }
            : { path: entry.path, error: entry.error },
        ),
      }
    case 'list_recent_notes': {
      const output = part.output
      return output.ok
        ? {
            tool: 'recents',
            toolCallId: part.toolCallId,
            tag: part.input.tag ?? null,
            notes: output.notes.map(listingSummary),
            error: null,
          }
        : {
            tool: 'recents',
            toolCallId: part.toolCallId,
            tag: output.tag,
            notes: [],
            error: output.error,
          }
    }
    case 'list_daily_notes':
      return {
        tool: 'dailies',
        toolCallId: part.toolCallId,
        start: part.input.start,
        end: part.input.end,
        days: part.output.days.map(listingSummary),
      }
  }
}
