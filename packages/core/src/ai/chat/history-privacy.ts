import type { ModelMessage } from '@reflect/modules/ai'
import { sql } from 'kysely'
import { z } from 'zod'
import { isLocalOnlyPath } from '../../graph/local-only.ts'
import { readNoteShareable } from '../../graph/commands.ts'
import { descriptionPathFor } from '../../graph/paths.ts'
import { notePrivate } from '../../privacy/checkers.ts'
import { assetReferenceMatches } from '../../indexing/asset-refs.ts'
import { hashContent } from '../../indexing/hash.ts'
import { db } from '../../indexing/db.ts'
import type { VerifiedModelTarget } from '../../privacy/on-device.ts'
import { isAppError, ReflectError } from '../../errors.ts'
import { readAssetOcrState } from '../../actions/asset-ocr-cache.ts'
import { isXArchiveAssetPath } from '../../x-archive.ts'
import { splitIntoTurnSegments } from './context-window.ts'
import { toolResultSources, type ToolResultSources } from './tools.ts'
import { hasRestrictedSearchSources } from './search-privacy.ts'

/**
 * Chat history privacy at resend. Every turn resends the earlier exchanges,
 * tool results included (`buildHistory`), so a note that was public when the
 * model read it and is private now would keep reaching the provider. Before a
 * cloud turn, every note and asset an earlier exchange read is re-checked, and
 * each exchange that read one that is private now is left out whole: the user
 * message, the tool calls and results, and the answer, which can paraphrase
 * what it read. Exchanges are the context window's turn segments, so role
 * alternation survives. The stored turns are untouched; only what this turn
 * sends changes. An on-device target receives the full history once its
 * server passes verification. A conversation containing marked private local
 * context is refused outright when a cloud target is selected.
 *
 * Private now means a note in a local-only folder or whose index row is
 * private or missing (moved, deleted, not indexed), or an asset in a
 * local-only folder or the X archive folder, referenced by no indexed note,
 * or referenced by a note that is private now. A tool result whose sources
 * can't be read fails closed. Index flags and live note/sidecar sources are
 * both checked, including changes that have not reached the index yet.
 */

/** The history one turn sends, from {@link historyForTarget}. */
export interface TargetHistory {
  /** What to send: the input array itself when nothing was left out. */
  messages: ModelMessage[]
  /** How many earlier exchanges were left out. */
  withheldTurns: number
}

/**
 * The model-facing history `target` may receive, given everything a turn
 * would resend (`buildHistory` plus the new user message). An on-device
 * target whose server {@link verifyOnDeviceServer} accepts receives all of
 * it; a cloud target gets filtered public history or a refusal when marked
 * private local context occurs anywhere in the conversation.
 */
export async function historyForTarget(
  messages: ModelMessage[],
  target: VerifiedModelTarget,
  generation?: number,
): Promise<TargetHistory> {
  if (target.kind === 'on-device') {
    return { messages, withheldTurns: 0 }
  }
  refuseCloudPrivateContext(messages)
  const segments = splitIntoTurnSegments(messages)
  const checked = segments.map((segment) => ({ segment, sources: segmentSources(segment) }))
  const privateNow = await privateNowPaths(
    checked.flatMap(({ sources }) => (sources === null ? [] : [sources])),
    generation,
  )
  await refuseCloudRestrictedSearchSnapshots(
    checked.flatMap(({ sources }) => sources?.searchSnapshots ?? []),
    privateNow,
    generation,
  )
  const kept = checked.filter(
    ({ sources }) => sources !== null && !namesPrivatePath(sources, privateNow),
  )
  const withheldTurns = segments.length - kept.length
  return withheldTurns === 0
    ? { messages, withheldTurns }
    : { messages: kept.flatMap(({ segment }) => segment), withheldTurns }
}

/**
 * Refuse cloud turns for conversations containing device-only tool results:
 * later answers can paraphrase that content even after history filtering.
 * `streamChat` reports the refusal before sending a request.
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
 * read. Stored messages are validated by envelope only (`./store`), so their
 * parts are parsed here as untrusted data.
 */
