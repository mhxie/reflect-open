import { isAppError } from '../errors.ts'
import { listAttachments, readAssetForDevice } from '../graph/commands.ts'
import { assetReferenceMatches } from '../indexing/asset-refs.ts'
import { hashBytes, matchesTrustedMtime } from '../indexing/hash.ts'
import { localOcrAssetTypeFor } from './asset-description-helpers.ts'
import {
  cachedAssetOcrPaths,
  invalidateLocalAssetOcr,
  readAssetOcrState,
} from './asset-ocr-cache.ts'

/** How {@link reconcileCachedAssetOcr} reports what needs reindexing. */
export interface ReconcileAssetOcrOptions {
  /**
   * Report every cached source, valid or invalid, so notes referencing them
   * are reindexed (graph open, or a retry after a failed reindex). Defaults
   * to true for a full scan. Otherwise only sources this pass invalidates
   * are reported.
   */
  readonly reindexCached?: boolean
  /**
   * Skip re-reading a source whose size and modification time still match
   * what the cache recorded when its bytes were read (wake scans). Off for
   * graph open and for reported changes, which always re-hash: a replacement
   * that keeps its metadata is caught there.
   */
  readonly trustUnchangedStat?: boolean
  /** The clock for the stat check; tests pin it. */
  readonly now?: () => number
}

/**
 * Check existing OCR sources after open/wake or file changes, without
 * generating new OCR. Scans `changed` (attachment paths or bare names), or
 * every cached source when omitted. Returns the asset paths whose
 * referencing notes need reindexing.
 */
export async function reconcileCachedAssetOcr(
  generation: number,
  changed?: readonly string[],
  {
    reindexCached = changed === undefined,
    trustUnchangedStat = false,
    now = Date.now,
  }: ReconcileAssetOcrOptions = {},
): Promise<string[]> {
  const references = changed ?? (await cachedAssetOcrPaths(generation))
  const catalog = await listAttachments(generation)
  const paths = [
    ...new Set(
      references.flatMap((reference) =>
        reference.includes('/')
          ? reference
          : catalog
              .filter((file) => assetReferenceMatches(reference, file.path))
              .map((file) => file.path),
      ),
    ),
  ]
  const metaByPath = new Map(catalog.map((file) => [file.path, file]))
  const invalidated: string[] = []
  for (const path of paths) {
    if (localOcrAssetTypeFor(path) === null) continue
    const cached = await readAssetOcrState(path, generation)
    if (cached === null) continue
    if (cached.status === 'invalid') {
      if (reindexCached) invalidated.push(path)
      continue
    }
    if (reindexCached) invalidated.push(path)
    const meta = metaByPath.get(path)
    if (meta?.placeholder === true) {
      // iCloud-evicted: verifying would force a download. The OCR stays until
      // the file is local again, when its change event re-checks it.
      continue
    }
    if (
      trustUnchangedStat &&
      meta?.size === cached.sourceSize &&
      matchesTrustedMtime(cached.sourceModifiedMs, meta.modifiedMs, now())
    ) {
      continue
    }
    let currentHash: string | null
    try {
      currentHash = await hashBytes(await readAssetForDevice(path, generation))
    } catch (cause) {
      if (!isAppError(cause)) throw cause
      // Offline or otherwise unreadable right now: leave it for a later scan
      // rather than abort the rest of this one.
      if (cause.kind === 'io') continue
      if (cause.kind === 'notFound' || cause.kind === 'traversal' || cause.kind === 'unsupported')
        currentHash = null
      else throw cause
    }
    if (currentHash !== cached.sourceHash) {
      await invalidateLocalAssetOcr(path, generation)
      if (!invalidated.includes(path)) invalidated.push(path)
    }
  }
  return invalidated
}
