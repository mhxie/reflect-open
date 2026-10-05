import { classifyAssetFromNotes } from '../../actions/asset-privacy.ts'
import { readAssetOcrState } from '../../actions/asset-ocr-cache.ts'
import { descriptionPathFor } from '../../graph/paths.ts'
import { isLocalOnlyPath } from '../../graph/local-only.ts'
import { assetReferencingNotePaths } from '../../indexing/asset-refs.ts'
import { db } from '../../indexing/db.ts'
import { parseNote } from '../../markdown/extract.ts'
import { notePrivate } from '../../privacy/checkers.ts'
import { isAppError } from '../../errors.ts'
import { listAttachments } from '../../graph/commands.ts'
import { splitFrontmatter } from '../../markdown/frontmatter.ts'
import {
  foldAssetDescriptionBodies,
  type AssetDescriptionBody,
} from '../../indexing/asset-description-text.ts'
import { hashContent } from '../../indexing/hash.ts'
import {
  createAttachmentCatalog,
  resolveAttachmentLink,
} from '../../graph/attachment-resolution.ts'

/**
 * Whether a search snapshot may hold attachment text: false only when its
 * attachment-text hash is the empty text's. A missing hash (a snapshot from an
 * older build) counts as holding some, so callers fail closed.
 */
export async function snapshotHasAttachmentText(
  assetTextHash: string | undefined,
): Promise<boolean> {
  return assetTextHash === undefined || assetTextHash !== (await hashContent(''))
}

/** Recheck live and indexed asset references before exposing a search snapshot to a model. */
export async function hasRestrictedSearchSources(
  path: string,
  source: string,
  readNoteFn: (path: string) => Promise<string>,
  generation?: number,
  expectedAssetTextHash?: string,
): Promise<boolean> {
  const indexed = await db
    .selectFrom('assets')
    .where('notePath', '=', path)
    .select('assetPath')
    .execute()
  const liveReferences = parseNote({ path, source }).assets.map((asset) => asset.path)
  const references = [...new Set([...indexed.map((row) => row.assetPath), ...liveReferences])]
  const catalog = references.some((reference) => !reference.includes('/'))
    ? createAttachmentCatalog(await listAttachments(generation))
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
          ? [reference]
          : [
              resolveAttachmentLink(path, reference, catalog) ?? reference,
              ...(catalog?.named(reference) ?? []),
            ],
      ),
    ),
  ]
  const descriptions = new Map<string, string>()
  for (const assetPath of assetPaths) {
    if (isLocalOnlyPath(assetPath) || (await readAssetOcrState(assetPath, generation)) !== null)
      return true
    try {
      const description = await readNoteFn(descriptionPathFor(assetPath))
      if (notePrivate(description)) return true
      descriptions.set(assetPath, splitFrontmatter(description).body.trim())
    } catch (cause) {
      if (!isAppError(cause) || cause.kind !== 'notFound') return true
    }
    const candidates = await assetReferencingNotePaths(assetPath)
    if ((await classifyAssetFromNotes(assetPath, candidates, readNoteFn)) !== 'send') return true
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
  return (await hashContent(foldAssetDescriptionBodies(bodies))) !== expectedAssetTextHash
}
