import { z } from 'zod'
import { sha256Hex } from '@reflect/utils'
import { isAppError } from '../errors.ts'
import type { AssetStoreService } from '../graph/asset-store-service.ts'

/**
 * The device-only OCR cache of attachments (`.reflect/asset-ocr/`): one entry
 * per attachment path, keyed by the path's SHA-256, holding a complete OCR
 * result of a verified on-device model or a sticky invalidation marker. It is
 * rebuildable, never synced, and never sent anywhere; the local index folds
 * its text into search, and the AI tools read it only behind their own gates.
 */

/**
 * Maximum complete OCR text stored for one attachment.
 */
export const MAX_LOCAL_OCR_CHARS = 200_000

/**
 * Local, rebuildable OCR provenance. Only whole successful results are stored.
 */
export const assetOcrCacheSchema = z.object({
  version: z.literal(1),
  status: z.literal('complete'),
  deviceOnly: z.literal(true),
  assetPath: z.string(),
  sourceHash: z.string().regex(/^[a-f\d]{64}$/u),
  sourceSize: z.number().int().nonnegative(),
  /**
   * The source's modification time (epoch ms) as listed before its bytes
   * were read; lets a wake scan skip re-hashing an untouched file. Absent in
   * entries written before it existed, which are always re-hashed.
   */
  sourceModifiedMs: z.number().nonnegative().optional(),
  providerId: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  pages: z.number().int().positive(),
  generatedAt: z.iso.datetime(),
  body: z.string().min(1).max(MAX_LOCAL_OCR_CHARS),
})

/**
 * One complete image/PDF OCR result stored only on this device.
 */
export type AssetOcrCache = z.infer<typeof assetOcrCacheSchema>

const invalidCacheSchema = z.object({
  version: z.literal(1),
  status: z.literal('invalid'),
  deviceOnly: z.literal(true),
  assetPath: z.string(),
})

const cacheStateSchema = z.union([assetOcrCacheSchema, invalidCacheSchema])

/**
 * Complete OCR or a sticky device-only invalidation marker.
 */
export type AssetOcrState = z.infer<typeof cacheStateSchema>

/**
 * A cache file's state, or null when it is not JSON or not a known state.
 */
function parseCacheState(contents: string): AssetOcrState | null {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    return null
  }
  const parsed = cacheStateSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * Validated OCR for an exact asset path; a malformed or missing entry is a miss.
 */
export async function readLocalAssetOcr(
  assetStore: AssetStoreService,
  assetPath: string,
  generation: number,
): Promise<AssetOcrCache | null> {
  const state = await readAssetOcrState(assetStore, assetPath, generation)
  return state?.status === 'complete' ? state : null
}

/**
 * The local provenance of an asset path, including the invalidation markers
 * that block old managed sidecars; a missing, malformed or other-path entry
 * is `null`.
 */
export async function readAssetOcrState(
  assetStore: AssetStoreService,
  assetPath: string,
  generation: number,
): Promise<AssetOcrState | null> {
  let contents: string
  try {
    contents = await assetStore.readOcrCache(await sha256Hex(assetPath), generation)
  } catch (cause) {
    if (isAppError(cause) && (cause.kind === 'notFound' || cause.kind === 'traversal')) {
      return null
    }
    throw cause
  }
  const state = parseCacheState(contents)
  return state?.assetPath === assetPath ? state : null
}

/**
 * Invalidate stale OCR while retaining its device-only provenance.
 */
export async function invalidateLocalAssetOcr(
  assetStore: AssetStoreService,
  assetPath: string,
  generation: number,
): Promise<void> {
  await assetStore.writeOcrCache(
    await sha256Hex(assetPath),
    JSON.stringify({ version: 1, status: 'invalid', deviceOnly: true, assetPath }),
    generation,
  )
}

/**
 * The source paths of every complete and invalid entry, including deleted attachments.
 */
export async function cachedAssetOcrPaths(
  assetStore: AssetStoreService,
  generation: number,
): Promise<string[]> {
  const paths: string[] = []
  for (const key of await assetStore.listOcrCacheKeys(generation)) {
    let contents: string
    try {
      contents = await assetStore.readOcrCache(key, generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') {
        continue
      }
      throw cause
    }
    const state = parseCacheState(contents)
    if (state !== null && (await sha256Hex(state.assetPath)) === key) {
      paths.push(state.assetPath)
    }
  }
  return paths
}

/**
 * Persist a validated complete result with a generation-pinned atomic write.
 */
export async function writeLocalAssetOcr(
  assetStore: AssetStoreService,
  cache: AssetOcrCache,
  generation: number,
): Promise<void> {
  const validated = assetOcrCacheSchema.parse(cache)
  await assetStore.writeOcrCache(
    await sha256Hex(cache.assetPath),
    JSON.stringify(validated),
    generation,
  )
}
