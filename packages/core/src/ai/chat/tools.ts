import type { Tool, TypedToolCall, TypedToolResult } from '@reflect/modules/ai'
import { isNotNullish } from '@ocavue/utils'
import { z } from 'zod'
import { isLocalOnlyPath } from '../../graph/local-only.ts'
import { readNoteForDevice, type DeviceNoteRead } from '../../graph/commands.ts'
import { retrieve, type RetrievalHit, type RetrieveOptions } from '../../embeddings/retrieve.ts'
import { assetReferencingNotePaths } from '../../indexing/asset-refs.ts'
import { listDailyNotes, type DailyNoteRow, type DailyNotesRange } from '../../indexing/queries.ts'
import {
  listRecentNotes,
  type RecentNoteRow,
  type RecentNotesOptions,
} from '../../indexing/note-list.ts'
import { isTagName } from '../../markdown/extract.ts'
import { buildReadOneAsset, readAssetsInput, type ReadAssetsOutput } from './read-assets.ts'
import {
  buildReadOneNote,
  readNotesInput,
  readShareableNote,
  type ReadNotesOutput,
} from './read-notes.ts'
import {
  cloudSafeNoteListings,
  cloudSafeSearchHits,
  notePrivate,
  type CloudNoteListing,
  type CloudSafe,
  type CloudSearchHit,
  type CloudSendable,
} from '../../privacy/checkers.ts'
import {
  localSafeNoteListing,
  localSafeSearchHit,
  type LocalSafe,
} from '../../privacy/local-checkers.ts'
import type { VerifiedModelTarget } from '../../privacy/on-device.ts'
import { hasRestrictedSearchSources, snapshotHasAttachmentText } from './search-privacy.ts'
import { ReflectError } from '../../errors.ts'

/**
 * The read-only note tools the chat model can call (Plan 10, first wave),
 * and — deliberately in the same module — everything else that knows their
 * names: the {@link NoteToolCall}/{@link NoteToolResult} unions the engine
 * streams and the UI renders, and the mappers from SDK stream parts onto
 * them, and the parser that names what a stored result read
 * ({@link toolResultSources}). Adding a tool means registering it here (batch
 * executors live in sibling `read-*.ts` modules), naming its sources, and
 * extending the chip that renders it; nothing else switches on tool names.
 *
 * Note content enters tool outputs only as {@link CloudSafe} values, minted
 * by the privacy gate in `../../privacy/checkers` — search drops private hits entirely,
 * and reads re-check the live frontmatter before any content is minted.
 */

/** Default and ceiling for search hits per call (token budget, not recall). */
const DEFAULT_SEARCH_LIMIT = 8
const MAX_SEARCH_LIMIT = 20

/** Default and ceiling for recent-note listings per call. */
const DEFAULT_RECENT_LIMIT = 10
const MAX_RECENT_LIMIT = 20

/** Most days one daily-range call returns; past it the model narrows the range. */
export const MAX_DAILY_NOTE_DAYS = 31

/** Injectable effects so tests can drive the tools without a live bridge. */
export interface NoteToolDeps {
  retrieveFn?: (query: string, options?: RetrieveOptions) => Promise<RetrievalHit[]>
  readNoteFn?: (path: string) => Promise<string>
  readDeviceNoteFn?: (path: string, generation?: number) => Promise<DeviceNoteRead>
  /** Test seam for attachment provenance; production also checks indexed references. */
  hasRestrictedSearchSourcesFn?: (
    path: string,
    source: string,
    assetTextHash?: string,
  ) => Promise<boolean>
  listRecentNotesFn?: (options: RecentNotesOptions) => Promise<RecentNoteRow[]>
  listDailyNotesFn?: (range: DailyNotesRange) => Promise<DailyNoteRow[]>
  assetReferencingNotePathsFn?: (assetPath: string, owners?: readonly string[]) => Promise<string[]>
}

