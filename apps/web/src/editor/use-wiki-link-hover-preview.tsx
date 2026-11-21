import { useCallback, type ReactNode } from 'react'
import type { WikilinkHoverHit } from '@meowdown/core'
import {
  findWikiClaim,
  parseNote,
  readWikiArticle,
  splitWikiLinkTarget,
  wikiClaimId,
  type DateFormat,
} from '@reflect/core'
import { WikiLinkHoverPreview } from '@/components/wiki-link-hover-preview.tsx'
import { getIsoToday } from '@reflect/utils'
import { useCoreServices } from '@/services/services-provider.tsx'

interface WikiLinkHoverPreviewOptions {
  dateFormat: DateFormat
}

/**
 * Build the async body resolver for Meowdown's editor-scoped wiki-link hover
 * card. The whole preview is decided inside the returned promise: an existing
 * target resolves to a passive snapshot body; missing, ambiguous, unavailable,
 * and failed targets resolve to `null`, which renders no card (see
 * `NotePreviewService.previewWikiTarget`). A link to a wiki claim
 * (`[[Entry#^c3]]`) previews that claim under its article's title, and no
 * card while the article no longer holds it.
 */
export function useWikiLinkHoverPreview({
  dateFormat,
}: WikiLinkHoverPreviewOptions): (hit: WikilinkHoverHit) => Promise<ReactNode> {
  const { notePreview } = useCoreServices()
  return useCallback(
    async ({ target }: WikilinkHoverHit): Promise<ReactNode> => {
      const preview = await notePreview.previewWikiTarget(target)
      if (preview === null) {
        return null
      }
      const { fragment } = splitWikiLinkTarget(target)
      let sourceTitle: string | undefined
      let claimFragment: string | undefined
      if (fragment !== null && wikiClaimId(fragment) !== null) {
        const index = readWikiArticle(preview.source, getIsoToday())
        if (findWikiClaim(index, fragment) === null) {
          return null
        }
        sourceTitle = parseNote({ path: preview.path, source: preview.source }).title
        claimFragment = fragment
      }
      return (
        <WikiLinkHoverPreview
          path={preview.path}
          markdown={preview.markdown}
          titleMetadata={preview.titleMetadata}
          sourceTitle={sourceTitle}
          claimFragment={claimFragment}
          privateNote={preview.privateNote}
          dateFormat={dateFormat}
          resolveImageUrl={preview.resolveImageUrl}
          resolveWikiEmbed={({ target: embedTarget }) => preview.resolveWikiEmbed(embedTarget)}
        />
      )
    },
    [dateFormat, notePreview],
  )
}
