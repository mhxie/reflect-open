import { patchNote, readNoteOrNull } from '../graph/patch-note.ts'
import { dailyPath } from '../graph/paths.ts'
import { hashContent } from '../indexing/hash.ts'
import { parseNote } from '../markdown/extract.ts'
import { parseFrontmatter, splitFrontmatter, upsertFrontmatter } from '../markdown/frontmatter.ts'
import type { AiProviderConfig } from '../settings/schema.ts'
import type { CaptureIdentity } from './capture-identity.ts'
import {
  captureNoteMeta,
  notePrivate,
  noteSource,
  retitleDailyEntry,
  type CaptureNoteMeta,
  type CaptureStatus,
} from './capture-note.ts'

export interface PendingCaptureSnapshot {
  /** Full source, including frontmatter, used to preserve unrelated keys. */
  source: string
  /** Markdown body whose hash guards against concurrent edits. */
  body: string
  /** Body start within `source`; the prefix is retained when replacing `body`. */
  bodyOffset: number
  /** Current note title used to keep the Daily alias in sync. */
  title: string
  /** Parsed hard privacy gate for every external enrichment call. */
  isPrivate: boolean
  /** Validated capture lifecycle and transaction frontmatter. */
  meta: CaptureNoteMeta
}

interface PersistCaptureEnrichmentInput {
  identity: CaptureIdentity
  expectedHash: string
  body: string
  fromTitle: string
  toTitle: string
  status: Exclude<CaptureStatus, 'skipped'>
  provider: AiProviderConfig | null
  screenshot?: string | undefined
  generation: number
}

interface CaptureWriteTransaction {
  fromTitle: string
  status: Exclude<CaptureStatus, 'skipped'>
}

/** Read the current pending form of a capture, or `null` if it moved on. */
export async function readPendingCaptureSnapshot(
  identity: CaptureIdentity,
  generation: number,
): Promise<PendingCaptureSnapshot | null> {
  return pendingCaptureSnapshot(identity, await readNoteOrNull(identity.notePath, generation))
}

/**
 * The pending form of a capture held by `source` (`null`: no file), or `null`
 * if it moved on. Checked writes re-derive it from the exact bytes they
 * replace.
 */
export function pendingCaptureSnapshot(
  identity: CaptureIdentity,
  source: string | null,
): PendingCaptureSnapshot | null {
  if (source === null) {
    return null
  }
  const split = splitFrontmatter(source)
  const frontmatter = parseFrontmatter(split.raw).data
  const meta = captureNoteMeta(frontmatter)
  if (meta === null || meta.captureStatus !== 'pending') {
    return null
  }
  return {
    source,
    body: split.body,
    bodyOffset: split.bodyOffset,
    title: parseNote({ path: identity.notePath, source }).title,
    isPrivate: frontmatter.private,
    meta,
  }
}

function captureWriteTransaction(meta: CaptureNoteMeta): CaptureWriteTransaction | null {
  if (meta.captureDailyFromTitle === undefined || meta.captureFinalizeStatus === undefined) {
    return null
  }
  return {
    fromTitle: meta.captureDailyFromTitle,
    status: meta.captureFinalizeStatus,
  }
}

/** Whether a prior pass left a recoverable note/Daily retitle to finish. */
export function hasCaptureWriteTransaction(meta: CaptureNoteMeta): boolean {
  return captureWriteTransaction(meta) !== null
}

/**
 * Finish the Daily half of a prepared capture retitle, then commit the capture
 * status. The prepared note keeps enough state for this to resume after either
 * write fails without re-scraping or guessing whether Daily text was user-made.
 * Both writes are checked: each re-validates the bytes it replaces, so a
 * concurrent edit is re-read and judged, never overwritten.
 */
export async function finishCaptureWrite(
  identity: CaptureIdentity,
  generation: number,
): Promise<Exclude<CaptureStatus, 'skipped'> | null> {
  const snapshot = await readPendingCaptureSnapshot(identity, generation)
  if (snapshot === null) {
    return null
  }
  const transaction = captureWriteTransaction(snapshot.meta)
  if (transaction === null) {
    return null
  }
  const expectedHash = snapshot.meta.captureHash
  const dailyNotePath = dailyPath(identity.date)
  if (
    snapshot.isPrivate ||
    notePrivate(await noteSource(dailyNotePath, generation)) ||
    (await hashContent(snapshot.body)) !== expectedHash
  ) {
    return null
  }
  await patchNote(
    dailyNotePath,
    (dailySource) =>
      dailySource === null || notePrivate(dailySource)
        ? null
        : retitleDailyEntry(dailySource, identity.base, transaction.fromTitle, snapshot.title),
    generation,
  )

  if (notePrivate(await noteSource(dailyNotePath, generation))) {
    return null
  }
  const committed = await patchNote(
    identity.notePath,
    async (source) => {
      const current = pendingCaptureSnapshot(identity, source)
      const currentTransaction = current === null ? null : captureWriteTransaction(current.meta)
      if (
        current === null ||
        currentTransaction === null ||
        currentTransaction.fromTitle !== transaction.fromTitle ||
        currentTransaction.status !== transaction.status ||
        current.isPrivate ||
        (await hashContent(current.body)) !== expectedHash
      ) {
        return null
      }
      return upsertFrontmatter(current.source, {
        captureStatus: transaction.status,
        captureDailyFromTitle: undefined,
        captureFinalizeStatus: undefined,
      })
    },
    generation,
  )
  return committed.patched === null ? null : transaction.status
}

/**
 * Persist a metadata or AI checkpoint. Title changes are prepared in the note
 * first and committed only after the Daily alias is updated, making the
 * two-file change recoverable on the next pass. The note write re-validates
 * the bytes it replaces, so an edit landing meanwhile is judged, not lost.
 */
export async function persistCaptureEnrichment(
  input: PersistCaptureEnrichmentInput,
): Promise<string | null> {
  const captureHash = await hashContent(input.body)
  if (notePrivate(await noteSource(dailyPath(input.identity.date), input.generation))) {
    return null
  }
  const titleChanged = input.toTitle !== input.fromTitle
  const persisted = await patchNote(
    input.identity.notePath,
    async (source) => {
      const snapshot = pendingCaptureSnapshot(input.identity, source)
      if (
        snapshot === null ||
        snapshot.title !== input.fromTitle ||
        snapshot.isPrivate ||
        (await hashContent(snapshot.body)) !== input.expectedHash
      ) {
        return null
      }
      const reassembled = snapshot.source.slice(0, snapshot.bodyOffset) + input.body
      return upsertFrontmatter(reassembled, {
        captureStatus: titleChanged ? 'pending' : input.status,
        captureMetadataStatus: 'done',
        captureHash,
        captureProvider: input.provider?.provider,
        captureModel: input.provider?.model,
        ...(input.screenshot === undefined ? {} : { captureScreenshot: input.screenshot }),
        captureDailyFromTitle: titleChanged ? input.fromTitle : undefined,
        captureFinalizeStatus: titleChanged ? input.status : undefined,
      })
    },
    input.generation,
  )
  if (persisted.patched === null) {
    return null
  }
  if (titleChanged && (await finishCaptureWrite(input.identity, input.generation)) === null) {
    return null
  }
  return captureHash
}
