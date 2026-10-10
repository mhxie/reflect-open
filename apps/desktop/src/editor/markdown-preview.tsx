import {
  localImagesOnly,
  resolveNoXPost,
  resolveNoYouTubeVideo,
} from '@/editor/local-only-render.ts'
import { useXPostResolver, X_MEDIA_URL_PROTOCOLS } from '@/editor/use-x-post-resolver.ts'
import { resolveYouTubeVideo } from '@/editor/youtube-video-resolver.ts'
import { createElement, useCallback, useEffect, useMemo, useRef, type ReactElement } from 'react'
import type { NoteTitleMetadata } from '@reflect/core'
import { NoteTitle } from '@/components/note-title.tsx'
import type {
  FileClickHandler,
  ImageUrlResolver,
  LinkClickHandler,
  WikiEmbedResolver,
} from '@meowdown/core'
import { MarkdownView, type MarkdownBlockRenderer, type NoteEmbedRenderer } from '@meowdown/react'
import { useOpenExternalLink } from '@/editor/open-external-link.ts'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'
import { cn } from '@/lib/utils.ts'
import { todayIso } from '@/lib/dates.ts'
import {
  readWikiEvidenceNode,
  readWikiSourceLinkPair,
} from '@/editor/wiki-anchors/wiki-evidence.ts'
import { WikiEvidencePreview } from '@/editor/wiki-anchors/wiki-evidence-preview.tsx'
import { createWikiArticleProjectionReader } from '@/editor/wiki-anchors/wiki-article-projection.ts'
import { renderWikiArticleBlock } from '@/editor/wiki-anchors/wiki-article-preview.tsx'
import { useWikiArticleIdentities } from '@/editor/wiki-anchors/use-wiki-article-identities.ts'

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
  titleMetadata?: NoteTitleMetadata | undefined
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
  /**
   * Render `content` as one paragraph of inline Markdown. A block prefix at
   * the start (`+ [ ] `, `# `, `> `) stays text instead of opening a block.
   * Task rows pass this: their content is one paragraph by definition.
   */
  singleParagraph?: boolean
  /** Extra classes for the rendered root. */
  className?: string
  /** Reveal exact claim extents without changing the source document. */
  showClaimRanges?: boolean
  /** Render one exact claim in the full Markdown context, retaining enclosing formatting. */
  claimFragment?: string | undefined
}

export function MarkdownPreview({
  content,
  titleMetadata,
  headingOffset = 0,
  singleParagraph = false,
  resolveImageUrl,
  resolveWikiEmbed,
  renderNoteEmbed,
  onWikiLinkClick,
  onLinkClick,
  onFileClick,
  interactive = true,
  remoteEmbeds = true,
  className,
  showClaimRanges = false,
  claimFragment,
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
  const noteIdentity = useWikiArticleIdentities(content)
  // Article blocks read the whole document (citation numbers, claim ranges),
  // which MarkdownView's per-block memo does not compare. `source` ties the
  // reader, and so renderBlock, to the document; the React Compiler ignores
  // the deps list, so without it article blocks would go stale.
  const articleReader = useMemo(
    () => ({ source: content, project: createWikiArticleProjectionReader({ noteIdentity }) }),
    [noteIdentity, content],
  )
  const renderBlock = useCallback<MarkdownBlockRenderer>(
    (context) => {
      const {
        node,
        doc,
        previousSibling,
        nextSibling,
        renderDefault,
        interactive: blockInteractive,
      } = context
      if (
        claimFragment === undefined &&
        node === doc.firstChild &&
        node.type.name === 'heading' &&
        node.attrs.level === 1 &&
        (titleMetadata?.displayTitle || titleMetadata?.lang)
      ) {
        return createElement(
          `h${Math.min(6, 1 + headingOffset)}`,
          {},
          <NoteTitle title={node.textContent} {...titleMetadata} wrap />,
        )
      }
      const asOf = todayIso()
      const projection = articleReader.project(doc, asOf)
      const article = renderWikiArticleBlock(
        context,
        projection,
        {
          interactive: blockInteractive,
          openUrl: (href, event) =>
            (onLinkClick ?? openExternalLink)({ href, event, mod: event.metaKey || event.ctrlKey }),
          ...(navigates ? { openWikiLink: (options) => navigateRef.current?.(options) } : {}),
        },
        showClaimRanges,
        claimFragment,
      )
      if (article !== undefined) return article
      const cluster = readWikiSourceLinkPair(node, nextSibling, asOf)
      if (cluster !== null) return renderDefault(node.content.cut(0, cluster.from))
      const block =
        readWikiSourceLinkPair(previousSibling, node, asOf)?.block ??
        readWikiEvidenceNode(node, asOf)
      if (block === null) return
      return (
        <WikiEvidencePreview
          block={block}
          raw={node.textContent}
          options={{
            interactive: blockInteractive,
            openUrl: (href, event) =>
              (onLinkClick ?? openExternalLink)({
                href,
                event,
                mod: event.metaKey || event.ctrlKey,
              }),
            ...(navigates ? { openWikiLink: (options) => navigateRef.current?.(options) } : {}),
          }}
        />
      )
    },
    [
      navigates,
      onLinkClick,
      openExternalLink,
      articleReader,
      showClaimRanges,
      claimFragment,
      titleMetadata,
      headingOffset,
    ],
  )

  return (
    <MarkdownView
      resolveXPost={resolveXPost}
      resolveYouTubeVideo={remoteEmbeds ? resolveYouTubeVideo : resolveNoYouTubeVideo}
      mediaUrlProtocols={X_MEDIA_URL_PROTOCOLS}
      remoteMedia={remoteEmbeds}
      markdown={content}
      headingOffset={headingOffset}
      singleParagraph={singleParagraph}
      markMode="hide"
      interactive={interactive}
      resolveWikilink={resolveWikilink}
      renderBlock={renderBlock}
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
