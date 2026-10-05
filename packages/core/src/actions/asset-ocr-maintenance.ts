import { isAppError } from '../errors.ts'
import { listAttachments, readAssetForDevice } from '../graph/commands.ts'
import { assetReferenceMatches } from '../indexing/asset-refs.ts'
import { hashBytes } from '../indexing/hash.ts'
import { localOcrAssetTypeFor } from './asset-description-helpers.ts'
import {
  cachedAssetOcrPaths,
  invalidateLocalAssetOcr,
  readAssetOcrState,
} from './asset-ocr-cache.ts'

/** Check existing OCR sources after open/wake or file changes, without generating new OCR. */
export async function reconcileCachedAssetOcr(
  generation: number,
  changed?: readonly string[],
): Promise<string[]> {
  const references = changed ?? (await cachedAssetOcrPaths(generation))
  const catalog = await listAttachments(generation)
  const paths = [
    ...new Set(
      references.flatMap((reference) =>
        reference.includes('/')
          ? [reference]
          : catalog
              .filter((file) => assetReferenceMatches(reference, file.path))
              .map((file) => file.path),
      ),
    ),
  ]
  const invalidated: string[] = []
  for (const path of paths) {
    if (localOcrAssetTypeFor(path) === null) continue
    const cached = await readAssetOcrState(path, generation)
    if (cached === null) continue
    if (cached.status === 'invalid') {
      invalidated.push(path)
      continue
    }
    if (changed === undefined) invalidated.push(path)
    let currentHash: string | null
    try {
      currentHash = await hashBytes(await readAssetForDevice(path, generation))
    } catch (cause) {
      if (
        isAppError(cause) &&
        (cause.kind === 'notFound' || cause.kind === 'traversal' || cause.kind === 'unsupported')
      )
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
