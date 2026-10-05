import type { ReactElement } from 'react'
import type { ImageUrlResolver, WikiEmbedResolver } from '@meowdown/core'
import { dateFromDailyPath, type DateFormat } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { usePreviewOverflow } from '@/hooks/use-preview-overflow.ts'
import { formatDayLabel } from '@/lib/dates.ts'
import { cn } from '@/lib/utils.ts'

interface WikiLinkHoverPreviewProps {
  path: string
  /** The note body with frontmatter already stripped. */
  markdown: string
  /**
   * Whether the target note is private (locked, unreadable, or local-only):
   * its body then renders with no remote media at all.
   */
  privateNote: boolean
  dateFormat: DateFormat
  resolveImageUrl: ImageUrlResolver
  /** Classify the note's `![[embeds]]`, resolved from its own folder. */
  resolveWikiEmbed?: WikiEmbedResolver
}

/**
 * Reflect's passive body for Meowdown's wiki-link hover card. Meowdown owns
 * the card chrome, sizing, and lifecycle; this renders only the content, from
 * a snapshot read at hover time. The `reflect-hover-preview` class re-scales
 * the editor type ramp to the card's compact size (styles/index.css), and a
 * body taller than the card fades out at the bottom edge instead of clipping
 * mid-line.
 */
export function WikiLinkHoverPreview({
  path,
  markdown,
  privateNote,
  dateFormat,
  resolveImageUrl,
  resolveWikiEmbed,
}: WikiLinkHoverPreviewProps): ReactElement {
  const dailyDate = dateFromDailyPath(path)
  const empty = markdown.trim().length === 0
  const { setRoot, overflowing } = usePreviewOverflow()

  return (
    <div
      ref={setRoot}
      className={cn(
        'reflect-hover-preview max-h-48 overflow-hidden px-3.5 py-3 text-xs text-popover-foreground',
        overflowing && 'reflect-hover-preview-overflowing',
      )}
      data-testid="wiki-link-hover-preview"
    >
      <div>
        {dailyDate !== null ? (
          <div className="reflect-daily-subject mb-1">{formatDayLabel(dailyDate, dateFormat)}</div>
        ) : null}
        {empty ? (
          <p className="text-text-muted italic">Empty note</p>
        ) : (
          <MarkdownPreview
            content={markdown}
            resolveImageUrl={resolveImageUrl}
            {...(resolveWikiEmbed !== undefined ? { resolveWikiEmbed } : {})}
            interactive={false}
            // A passive card already renders no embed and only local raster
            // images; a private target is kept off the network regardless.
            remoteEmbeds={!privateNote}
            className="text-xs leading-relaxed"
          />
        )}
      </div>
    </div>
  )
}
