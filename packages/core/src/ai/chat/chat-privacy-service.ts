import type { ModelMessage } from '@reflect/modules/ai'
import { sha256Hex } from '@reflect/utils'
import { sql } from 'kysely'
import { z } from 'zod'
import { readAssetOcrState } from '../../assets/asset-ocr-cache.ts'
import type { AssetPrivacyService } from '../../assets/asset-privacy-service.ts'
import { isXArchiveAssetPath } from '../../embeds/x-archive-service.ts'
import { isAppError, ReflectError } from '../../errors.ts'
import type { AssetStoreService } from '../../graph/asset-store-service.ts'
import {
  createAttachmentCatalog,
  resolveAttachmentLink,
} from '../../graph/attachment-resolution.ts'
import { isLocalOnlyPath, type LocalOnlyFolders } from '../../graph/local-only.ts'
import type { NoteFileService } from '../../graph/note-file-service.ts'
import { descriptionPathFor } from '../../graph/paths.ts'
import {
  foldAssetDescriptionBodies,
  type AssetDescriptionBody,
} from '../../indexing/asset-description-text.ts'
import { assetReferenceMatches, type AssetReferences } from '../../indexing/asset-refs.ts'
import type { DatabaseService } from '../../indexing/database-service.ts'
import { parseNote } from '../../markdown/extract.ts'
import { splitFrontmatter } from '../../markdown/frontmatter.ts'
import type { VerifiedModelTarget } from '../../privacy/on-device.ts'
import { notePrivate } from '../../privacy/privacy-service.ts'
import { splitIntoTurnSegments } from './context-window.ts'
import {
  toolResultSources,
  type SearchSnapshot,
  type ToolResultSources,
} from './tool-result-sources.ts'

/**
 * Chat privacy past the first read (fork: chat history privacy). Two checks
 * the privacy gate alone cannot make:
 *
 * - **History at resend.** Every turn resends the earlier exchanges, tool
 *   results included (`buildHistory`), so a note that was public when the
 *   model read it and is private now would keep reaching the provider.
 *   Before a cloud turn, every note and asset an earlier exchange read is
 *   re-checked. The first exchange that read one that is private now is left
 *   out, and so is every exchange after it: a later answer can repeat what
 *   the withheld one read ("translate that summary") without reading
 *   anything itself. Exchanges are the context window's turn segments, so
 *   role alternation survives; the turn's new user message is always sent.
 *   The stored turns are untouched; only what this turn sends changes. An
 *   on-device target receives the full history once its server passes
 *   verification. A conversation containing marked private local context is
 *   refused outright when a cloud target is selected.
 * - **Attachment text in a search snippet.** A snippet can carry the folded
 *   description text of the attachments its note embeds; its snapshot keeps
 *   that text's hash, and a cloud send re-checks the attachments behind it.
 *
 * Private now means a note in a local-only folder or whose index row is
 * private or missing (moved, deleted, not indexed), or an asset in a
 * local-only folder or the X archive folder, referenced by no indexed note,
 * or referenced by a note that is private now. A tool result whose sources
 * can't be read fails closed. Index flags and live note/sidecar sources are
 * both checked, including changes that have not reached the index yet; each
 * live source is read once per turn, a few at a time.
 */

/**
 * How many live note, sidecar, or asset checks run at once.
 */
const READ_CONCURRENCY = 4

/**
 * The graph a chat turn runs in: the file generation its reads pin to, and its local-only folders.
 */
export interface ChatPrivacyScope {
  readonly generation: number
  readonly localOnly: LocalOnlyFolders
}

/**
 * What {@link ChatPrivacyService.hasRestrictedSearchSources} reads with.
 */
export interface RestrictedSourcesOptions extends ChatPrivacyScope {
  /**
   * The tier's reader of sidecars and referencing notes.
   */
  readonly readNote: (path: string) => Promise<string>
  /**
   * The attachment-text hash of the snapshot being exposed; without one only
   * the live sources are checked.
   */
  readonly expectedAssetTextHash?: string | undefined
}

/**
 * The history one turn sends, from {@link ChatPrivacyService.historyForTarget}.
 */
export interface TargetHistory {
  /**
   * What to send: the input array itself when nothing was left out.
   */
  messages: ModelMessage[]
  /**
   * How many earlier exchanges were left out.
   */
  withheldTurns: number
}