function segmentSources(segment: readonly ModelMessage[]): ToolResultSources | null {
  const notes: string[] = []
  const assets: string[] = []
  const searchSnapshots: NonNullable<ToolResultSources['searchSnapshots']>[number][] = []
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

/** The checked paths that are private now, by kind. */
interface PrivatePaths {
  notes: ReadonlySet<string>
  assets: ReadonlySet<string>
  liveSources: ReadonlyMap<string, string>
}

async function refuseCloudRestrictedSearchSnapshots(
  snapshots: NonNullable<ToolResultSources['searchSnapshots']>,
  privateNow: PrivatePaths,
  generation?: number,
): Promise<void> {
  const emptyHash = await hashContent('')
  for (const snapshot of snapshots) {
    if (snapshot.assetTextHash === emptyHash) continue
    const source = privateNow.liveSources.get(snapshot.path)
    if (
      snapshot.assetTextHash === undefined ||
      privateNow.notes.has(snapshot.path) ||
      source === undefined ||
      (await hasRestrictedSearchSources(
        snapshot.path,
        source,
        (path) => readPublicNote(path, generation),
        generation,
        snapshot.assetTextHash,
      ))
    ) {
      throw new ReflectError(
        'auth',
        'This conversation contains attachment search text whose original source cannot be cleared for cloud use. Continue with a verified on-device model or start a new cloud conversation.',
      )
    }
  }
}

function namesPrivatePath(sources: ToolResultSources, privateNow: PrivatePaths): boolean {
  return (
    sources.notes.some((path) => privateNow.notes.has(path)) ||
    sources.assets.some((path) => privateNow.assets.has(path))
  )
}

/** Which of the named notes and assets are private now (see the module doc). */
async function privateNowPaths(
  named: readonly ToolResultSources[],
  generation?: number,
): Promise<PrivatePaths> {
  const notes = [...new Set(named.flatMap((sources) => sources.notes))]
  const assets = [...new Set(named.flatMap((sources) => sources.assets))]
  const privateNotes = new Set(notes.filter((path) => isLocalOnlyPath(path)))
  // An archived post can own an X asset, so a note linking the post references
  // it too. Finding those owners takes a disk read per asset
  // (`getXArchiveOwners`), which this one-query gate does not make, so every
  // X asset counts as private.
  const privateAssets = new Set(
    assets.filter((path) => isLocalOnlyPath(path) || isXArchiveAssetPath(path)),
  )
  const notePaths = notes.filter((path) => !privateNotes.has(path))
  const assetPaths = assets.filter((path) => !privateAssets.has(path))
  const rows = await privacyRows(notePaths, assetPaths)
  const liveSources = new Map<string, string>()

  const publicNotes = new Set(
    rows.filter((row) => row.source === 'note' && row.isPrivate === 0).map((row) => row.notePath),
  )
  for (const path of notePaths) {
    if (!publicNotes.has(path)) {
      privateNotes.add(path)
      continue
    }
    try {
      const source = await readPublicNote(path, generation)
      liveSources.set(path, source)
      if (
        notePrivate(source) ||
        (await hasRestrictedSearchSources(
          path,
          source,
          (notePath) => readPublicNote(notePath, generation),
          generation,
        ))
      ) {
        privateNotes.add(path)
      }
    } catch {
      privateNotes.add(path)
    }
  }
  const referenceRows = rows.filter((row) => row.source === 'asset')
  for (const path of assetPaths) {
    if ((await readAssetOcrState(path, generation)) !== null) {
      privateAssets.add(path)
      continue
    }
    try {
      if (notePrivate(await readPublicNote(descriptionPathFor(path), generation))) {
        privateAssets.add(path)
        continue
      }
    } catch (cause) {
      if (!isAppError(cause) || cause.kind !== 'notFound') {
        privateAssets.add(path)
        continue
      }
    }
    const referencing = referenceRows.filter((row) => assetReferenceMatches(row.reference, path))
    if (
      referencing.length === 0 ||
      referencing.some((row) => row.isPrivate !== 0 || isLocalOnlyPath(row.notePath))
    ) {
      privateAssets.add(path)
      continue
    }
    for (const row of referencing) {
      try {
        if (notePrivate(await readPublicNote(row.notePath, generation))) privateAssets.add(path)
      } catch {
        privateAssets.add(path)
      }
    }
  }
  return { notes: privateNotes, assets: privateAssets, liveSources }
}

async function readPublicNote(path: string, generation?: number): Promise<string> {
  const read = await readNoteShareable(path, generation)
  if (read.kind === 'localOnly') throw new ReflectError('auth', 'History source is local-only.')
  return read.content
}

type PrivacyRowSource = 'note' | 'asset'

/** One row of the privacy lookup: a note's own row, or a note referencing an asset. */
interface PrivacyRow {
  source: PrivacyRowSource
  /** The note path, or the asset reference as the index stores it. */
  reference: string
  notePath: string
  isPrivate: number
}

/**
 * The index rows the gate needs, in one query: each note's own row (by
 * primary key), plus every note that references one of the assets, by full
 * path or by the bare filename a wiki embed stores (`assetReferenceMatches`).
 * No query runs when nothing needs checking.
 */
async function privacyRows(
  notePaths: readonly string[],
  assetPaths: readonly string[],
): Promise<PrivacyRow[]> {
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
