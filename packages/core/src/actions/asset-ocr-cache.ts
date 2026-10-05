import { z } from 'zod'
import { isAppError } from '../errors.ts'
import { listAssetOcrCacheKeys, readAssetOcrCache, writeAssetOcrCache } from '../graph/commands.ts'
import { hashContent } from '../indexing/hash.ts'

/** Maximum complete OCR text stored for one attachment. */
export const MAX_LOCAL_OCR_CHARS = 200_000

/** Local, rebuildable OCR provenance. Only whole successful results are stored. */
export const assetOcrCacheSchema = z.object({
  version: z.literal(1),
  status: z.literal('complete'),
  deviceOnly: z.literal(true),
  assetPath: z.string(),
  sourceHash: z.string().regex(/^[a-f\d]{64}$/u),
  sourceSize: z.number().int().nonnegative(),
  providerId: z.string(),
  model: z.string(),
  baseUrl: z.string(),
  pages: z.number().int().positive(),
  generatedAt: z.iso.datetime(),
  body: z.string().min(1).max(MAX_LOCAL_OCR_CHARS),
})

/** One complete image/PDF OCR result stored only on this device. */
export type AssetOcrCache = z.infer<typeof assetOcrCacheSchema>
const invalidCacheSchema = z.object({
  version: z.literal(1),
  status: z.literal('invalid'),
  deviceOnly: z.literal(true),
  assetPath: z.string(),
})
const cacheStateSchema = z.union([assetOcrCacheSchema, invalidCacheSchema])
/** Complete OCR or a sticky device-only invalidation marker. */
export type AssetOcrState = z.infer<typeof cacheStateSchema>

/** Read validated OCR for an exact asset path; malformed or missing cache is a miss. */
export async function readLocalAssetOcr(
  assetPath: string,
  generation?: number,
): Promise<AssetOcrCache | null> {
  const state = await readAssetOcrState(assetPath, generation)
  return state?.status === 'complete' ? state : null
}

/** Read local provenance, including invalidation markers that block old managed sidecars. */
export async function readAssetOcrState(
  assetPath: string,
  generation?: number,
): Promise<AssetOcrState | null> {
  let contents: string
  try {
    contents = await readAssetOcrCache(await hashContent(assetPath), generation)
  } catch (cause) {
    if (isAppError(cause) && (cause.kind === 'notFound' || cause.kind === 'traversal')) {
      return null
    }
    throw cause
  }
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch {
    return null
  }
  const parsed = cacheStateSchema.safeParse(value)
  return parsed.success && parsed.data.assetPath === assetPath ? parsed.data : null
}

/** Invalidate stale OCR while retaining its device-only provenance. */
export async function invalidateLocalAssetOcr(
  assetPath: string,
  generation: number,
): Promise<void> {
  await writeAssetOcrCache(
    await hashContent(assetPath),
    JSON.stringify({ version: 1, status: 'invalid', deviceOnly: true, assetPath }),
    generation,
  )
}

/** Recover complete and invalid cache source paths, including deleted attachments. */
export async function cachedAssetOcrPaths(generation: number): Promise<string[]> {
  const paths: string[] = []
  for (const key of await listAssetOcrCacheKeys(generation)) {
    let contents: string
    try {
      contents = await readAssetOcrCache(key, generation)
    } catch (cause) {
      if (isAppError(cause) && cause.kind === 'notFound') continue
      throw cause
    }
    let value: unknown
    try {
      value = JSON.parse(contents)
    } catch {
      continue
    }
    const parsed = cacheStateSchema.safeParse(value)
    if (parsed.success && (await hashContent(parsed.data.assetPath)) === key)
      paths.push(parsed.data.assetPath)
  }
  return paths
}

/** Persist a validated complete result with a generation-pinned atomic write. */
export async function writeLocalAssetOcr(cache: AssetOcrCache, generation: number): Promise<void> {
  const validated = assetOcrCacheSchema.parse(cache)
  await writeAssetOcrCache(
    await hashContent(cache.assetPath),
    JSON.stringify(validated),
    generation,
  )
}