/**
 * The privacy checks of a chat turn beyond its first reads.
 */
export interface ChatPrivacyService {
  /**
   * The model-facing history `target` may receive, given everything a turn
   * would resend (`buildHistory` plus the new user message, which is always
   * the last segment and always sent). A verified on-device target receives
   * all of it; a cloud target gets the public prefix of the history, or a
   * refusal (`ReflectError('auth')`) when marked private local context, or a
   * search snippet whose attachment text can no longer be cleared, occurs in
   * what it would be sent.
   */
  historyForTarget(
    messages: ModelMessage[],
    target: VerifiedModelTarget,
    scope: ChatPrivacyScope,
  ): Promise<TargetHistory>
  /**
   * Whether the attachments behind a search snapshot of `path` may not reach
   * a model: an embedded attachment that is unresolved, local-only, holds
   * device-only OCR text, or has a private or unreadable sidecar or
   * referencing note; or, with `expectedAssetTextHash`, attachment text that
   * no longer matches the snapshot's. `source` is the note's live Markdown;
   * the index's references are checked too.
   */
  hasRestrictedSearchSources(
    path: string,
    source: string,
    options: RestrictedSourcesOptions,
  ): Promise<boolean>
  /**
   * Whether a search snapshot may hold attachment text: false only when its
   * attachment-text hash is the empty text's. A missing hash (a snapshot from
   * an older build) counts as holding some, so callers fail closed.
   */
  snapshotHasAttachmentText(assetTextHash: string | undefined): Promise<boolean>
}

export interface ChatPrivacyServiceDeps {
  readonly database: DatabaseService
  readonly noteFile: NoteFileService
  readonly assetStore: AssetStoreService
  readonly assetReferences: AssetReferences
  readonly assetPrivacy: AssetPrivacyService
}

/**
 * The checked paths that are private now, by kind.
 */
interface PrivatePaths {
  notes: ReadonlySet<string>
  assets: ReadonlySet<string>
  liveSources: ReadonlyMap<string, string>
}

/**
 * A live-source reader that reads each path at most once per turn.
 */
type CachedReader = (path: string) => Promise<string>

type PrivacyRowSource = 'note' | 'asset'

/**
 * One row of the privacy lookup: a note's own row, or a note referencing an asset.
 */
interface PrivacyRow {
  source: PrivacyRowSource
  /**
   * The note path, or the asset reference as the index stores it.
   */
  reference: string
  notePath: string
  isPrivate: number
}

class ChatPrivacyServiceImpl implements ChatPrivacyService {
  readonly #deps: ChatPrivacyServiceDeps

  constructor(deps: ChatPrivacyServiceDeps) {
    this.#deps = deps
  }