export interface BuildNoteToolsOptions extends NoteToolDeps {
  /** The same verified destination bound to the model executing these tools. */
  target?: VerifiedModelTarget
  /** Native reads stay pinned to the graph that began the chat turn. */
  generation?: number | undefined
  /**
   * Whether note search can use embeddings for meaning-based recall. When
   * false, `search_notes` stays lexical so disabled semantic search is honored.
   */
  semanticSearchEnabled?: boolean
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

/** The refusal text — one string, read verbatim by both model and chip. */
export const INVALID_TAG_ERROR =
  'Not a tag — omit the tag to list all recent notes. Tags are single words like "book" or "project/atlas".'

export interface ListDailyNotesOutput {
  days: Array<CloudSafe<CloudNoteListing> | LocalSafe<CloudNoteListing>>
  /** The range held more days than one call returns — narrow it to see the rest. */
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

/** Shape one query row for the listings gate (epoch mtime → ISO timestamp). */
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
 * Build the chat tool set. Optional effect overrides are a test seam;
 * production callers omit them and the tools run over the shared retrieval
 * layer and the live filesystem.
 */
export function buildNoteTools(options: BuildNoteToolsOptions = {}): NoteTools {
  const target = options.target
  if (target?.kind === 'on-device' && options.generation === undefined) {
    throw new ReflectError('noGraph', 'On-device note tools require the active graph generation.')
  }
  const retrieveFn = options.retrieveFn ?? retrieve
  const readDeviceNoteFn = options.readDeviceNoteFn ?? readNoteForDevice
  const readNoteFn =
    options.readNoteFn ??
    (target?.kind === 'on-device'
      ? async (path: string): Promise<string> => {
          const read = await readDeviceNoteFn(path, options.generation)
          if (read.localOnly) throw new ReflectError('auth', 'Search source is local-only.')
          return read.content
        }
      : readShareableNote)
  const listRecentNotesFn = options.listRecentNotesFn ?? listRecentNotes
  const listDailyNotesFn = options.listDailyNotesFn ?? listDailyNotes
  const assetRefsFn = options.assetReferencingNotePathsFn ?? assetReferencingNotePaths
  const searchMode: RetrieveOptions['mode'] =
    options.semanticSearchEnabled === false ? 'lexical' : 'hybrid'

  // The gate's live privacy probe: the index flag on a hit can lag a
  // just-saved `private: true`, so each candidate's frontmatter is re-read
  // from disk. Fail closed — a note that can't be read can't be cleared
  // for sending. A local-only note is private by its path and never read.
  // Only a search hit can carry attachment text (listings show the note's
  // own preview), so only a hit's snapshot has its attachments rechecked.
  const isPrivateLive = async (
    path: string,
    searchSnapshot: Pick<SearchSnapshot, 'assetTextHash'> | null = null,
  ): Promise<boolean> => {
    if (isLocalOnlyPath(path)) {
      return true
    }
    try {
      if (target?.kind === 'on-device') {
        const read = await readDeviceNoteFn(path, options.generation)
        return (
          read.localOnly ||
          notePrivate(read.content) ||
          (await restrictedSources(path, read.content, searchSnapshot))
        )
      }
      const source = await readNoteFn(path)
      return notePrivate(source) || (await restrictedSources(path, source, searchSnapshot))
    } catch {
      return true
    }
  }

  async function restrictedSources(
    path: string,
    source: string,
    searchSnapshot: Pick<SearchSnapshot, 'assetTextHash'> | null,
  ): Promise<boolean> {
    if (
      searchSnapshot === null ||
      !(await snapshotHasAttachmentText(searchSnapshot.assetTextHash))
    ) {
      return false
    }
    const { assetTextHash } = searchSnapshot
    return await (options.hasRestrictedSearchSourcesFn?.(path, source, assetTextHash) ??
      hasRestrictedSearchSources(path, source, readNoteFn, options.generation, assetTextHash))
  }

  const readOneNote = buildReadOneNote({
    readNoteFn,
    readDeviceNoteFn,
    target,
    generation: options.generation,
  })

  const readOneAsset = buildReadOneAsset({
    readNoteFn,
    readDeviceNoteFn,
    assetReferencingNotePathsFn: assetRefsFn,
    target,
    generation: options.generation,
  })

  const privacyDescription =
    target?.kind === 'on-device'
      ? 'Includes private and local-only notes; this tool is bound to a verified model on this Mac.'
      : 'Private notes are excluded.'

  async function listings(rows: Array<RecentNoteRow | DailyNoteRow>) {
    const entries = rows.map(listingCandidate)
    if (target?.kind !== 'on-device') {
      return await cloudSafeNoteListings(entries, isPrivateLive)
    }
    return await Promise.all(
      entries.map(async (entry) =>
        localSafeNoteListing(target, {
          ...entry,
          isPrivate: entry.isPrivate || (await isPrivateLive(entry.path)),
        }),
      ),
    )
  }

  return {
    search_notes: {
      description: searchNotesDescription(
        options.semanticSearchEnabled !== false,
        privacyDescription,
      ),
      inputSchema: searchNotesInput,
      execute: async ({ query, limit }): Promise<SearchNotesOutput> => {
        const hits = await retrieveFn(query, {
          limit: limit ?? DEFAULT_SEARCH_LIMIT,
          mode: searchMode,
          excludePrivateContent: target?.kind !== 'on-device',
        })
        if (target?.kind === 'on-device') {
          return {
            hits: await Promise.all(
              hits.map(async (hit) =>
                localSafeSearchHit(target, {
                  ...hit,
                  isPrivate: hit.isPrivate || (await isPrivateLive(hit.path, hit)),
                }),
              ),
            ),
          }
        }
        const snapshots = new Map(hits.map((hit) => [hit.path, hit]))
        return {
          hits: await cloudSafeSearchHits(hits, (path) =>
            isPrivateLive(path, snapshots.get(path) ?? null),
          ),
        }
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
        const rows = await listRecentNotesFn({
          limit: limit ?? DEFAULT_RECENT_LIMIT,
          tag: tag ?? null,
          ...(target?.kind === 'on-device' ? { includePrivate: true } : {}),
        })
        return {
          ok: true,
          notes: await listings(rows),
        }
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
        const rows = await listDailyNotesFn({
          start,
          end,
          limit: MAX_DAILY_NOTE_DAYS + 1,
          ...(target?.kind === 'on-device' ? { includePrivate: true } : {}),
        })
        const truncated = rows.length > MAX_DAILY_NOTE_DAYS
        const kept = truncated ? rows.slice(0, MAX_DAILY_NOTE_DAYS) : rows
        return {
          days: await listings(kept),
          truncated,
        }
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
        (target?.kind === 'on-device'
          ? 'Includes private attachments and on-device OCR text.'
          : 'Attachments of private notes cannot be read.'),
      inputSchema: readAssetsInput,
      execute: async ({ paths }): Promise<ReadAssetsOutput> => {
        return { assets: await Promise.all(paths.map(readOneAsset)) }
      },
    },
  }
}

/** Tool description for the active search mode. */
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
 * (rather than inferred from {@link buildNoteTools}) so the declaration the
 * composite build emits only names types this package can import.
 */
export type NoteTools = {
  search_notes: Tool<z.infer<typeof searchNotesInput>, SearchNotesOutput>
  list_recent_notes: Tool<z.infer<typeof listRecentNotesInput>, ListRecentNotesOutput>
  list_daily_notes: Tool<z.infer<typeof listDailyNotesInput>, ListDailyNotesOutput>
  read_notes: Tool<z.infer<typeof readNotesInput>, ReadNotesOutput>
  read_assets: Tool<z.infer<typeof readAssetsInput>, ReadAssetsOutput>
}

/** The hit slice tool-activity UI renders (full hits stay engine-side). */
export type NoteHitSummary = Pick<CloudSearchHit, 'path' | 'title'>

/** One note's outcome in a read_notes call, for the tool-activity UI. */
export interface ReadNoteSummary {
  path: string
  title: string | null
  /** The per-note refusal/miss text, or `null` when the read succeeded. */
  error: string | null
}

/** One asset's outcome in a read_assets call, for the tool-activity UI. */
export interface ReadAssetSummary {
  path: string
  /** The per-asset refusal/miss text, or `null` when the read succeeded. */
  error: string | null
}

/** One tool invocation, as the transcript sees it. */
export type NoteToolCall =
  | { tool: 'search'; toolCallId: string; query: string }
  | { tool: 'read'; toolCallId: string; paths: string[] }
  | { tool: 'assets'; toolCallId: string; paths: string[] }
  | { tool: 'recents'; toolCallId: string; tag: string | null }
  | { tool: 'dailies'; toolCallId: string; start: string; end: string }

/** One settled tool invocation. A failed read or listing keeps its refusal. */
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

/** Map an SDK tool-call part onto {@link NoteToolCall} (null for dynamic). */
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

/** The path+title slice of one listing, for the tool-activity UI. */
function listingSummary(entry: CloudNoteListing): NoteHitSummary {
  return { path: entry.path, title: entry.title }
}

/** Map an SDK tool-result part onto {@link NoteToolResult} (null for dynamic). */
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

/** Attachment-text identity retained with a persisted search snippet. */
export interface SearchSnapshot {
  path: string
  assetTextHash?: string | undefined
}

/** The sources and search snapshot identities persisted by a tool result. */
export interface ToolResultSources {
  /** Notes behind search hits, listing rows, and note reads. */
  notes: string[]
  /** Attachments whose descriptions read_assets returned. */
  assets: string[]
  /** Search snippets require the original attachment-text identity on cloud resend. */
  searchSnapshots?: readonly SearchSnapshot[]
}

const sourceSchema = z.object({ path: z.string() })

/** A read_notes entry, or a whole legacy read_note output. */
const noteReadSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), note: sourceSchema }),
  z.object({ ok: z.literal(false) }),
])

const assetReadSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), asset: sourceSchema }),
  z.object({ ok: z.literal(false) }),
])

function noteSources(entries: readonly { path: string }[]): ToolResultSources {
  return { notes: entries.map((entry) => entry.path), assets: [] }
}

/**
 * Every output shape the note tools have ever persisted, reduced to its
 * sources. `read_note` is the single-note read that `read_notes` replaced,
 * and the first `list_recent_notes` returned its listing without `ok`.
 */
const storedResultSources = new Map<string, z.ZodType<ToolResultSources>>([
  [
    'search_notes',
    z
      .object({
        hits: z.array(
          sourceSchema.extend({
            assetTextHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          }),
        ),
      })
      .transform(({ hits }) => ({ ...noteSources(hits), searchSnapshots: hits })),
  ],
  [
    'read_notes',
    z
      .object({ notes: z.array(noteReadSchema) })
      .transform(({ notes }) =>
        noteSources(notes.flatMap((entry) => (entry.ok ? [entry.note] : []))),
      ),
  ],
  ['read_note', noteReadSchema.transform((entry) => noteSources(entry.ok ? [entry.note] : []))],
  [
    'read_assets',
    z.object({ assets: z.array(assetReadSchema) }).transform(({ assets }) => ({
      notes: [],
      assets: assets.map((entry) => (entry.ok ? entry.asset.path : null)).filter(isNotNullish),
    })),
  ],
  [
    'list_recent_notes',
    z
      .union([
        z.object({ ok: z.literal(false) }),
        z.object({ ok: z.literal(true).optional(), notes: z.array(sourceSchema) }),
      ])
      .transform((output) => noteSources('notes' in output ? output.notes : [])),
  ],
  [
    'list_daily_notes',
    z.object({ days: z.array(sourceSchema) }).transform(({ days }) => noteSources(days)),
  ],
])

/**
 * The note and asset paths a stored tool result (its JSON output, as
 * persisted in a turn's model messages) carries content from, so a resend
 * can re-check them (`./history-privacy`). Only entries holding something read
 * from the graph count: search hits, listing rows, and successful reads. A
 * refused or missing read echoes the model's own path with a fixed message.
 *
 * Returns `null` for a tool this module does not know or an output that does
 * not parse, so the caller can fail closed.
 */
export function toolResultSources(toolName: string, output: unknown): ToolResultSources | null {
  const parsed = storedResultSources.get(toolName)?.safeParse(output)
  return parsed?.success === true ? parsed.data : null
}
