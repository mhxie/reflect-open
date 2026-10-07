import { useCallback, type ReactNode } from 'react'
import type { ImageUrlResolver, WikilinkHoverHit } from '@meowdown/core'
import {
  isLocalOnlyPath,
  notePrivate,
  parseFrontmatter,
  parseNote,
  resolveExistingWikiTarget,
  splitFrontmatter,
  splitWikiLinkTarget,
  findWikiClaim,
  readWikiArticle,
  wikiClaimId,
  type DateFormat,
} from '@reflect/core'
import { WikiLinkHoverPreview } from '@/components/wiki-link-hover-preview.tsx'
import { createNoteAttachments } from '@/editor/use-note-attachments.ts'
import { readExistingNoteSource } from '@/lib/read-existing-note-source.ts'
import { todayIso } from '@/lib/dates.ts'

interface WikiLinkHoverPreviewOptions {
  generation: number | null
  graphKey: string | null
  dateFormat: DateFormat
}

function isSvgAsset(path: string): boolean {
  return path.toLowerCase().endsWith('.svg')
}

function previewRasterUrl(url: string): string {
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}reflect-preview=raster`
}

/**
 * The passive card's image resolver for the note at `notePath`: local
 * raster attachments only, resolved from that note's own folder. Remote
 * images and SVGs never load in a hover card.
 */
function passiveImageResolver(generation: number, notePath: string): ImageUrlResolver {
  const { resolveAttachmentPath, resolveImageUrl } = createNoteAttachments(generation, notePath)
  return async (source) => {
    const assetPath = resolveAttachmentPath(source)
    // SVG can contain external subresource references. The filename check
    // avoids an unnecessary request; the query also makes the asset protocol
    // enforce a sniffed raster MIME allowlist, so renamed SVG bytes cannot
    // bypass the passive card's no-network boundary.
    if (assetPath === null || isSvgAsset(assetPath)) {
      return
    }
    const url = await resolveImageUrl(source)
    return url === undefined ? undefined : previewRasterUrl(url)
  }
}

/**
 * Build the async body resolver for Meowdown's editor-scoped wiki-link hover
 * card. The whole preview is decided inside the returned promise: an existing
 * target resolves to a passive snapshot body; missing, ambiguous, unavailable,
 * and failed targets resolve to `null`, which renders no card. Failures are
 * swallowed into `null` rather than rejected: transient read errors (an iCloud
 * eviction, a graph switch) are expected and should not log as errors.
 */
export function useWikiLinkHoverPreview({
  generation,
  graphKey,
  dateFormat,
}: WikiLinkHoverPreviewOptions): (hit: WikilinkHoverHit) => Promise<ReactNode> {
  return useCallback(
    async ({ target }: WikilinkHoverHit): Promise<ReactNode> => {
      if (generation === null || graphKey === null) {
        return null
      }
      try {
        const resolution = await resolveExistingWikiTarget(target, generation)
        if (resolution.kind !== 'resolved') {
          return null
        }
        const source = await readExistingNoteSource(resolution.path, generation)
        const { fragment } = splitWikiLinkTarget(target)
        const parts = splitFrontmatter(source)
        const frontmatter = parseFrontmatter(parts.raw).data
        const markdown = parts.body
        let sourceTitle: string | undefined
        let claimFragment: string | undefined
        if (fragment !== null && wikiClaimId(fragment) !== null) {
          const index = readWikiArticle(source, todayIso())
          const claim = findWikiClaim(index, fragment)
          if (claim === null) return null
          sourceTitle = parseNote({ path: resolution.path, source }).title
          claimFragment = fragment
        }
        return (
          <WikiLinkHoverPreview
            path={resolution.path}
            markdown={markdown}
            titleMetadata={{ displayTitle: frontmatter.display_title, lang: frontmatter.lang }}
            sourceTitle={sourceTitle}
            claimFragment={claimFragment}
            privateNote={isLocalOnlyPath(resolution.path) || notePrivate(source)}
            dateFormat={dateFormat}
            resolveImageUrl={passiveImageResolver(generation, resolution.path)}
            resolveWikiEmbed={createNoteAttachments(generation, resolution.path).resolveWikiEmbed}
          />
        )
      } catch {
        return null
      }
    },
    [dateFormat, generation, graphKey],
  )
}
