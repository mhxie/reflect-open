import {
  localImagesOnly,
  resolveNoXPost,
  resolveNoYouTubeVideo,
} from '@/editor/local-only-render.ts'
import { useXPostResolver, X_MEDIA_URL_PROTOCOLS } from '@/editor/use-x-post-resolver.ts'
import { resolveYouTubeVideo } from '@/editor/youtube-video-resolver.ts'
import { useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react'
import type {
  FileClickHandler,
  ImageUrlResolver,
  LinkClickHandler,
  WikiEmbedResolver,
} from '@meowdown/core'
import { MarkdownView, type NoteEmbedRenderer } from '@meowdown/react'
import { useOpenExternalLink } from '@/editor/open-external-link.ts'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'
import { cn } from '@/lib/utils.ts'

/**
 * A read-only rendering of note markdown via @meowdown/react's `<MarkdownView>`
 * in `hide` mark mode, so previews look exactly like the note would in the
 * editor (wiki-link chips, images, and headings included) but without mounting a
 * ProseMirror editor. The view is never editable, so this can render any note
 * (protected ones included) without ever writing.
 *
 * `content` is live: changing it re-renders the preview, so one mounted preview
 * can follow a moving selection (the palette's preview pane).
 */

interface MarkdownPreviewProps {
  /** The markdown body to render (callers strip frontmatter first). */
  content: string
  /** Demote displayed headings for an embedded source without rewriting its Markdown. */
  headingOffset?: number
  /**
   * Resolve `![…](…)` sources to displayable URLs, possibly later; unresolved
   * images are skipped. Pass a stable function.
   */
  resolveImageUrl?: ImageUrlResolver
  /**
   * Classify Obsidian `![[target]]` embeds (images, file pills, note chips);
   * omitted, embeds stay literal text. Pass a stable function.
   */
  resolveWikiEmbed?: WikiEmbedResolver
  /** Render standalone note embeds through the source note's read-only reader. */
  renderNoteEmbed?: NoteEmbedRenderer
  /**
   * Navigate a clicked `[[wiki link]]` target. Omitted, links render as
   * inert chips (the palette preview's behavior). `event` carries the
   * originating click so handlers can honor ⌘-click (open in new window).
   */
  onWikiLinkClick?: (options: { target: string; openInNewWindow: boolean }) => void
  /** Override link activation for a source-aware reading surface. */
  onLinkClick?: LinkClickHandler
  /** Open a file pill through the source note's attachment resolver. */
  onFileClick?: FileClickHandler
  /**
   * Whether rendered links, images, and task checkboxes can be activated
   * (default true). A passive preview renders no anchors, focusable controls,
   * or remote embeds.
   */
  interactive?: boolean
  /**
   * Whether the content may reach the network to render (default true): X
   * post and YouTube embed lookups, saved embed snapshots (a YouTube card
   * loads its thumbnail), and remote images. Off for content from a private
   * note — embeds show their source URLs (Meowdown's `remoteMedia`) and only
   * graph attachments load.
   */
  remoteEmbeds?: boolean
  /** Extra classes for the rendered root. */
  className?: string
}

export function MarkdownPreview({
  content,
  headingOffset = 0,
  resolveImageUrl,
  resolveWikiEmbed,
  renderNoteEmbed,
  onWikiLinkClick,
  onLinkClick,
  onFileClick,
  interactive = true,
  remoteEmbeds = true,
  className,
}: MarkdownPreviewProps): ReactElement {
  const openExternalLink = useOpenExternalLink()
  // The click handler is read through a ref so a changing prop never gives
  // MarkdownView a new callback identity (which would re-render its whole
  // tree).
  const graphXPostResolver = useXPostResolver()
  const resolveXPost = remoteEmbeds ? graphXPostResolver : resolveNoXPost
  const imageResolver = useMemo(
    () => (remoteEmbeds ? resolveImageUrl : localImagesOnly(resolveImageUrl)),
    [remoteEmbeds, resolveImageUrl],
  )
  const navigateRef = useRef(onWikiLinkClick)
  useEffect(() => {
    navigateRef.current = onWikiLinkClick
  })

  // Hosts either always pass the handler (chat) or never do (palette
  // preview), and a passive preview forces links inert either way. An inert
  // preview omits the handler so a chip click is a no-op rather than a dead
  // navigation.
  const navigates = interactive && onWikiLinkClick != null

  const onWikilinkClickStable = useCallback(
    (payload: { target: string; event: MouseEvent | KeyboardEvent; mod: boolean }) =>
      navigateRef.current?.({ target: payload.target, openInNewWindow: payload.mod }),
    [],
  )

  return (
    <MarkdownView
      resolveXPost={resolveXPost}
      resolveYouTubeVideo={remoteEmbeds ? resolveYouTubeVideo : resolveNoYouTubeVideo}
      mediaUrlProtocols={X_MEDIA_URL_PROTOCOLS}
      remoteMedia={remoteEmbeds}
      markdown={content}
      headingOffset={headingOffset}
      markMode="hide"
      interactive={interactive}
      resolveWikilink={resolveWikilink}
      {...(imageResolver !== undefined ? { resolveImageUrl: imageResolver } : {})}
      {...(resolveWikiEmbed !== undefined ? { resolveWikiEmbed } : {})}
      {...(renderNoteEmbed !== undefined ? { renderNoteEmbed } : {})}
      {...(interactive ? { onLinkClick: onLinkClick ?? openExternalLink } : {})}
      {...(interactive && onFileClick !== undefined ? { onFileClick } : {})}
      {...(navigates ? { onWikilinkClick: onWikilinkClickStable } : {})}
      className={cn('reflect-editor', className)}
    />
  )
}
