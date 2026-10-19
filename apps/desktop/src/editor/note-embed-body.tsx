import { useCallback, useLayoutEffect, useRef, type ReactElement, type ReactNode } from 'react'
import type { FileClickHandler, LinkClickHandler } from '@meowdown/core'
import type { NoteEmbedPayload, NoteEmbedRenderer } from '@meowdown/react'
import { errorMessage, notePrivate, splitFrontmatter } from '@reflect/core'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { useNoteAttachments } from '@/editor/use-note-attachments.ts'
import { usePrivateNoteState } from '@/hooks/use-private-note.ts'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

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

/**
 * Only mounted after expansion; the source note's live privacy verdict also governs descendants.
 */
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
  const { attachments } = useCoreServices()
  const { operations } = useAppServices()
  const { privateNote, pending } = usePrivateNoteState(sourcePath, {
    sessionEpoch: null,
    privateHeader: notePrivate(source),
  })
  const allowRemote = remoteEmbeds && !privateNote && !pending
  const noteAttachments = useNoteAttachments(sourcePath)
  const beginLinkIntent = useLinkIntentGuard()
  const scope = JSON.stringify([generation, sourcePath])
  const scopeRef = useRef(scope)
  useLayoutEffect(() => {
    scopeRef.current = scope
  }, [scope])
  const openFile = useCallback(
    (href: string) => {
      if (generation === null) return
      const isStale = beginLinkIntent()
      void (async () => {
        try {
          // A bare filename can resolve differently once the source folder's
          // catalog is available. Never open a guessed vault-root fallback.
          await attachments.loadCatalog()
          if (isStale() || scopeRef.current !== scope) return
          const path = noteAttachments.resolveAttachmentPath(href)
          if (path === null) {
            operations.fail('Opening attachment', 'Attachment not found.')
            return
          }
          await attachments.openOrReveal(path)
        } catch (cause) {
          if (!isStale() && scopeRef.current === scope) {
            operations.fail('Opening attachment', errorMessage(cause))
          }
        }
      })()
    },
    [generation, scope, attachments, noteAttachments, operations, beginLinkIntent],
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
      if (noteAttachments.resolveAttachmentPath(payload.href) !== null) {
        payload.event.preventDefault()
        openFile(payload.href)
      } else onLinkClick(payload)
    },
    [noteAttachments, openFile, onLinkClick],
  )
  const renderNested = useCallback<NoteEmbedRenderer>(
    (payload) => renderNoteEmbed(payload, allowRemote),
    [renderNoteEmbed, allowRemote],
  )
  return (
    <MarkdownPreview
      content={splitFrontmatter(source).body}
      sourcePath={sourcePath}
      headingOffset={headingOffset}
      resolveImageUrl={noteAttachments.resolveImageUrl}
      resolveWikiEmbed={noteAttachments.resolveWikiEmbed}
      renderNoteEmbed={renderNested}
      onWikiLinkClick={onWikiLinkClick}
      onLinkClick={onSourceLinkClick}
      onFileClick={onFileClick}
      remoteEmbeds={allowRemote}
      className="reflect-note-surface"
    />
  )
}
