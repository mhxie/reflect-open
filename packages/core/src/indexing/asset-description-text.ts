import { isAppError } from '../errors.ts'
import { readNoteLocal, listAttachments } from '../graph/commands.ts'
import { createAttachmentCatalog, resolveAttachmentLink } from '../graph/attachment-resolution.ts'
import { isLocalOnlyPath } from '../graph/local-only.ts'
import { descriptionPathFor } from '../graph/paths.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { notePrivate } from '../privacy/checkers.ts'
import { readAssetOcrState } from '../actions/asset-ocr-cache.ts'
import { readManagedDescription } from '../actions/asset-description-helpers.ts'

/**
 * Folding asset descriptions into a note's search text (Plan 20, search
 * integration). A note's referenced assets each may have a description file
 * (`<asset>.reflect.md`); their bodies are appended to the note's FTS document
 * so a query matching a description surfaces the note — transparently, as an
 * ordinary hit. The same bodies feed the note's embedding chunks (the semantic
 * leg), so lexical and semantic retrieval see the same asset text. It never
 * enters the All-Notes preview or the note *content* AI reads — chat reaches
 * description text solely through the read_assets tool
 * (`ai/chat/read-assets.ts`), behind its own live privacy gate.
 */

/** Cap on folded description text per note (chars) — bounds the FTS document. */
export const MAX_ASSET_TEXT_CHARS = 8_000

/** One asset's description body, attributed to the asset it describes. */
export interface AssetDescriptionBody {
  /** Graph-relative asset path (`assets/x.png`), not the description path. */
  assetPath: string
  /** The description file's body, frontmatter stripped and trimmed. */
  body: string
  /** The text must stay on this device, even if its referencing note is public. */
  deviceOnly?: boolean
}

/** What {@link gatherAssetDescriptionBodies} could (and could not) read. */
export interface AssetDescriptionGather {
  /** The readable description bodies, in reference order. */
  bodies: readonly AssetDescriptionBody[]
  /**
   * Asset paths whose description file exists but is iCloud-evicted —
   * unreadable without forcing an on-demand download. Consumers that
   * *replace* stored derivations (the embedding pipeline's full chunk-set
   * apply) must skip the write entirely when this is non-empty, or the
   * evicted sidecar's previously indexed chunks are silently dropped.
   */
  evicted: readonly string[]
}

/** Join gathered attachment bodies in reference order within the search-text budget. */
export function foldAssetDescriptionBodies(bodies: readonly AssetDescriptionBody[]): string {
  return bodies
    .map((entry) => entry.body)
    .join('\n\n')
    .slice(0, MAX_ASSET_TEXT_CHARS)
}

/**
 * The per-asset description bodies for a note's referenced assets. Reads any
 * `<asset>.reflect.md` that exists (managed or user-authored — it is the
 * user's content about the asset) and strips frontmatter. Missing files and
 * empty bodies are skipped; an iCloud-evicted sidecar is reported in
 * `evicted` instead of being read (a read would block on an on-demand
 * download mid-pass); a repeated asset contributes once. Accumulation stops
 * once the combined length reaches {@link MAX_ASSET_TEXT_CHARS} (the body
 * that crosses the cap is kept whole — consumers apply their own final cap).
 * Local OCR and private/local-only sidecars are folded with device-only
 * provenance; cloud retrieval drops the resulting restricted hit. Reads are
 * unpinned, matching the indexer's note reads; its generation-pinned write
 * drops the stale row if the graph switches.
 */
export async function gatherAssetDescriptionBodies(
  assetPaths: readonly string[],
  notePath = '',
): Promise<AssetDescriptionGather> {
  const bodies: AssetDescriptionBody[] = []
  const evicted: string[] = []
  if (assetPaths.length === 0) {
    return { bodies, evicted }
  }
  const seen = new Set<string>()
  let total = 0
  const catalog = assetPaths.some((path) => !path.includes('/'))
    ? createAttachmentCatalog(await listAttachments())
    : null
  for (const reference of assetPaths) {
    const resolved =
      !reference.includes('/') && catalog !== null
        ? resolveAttachmentLink(notePath, reference, catalog)
        : null
    const assetPath = resolved ?? reference
    if (seen.has(assetPath)) {
      continue // an asset referenced twice in one note contributes once
    }
    seen.add(assetPath)
    const cacheState = await readAssetOcrState(assetPath)
    const cached = cacheState?.status === 'complete' ? cacheState : null
    let read: Awaited<ReturnType<typeof readNoteLocal>>
    try {
      read = await readNoteLocal(descriptionPathFor(assetPath))
    } catch (cause) {
      // No description for this asset: not generated yet, or none. An asset
      // behind a symlink that leaves the graph is refused as traversal; it
      // cannot have a readable description either, and one such reference
      // must not abort the whole index pass.
      if (isAppError(cause) && (cause.kind === 'notFound' || cause.kind === 'traversal')) {
        if (cached !== null) {
          bodies.push({ assetPath, body: cached.body, deviceOnly: true })
          total += cached.body.length
          if (total >= MAX_ASSET_TEXT_CHARS) {
            break
          }
        }
        continue
      }
      throw cause
    }
    if (read.kind === 'evicted') {
      evicted.push(assetPath)
      continue
    }
    if (cacheState?.status === 'invalid' && readManagedDescription(read.content) !== null) {
      continue
    }
    if (cached !== null && readManagedDescription(read.content) !== null) {
      bodies.push({ assetPath, body: cached.body, deviceOnly: true })
      total += cached.body.length
      if (total >= MAX_ASSET_TEXT_CHARS) {
        break
      }
      continue
    }
    const body = splitFrontmatter(read.content).body.trim()
    if (body === '') {
      continue
    }
    bodies.push({
      assetPath,
      body,
      ...(read.localOnly || isLocalOnlyPath(assetPath) || notePrivate(read.content)
        ? { deviceOnly: true }
        : {}),
    })
    total += body.length
    if (total >= MAX_ASSET_TEXT_CHARS) {
      break
    }
  }
  return { bodies, evicted }
}

/**
 * The combined body text of a note's assets' description files, for folding
 * into its search index — {@link gatherAssetDescriptionBodies} joined and
 * capped at {@link MAX_ASSET_TEXT_CHARS}. An evicted sidecar's body is simply
 * absent here: the FTS document is rebuilt from the note file whenever the
 * note changes, so the fold catches up once the sidecar is local again —
 * unlike the embedding pipeline, nothing previously stored is destroyed.
 */
export async function gatherAssetDescriptionText(assetPaths: readonly string[]): Promise<string> {
  const { bodies } = await gatherAssetDescriptionBodies(assetPaths)
  return foldAssetDescriptionBodies(bodies)
}