  async historyForTarget(
    messages: ModelMessage[],
    target: VerifiedModelTarget,
    scope: ChatPrivacyScope,
  ): Promise<TargetHistory> {
    if (target.kind === 'on-device') {
      return { messages, withheldTurns: 0 }
    }
    refuseCloudPrivateContext(messages)
    const segments = splitIntoTurnSegments(messages)
    const current = segments.at(-1)
    if (current === undefined) {
      return { messages, withheldTurns: 0 }
    }
    const earlier = segments.slice(0, -1)
    // Exchanges from the first one whose sources can't be read are left out
    // whatever they name, so nothing past it is checked.
    const parsed: ToolResultSources[] = []
    for (const segment of earlier) {
      const sources = segmentSources(segment)
      if (sources === null) {
        break
      }
      parsed.push(sources)
    }
    const reader = this.#cachedReader(scope.generation)
    const privateNow = await this.#privateNowPaths(parsed, reader, scope)
    const firstPrivate = parsed.findIndex((sources) => namesPrivatePath(sources, privateNow))
    const keptCount = firstPrivate === -1 ? parsed.length : firstPrivate
    await this.#refuseCloudRestrictedSearchSnapshots(
      parsed.slice(0, keptCount).flatMap((sources) => sources.searchSnapshots ?? []),
      privateNow,
      reader,
      scope,
    )
    const withheldTurns = earlier.length - keptCount
    return withheldTurns === 0
      ? { messages, withheldTurns }
      : { messages: [...earlier.slice(0, keptCount).flat(), ...current], withheldTurns }
  }

  async hasRestrictedSearchSources(
    path: string,
    source: string,
    options: RestrictedSourcesOptions,
  ): Promise<boolean> {
    const { database, noteFile, assetStore, assetReferences, assetPrivacy } = this.#deps
    const { readNote, generation, localOnly, expectedAssetTextHash } = options
    const indexed = await database.db
      .selectFrom('assets')
      .where('notePath', '=', path)
      .select('assetPath')
      .execute()
    const liveReferences = parseNote({ path, source }).assets.map((asset) => asset.path)
    const references = [...new Set([...indexed.map((row) => row.assetPath), ...liveReferences])]
    const catalog = references.some((reference) => !reference.includes('/'))
      ? createAttachmentCatalog(await noteFile.listAttachments(generation))
      : null
    if (
      references.some((reference) => {
        if (reference.includes('/')) return false
        const resolved = resolveAttachmentLink(path, reference, catalog)
        return resolved === null || catalog?.has(resolved) !== true
      })
    ) {
      return true
    }
    const assetPaths = [
      ...new Set(
        references.flatMap((reference) =>
          reference.includes('/')
            ? reference
            : [
                resolveAttachmentLink(path, reference, catalog) ?? reference,
                ...(catalog?.named(reference) ?? []),
              ],
        ),
      ),
    ]
    const descriptions = new Map<string, string>()
    for (const assetPath of assetPaths) {
      if (
        isLocalOnlyPath(localOnly, assetPath) ||
        (await readAssetOcrState(assetStore, assetPath, generation)) !== null
      ) {
        return true
      }
      try {
        const description = await readNote(descriptionPathFor(assetPath))
        if (notePrivate(description)) return true
        descriptions.set(assetPath, splitFrontmatter(description).body.trim())
      } catch (cause) {
        if (!isAppError(cause) || cause.kind !== 'notFound') return true
      }
      const candidates = await assetReferences.notePaths(assetPath)
      if ((await assetPrivacy.classifyAssetFromNotes(assetPath, candidates, readNote)) !== 'send') {
        return true
      }
    }
    if (expectedAssetTextHash === undefined) return false
    const bodies: AssetDescriptionBody[] = []
    const seen = new Set<string>()
    for (const reference of liveReferences) {
      const assetPath = reference.includes('/')
        ? reference
        : (resolveAttachmentLink(path, reference, catalog) ?? reference)
      if (seen.has(assetPath)) continue
      seen.add(assetPath)
      const body = descriptions.get(assetPath)
      if (body !== undefined && body !== '') bodies.push({ assetPath, body })
    }
    return (await sha256Hex(foldAssetDescriptionBodies(bodies))) !== expectedAssetTextHash
  }

  async snapshotHasAttachmentText(assetTextHash: string | undefined): Promise<boolean> {
    return assetTextHash === undefined || assetTextHash !== (await sha256Hex(''))
  }

  /**
   * Refuse the turn when a kept exchange's search snippet carried attachment
   * text whose sources can no longer be cleared. Exchanges already left out
   * are not checked: nothing they hold is sent.
   */
  async #refuseCloudRestrictedSearchSnapshots(
    snapshots: readonly SearchSnapshot[],
    privateNow: PrivatePaths,
    reader: CachedReader,
    scope: ChatPrivacyScope,
  ): Promise<void> {
    const unique = [
      ...new Map(
        snapshots.map((snapshot) => [`${snapshot.path}\n${snapshot.assetTextHash}`, snapshot]),
      ).values(),
    ]
    await mapConcurrently(unique, async (snapshot) => {
      if (!(await this.snapshotHasAttachmentText(snapshot.assetTextHash))) return
      const source = privateNow.liveSources.get(snapshot.path)
      if (
        snapshot.assetTextHash === undefined ||
        privateNow.notes.has(snapshot.path) ||
        source === undefined ||
        (await this.hasRestrictedSearchSources(snapshot.path, source, {
          readNote: reader,
          generation: scope.generation,
          localOnly: scope.localOnly,
          expectedAssetTextHash: snapshot.assetTextHash,
        }))
      ) {
        throw new ReflectError(
          'auth',
          'This conversation contains attachment search text whose original source cannot be cleared for cloud use. Continue with a verified on-device model or start a new cloud conversation.',
        )
      }
    })
  }

  /**
   * Which of the named notes and assets are private now (see the module doc).
   */
  async #privateNowPaths(
    named: readonly ToolResultSources[],
    reader: CachedReader,
    scope: ChatPrivacyScope,
  ): Promise<PrivatePaths> {
    const { localOnly } = scope
    const notes = [...new Set(named.flatMap((sources) => sources.notes))]
    const assets = [...new Set(named.flatMap((sources) => sources.assets))]
    const privateNotes = new Set(notes.filter((path) => isLocalOnlyPath(localOnly, path)))
    // An archived post can own an X asset, so a note linking the post references
    // it too. Finding those owners takes a disk read per asset
    // (`XArchiveService.owners`), which this one-query gate does not make, so
    // every X asset counts as private.
    const privateAssets = new Set(
      assets.filter((path) => isLocalOnlyPath(localOnly, path) || isXArchiveAssetPath(path)),
    )
    const notePaths = notes.filter((path) => !privateNotes.has(path))
    const assetPaths = assets.filter((path) => !privateAssets.has(path))
    const rows = await this.#privacyRows(notePaths, assetPaths)
    const liveSources = new Map<string, string>()

    const publicNotes = new Set(
      rows.filter((row) => row.source === 'note' && row.isPrivate === 0).map((row) => row.notePath),
    )
    await mapConcurrently(notePaths, async (path) => {
      if (!publicNotes.has(path)) {
        privateNotes.add(path)
        return
      }
      try {
        const source = await reader(path)
        liveSources.set(path, source)
        if (notePrivate(source)) {
          privateNotes.add(path)
        }
      } catch {
        privateNotes.add(path)
      }
    })
    const referenceRows = rows.filter((row) => row.source === 'asset')
    await mapConcurrently(assetPaths, async (path) => {
      if (await this.#assetPrivateNow(path, referenceRows, reader, scope)) {
        privateAssets.add(path)
      }
    })
    return { notes: privateNotes, assets: privateAssets, liveSources }
  }

  /**
   * Whether one asset is private now: device-only text, a private sidecar, or a private referrer.
   */
  async #assetPrivateNow(
    path: string,
    referenceRows: readonly PrivacyRow[],
    reader: CachedReader,
    scope: ChatPrivacyScope,
  ): Promise<boolean> {
    if ((await readAssetOcrState(this.#deps.assetStore, path, scope.generation)) !== null) {
      return true
    }
    try {
      if (notePrivate(await reader(descriptionPathFor(path)))) {
        return true
      }
    } catch (cause) {
      if (!isAppError(cause) || cause.kind !== 'notFound') {
        return true
      }
    }
    const referencing = referenceRows.filter((row) => assetReferenceMatches(row.reference, path))
    if (
      referencing.length === 0 ||
      referencing.some(
        (row) => row.isPrivate !== 0 || isLocalOnlyPath(scope.localOnly, row.notePath),
      )
    ) {
      return true
    }
    for (const row of referencing) {
      try {
        if (notePrivate(await reader(row.notePath))) {
          return true
        }
      } catch {
        return true
      }
    }
    return false
  }

  /**
   * A reader of live note and sidecar sources that reads each path once: the
   * same note is often named by many exchanges, by an asset's referrers, and
   * by the snapshot check. Local-only sources are refused by Rust, so they
   * read as unreadable.
   */
  #cachedReader(generation: number): CachedReader {
    const { noteFile } = this.#deps
    const reads = new Map<string, Promise<string>>()
    return (path) => {
      let read = reads.get(path)
      if (read === undefined) {
        read = noteFile.readShareable(path, generation).then((result) => {
          if (result.kind === 'localOnly') {
            throw new ReflectError('auth', 'History source is local-only.')
          }
          return result.content
        })
        reads.set(path, read)
      }
      return read
    }
  }

  /**
   * The index rows the gate needs, in one query: each note's own row (by
   * primary key), plus every note that references one of the assets, by full
   * path or by the bare filename a wiki embed stores (`assetReferenceMatches`).
   * No query runs when nothing needs checking.
   */
  async #privacyRows(
    notePaths: readonly string[],
    assetPaths: readonly string[],
  ): Promise<PrivacyRow[]> {
    const { db } = this.#deps.database
    const noteRows = db
      .selectFrom('notes')
      .where('path', 'in', notePaths)
      .select([
        sql.lit<PrivacyRowSource>('note').as('source'),
        'path as reference',
        'path as notePath',
        sql<number>`is_private OR has_device_only_content`.as('isPrivate'),
      ])
    const references = [
      ...new Set(assetPaths.flatMap((path) => [path, path.split('/').at(-1) ?? path])),
    ]
    const referenceRows = db
      .selectFrom('assets')
      .innerJoin('notes', 'notes.path', 'assets.notePath')
      .where('assets.assetPath', 'in', references)
      .select([
        sql.lit<PrivacyRowSource>('asset').as('source'),
        'assets.assetPath as reference',
        'notes.path as notePath',
        sql<number>`notes.is_private OR notes.has_device_only_content`.as('isPrivate'),
      ])
    if (assetPaths.length === 0) {
      return notePaths.length === 0 ? [] : await noteRows.execute()
    }
    if (notePaths.length === 0) {
      return await referenceRows.execute()
    }
    return await noteRows.unionAll(referenceRows).execute()
  }
}

