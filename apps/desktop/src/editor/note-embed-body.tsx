import { useCallback, useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react'
import type { FileClickHandler, LinkClickHandler } from '@meowdown/core'
import type { NoteEmbedPayload, NoteEmbedRenderer } from '@meowdown/react'
import { errorMessage, notePrivate, splitFrontmatter } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { useNoteAttachments } from '@/editor/use-note-attachments.ts'
import { usePrivateNoteState } from '@/hooks/use-private-note.ts'
import { loadAttachmentCatalog } from '@/lib/attachment-catalog.ts'
import { openAttachment } from '@/lib/open-attachment.ts'
import { startOperation } from '@/lib/operations.ts'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard.ts'

interface NoteEmbedBodyProps {
  readonly source: string
  readonly sourcePath: string
  readonly headingOffset: number
  readonly generation: number | null
  readonly remoteEmbeds: boolean
  readonly renderNoteEmbed: (payload: NoteEmbedPayload, remoteEmbeds: boolean) => ReactNode
  readonly onWikiLinkClick: (options: { target: string; openInNewWindow: boolean }) => void
  readonly onLinkClick: LinkClickHandler
}

/** Only mounted after expansion; the source note's live privacy verdict also governs descendants. */
export function NoteEmbedBody({
  source,
  sourcePath,
  headingOffset,
  generation,
  remoteEmbeds,
  renderNoteEmbed,
  onWikiLinkClick,
  onLinkClick,
}: NoteEmbedBodyProps): ReactElement {
  const { privateNote, pending } = usePrivateNoteState(sourcePath, {
    sessionEpoch: null,
    privateHeader: notePrivate(source),
  })
  const allowRemote = remoteEmbeds && !privateNote && !pending
  const attachments = useNoteAttachments(generation, sourcePath)
  const beginLinkIntent = useLinkIntentGuard()
  const scope = JSON.stringify([generation, sourcePath])
  const currentScope = useRef(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
  }, [scope])
  const openFile = useCallback(
    (href: string) => {
      if (generation === null) return
      const isStale = beginLinkIntent()
      void (async () => {
        try {
          // A bare filename can resolve differently once the source folder's
          // catalog is available. Never open a guessed vault-root fallback.
          await loadAttachmentCatalog(generation)
          if (isStale() || currentScope.current !== scope) return
          const path = attachments.resolveAttachmentPath(href)
          if (path === null) {
            startOperation('Opening attachment').fail('Attachment not found.')
            return
          }
          await openAttachment(path, generation)
        } catch (cause) {
          if (!isStale() && currentScope.current === scope) {
            startOperation('Opening attachment').fail(errorMessage(cause))
          }
        }
      })()
    },
    [generation, scope, attachments, beginLinkIntent],
  )
  const onFileClick = useCallback<FileClickHandler>(
    ({ href, event }) => {
      event.preventDefault()
      openFile(href)
    },
    [openFile],
  )
  const onSourceLinkClick = useCallback<LinkClickHandler>(
    (payload) => {
      if (attachments.resolveAttachmentPath(payload.href) !== null) {
        payload.event.preventDefault()
        openFile(payload.href)
      } else onLinkClick(payload)
    },
    [attachments, openFile, onLinkClick],
  )
  const renderNested = useCallback<NoteEmbedRenderer>(
    (payload) => renderNoteEmbed(payload, allowRemote),
    [renderNoteEmbed, allowRemote],
  )
  return (
    <MarkdownPreview
      content={splitFrontmatter(source).body}
      headingOffset={headingOffset}
      resolveImageUrl={attachments.resolveImageUrl}
      resolveWikiEmbed={attachments.resolveWikiEmbed}
      renderNoteEmbed={renderNested}
      onWikiLinkClick={onWikiLinkClick}
      onLinkClick={onSourceLinkClick}
      onFileClick={onFileClick}
      remoteEmbeds={allowRemote}
      className="reflect-note-surface"
    />
  )
}
