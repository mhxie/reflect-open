import {
  resolveNoXPost,
  resolveNoYouTubeVideo,
  withoutEmbedSnapshots,
} from '@/editor/local-only-render.ts'
import { useXPostResolver, X_MEDIA_URL_PROTOCOLS } from '@/editor/use-x-post-resolver.ts'
import { resolveYouTubeVideo } from '@/editor/youtube-video-resolver.ts'
import { useCallback, useMemo, type ReactElement } from 'react'
import { MarkdownView } from '@meowdown/react'
import type { WikilinkClickHandler } from '@meowdown/core'
import { isLocalOnlyPath, type SnippetTask } from '@reflect/core'
import { useOpenExternalLink } from '@/editor/open-external-link.ts'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'
import { useNoteAttachments } from '@/editor/use-note-attachments.ts'
import type { BacklinkWikilinkClick } from '@/hooks/use-backlink-navigation.ts'
import { useSnippetTaskToggle } from '@/hooks/use-snippet-task-toggle.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

interface BacklinkSnippetProps {
  /** The referencing block context's Markdown source (may span several lines). */
  text: string
  /** Graph-relative path of the source note the snippet was read from. */
  notePath: string
  /** The snippet's checkbox tasks anchored to the source note (query-provided). */
  tasks: SnippetTask[]
  /**
   * Navigate a clicked `[[wiki link]]` to its target; receives this
   * snippet's `notePath` as the source. Pass a stable function.
   */
  onWikilinkClick: BacklinkWikilinkClick
}

/**
 * One reference in the incoming-backlinks panel, rendered as rich text through
 * meowdown's editor-free `MarkdownView`: wiki links become the editor's
 * clickable chips and inline marks render instead of raw `[[…]]` / `**…**`
 * source. The context is a whole block (old Reflect's rules — a paragraph, the
 * containing list item with its children, or a heading's section), so it
 * renders unclamped: truncating would cut the nested structure the context
 * exists to show. The source's fold state must not hide it either:
 * `expandCollapsed` renders `+` collapsed items expanded at every depth.
 * Round `+ [ ]` task checkboxes are live — a click writes the
 * toggle through to the source note ({@link useSnippetTaskToggle}), old
 * Reflect's backlink-context behavior — while square GFM boxes stay read-only
 * (the `reflect-backlink-snippet` CSS keeps them inert-looking). Images and
 * `![[embeds]]` resolve from the source note's folder, as in its editor. The
 * `reflect-editor` class shares the editor's chip styling; the
 * `reflect-backlink-snippet` wrapper keeps it in the panel's compact line box.
 * A snippet from a local-only note renders without network embeds or their
 * saved snapshots (its images resolve local-only through
 * `createNoteAttachments`), and its checkboxes stay inert: the source note is
 * read-only.
 */
export function BacklinkSnippet({
  text,
  notePath,
  tasks,
  onWikilinkClick,
}: BacklinkSnippetProps): ReactElement {
  const generation = useGraph({ optional: true })?.graph?.generation ?? null
  const { resolveImageUrl, resolveWikiEmbed } = useNoteAttachments(generation, notePath)
  const graphXPostResolver = useXPostResolver()
  const onTaskClick = useSnippetTaskToggle(notePath, tasks)
  const openExternalLink = useOpenExternalLink()
  const localOnly = isLocalOnlyPath(notePath)
  const handleWikilinkClick = useCallback<WikilinkClickHandler>(
    (payload) => onWikilinkClick(payload, notePath),
    [onWikilinkClick, notePath],
  )
  const markdown = useMemo(
    () => (localOnly ? withoutEmbedSnapshots(text) : text),
    [localOnly, text],
  )
  return (
    <div className="reflect-backlink-snippet select-text text-xs text-text">
      <MarkdownView
        resolveXPost={localOnly ? resolveNoXPost : graphXPostResolver}
        resolveYouTubeVideo={localOnly ? resolveNoYouTubeVideo : resolveYouTubeVideo}
        mediaUrlProtocols={X_MEDIA_URL_PROTOCOLS}
        className="reflect-editor"
        markdown={markdown}
        expandCollapsed
        resolveWikilink={resolveWikilink}
        onWikilinkClick={handleWikilinkClick}
        onLinkClick={openExternalLink}
        {...(onTaskClick ? { onTaskClick } : {})}
        resolveImageUrl={resolveImageUrl}
        resolveWikiEmbed={resolveWikiEmbed}
      />
    </div>
  )
}