export function createChatPrivacyService(deps: ChatPrivacyServiceDeps): ChatPrivacyService {
  return new ChatPrivacyServiceImpl(deps)
}

/**
 * Refuse cloud turns for conversations containing device-only tool results:
 * later answers can paraphrase that content even after history filtering.
 * `ChatEngineService.streamTurn` reports the refusal before sending a request.
 */
function refuseCloudPrivateContext(messages: readonly ModelMessage[]): void {
  if (containsPrivateContext(messages)) {
    throw new ReflectError(
      'auth',
      'This conversation contains private local context. Continue with a verified on-device model or start a new conversation for a cloud model.',
    )
  }
}

function containsPrivateContext(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  if ('reflectPrivateContext' in value && value.reflectPrivateContext === true) {
    return true
  }
  return Object.values(value).some(containsPrivateContext)
}

/**
 * A stored tool result, read only as far as naming its sources needs. Every
 * note tool's output is JSON; an error or a denial carries nothing read from
 * the graph. Any other output does not parse, so its exchange fails closed.
 */
const storedToolResultSchema = z.object({
  type: z.literal('tool-result'),
  toolName: z.string(),
  output: z.union([
    z.object({ type: z.literal('json'), value: z.unknown() }),
    z.object({ type: z.enum(['error-text', 'error-json', 'execution-denied']) }),
  ]),
})

function isToolResultPart(part: unknown): boolean {
  return typeof part === 'object' && part !== null && 'type' in part && part.type === 'tool-result'
}

/**
 * What one exchange's tool results read, or `null` when any of them can't be
 * read. Stored messages are validated by envelope only
 * (`./chat-history-service`), so their parts are parsed here as untrusted data.
 */
function segmentSources(segment: readonly ModelMessage[]): ToolResultSources | null {
  const notes: string[] = []
  const assets: string[] = []
  const searchSnapshots: SearchSnapshot[] = []
  for (const message of segment) {
    const content: unknown = message.content
    if (typeof content === 'string') {
      continue
    }
    if (!Array.isArray(content)) {
      return null
    }
    const parts: readonly unknown[] = content
    for (const part of parts) {
      if (!isToolResultPart(part)) {
        continue
      }
      const parsed = storedToolResultSchema.safeParse(part)
      if (!parsed.success) {
        return null
      }
      if (parsed.data.output.type !== 'json') {
        continue
      }
      const sources = toolResultSources(parsed.data.toolName, parsed.data.output.value)
      if (sources === null) {
        return null
      }
      notes.push(...sources.notes)
      assets.push(...sources.assets)
      searchSnapshots.push(...(sources.searchSnapshots ?? []))
    }
  }
  return { notes, assets, searchSnapshots }
}

function namesPrivatePath(sources: ToolResultSources, privateNow: PrivatePaths): boolean {
  return (
    sources.notes.some((path) => privateNow.notes.has(path)) ||
    sources.assets.some((path) => privateNow.assets.has(path))
  )
}

/**
 * Run `task` over `items` with at most {@link READ_CONCURRENCY} in flight.
 * Rejects with the first failure.
 */
async function mapConcurrently<T>(
  items: readonly T[],
  task: (item: T) => Promise<void>,
): Promise<void> {
  // One iterator shared by every worker hands each item out exactly once.
  const pending = items.values()
  const worker = async (): Promise<void> => {
    for (const item of pending) {
      await task(item)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, items.length) }, () => worker()),
  )
}
