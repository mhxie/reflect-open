import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { ImageUrlResolver, WikiEmbedResolver } from '@meowdown/core'
import type { AttachmentService, GraphInfo, GraphSessionService } from '@reflect/core'
import { useMaybeGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * How one note's images, `![[embeds]]`, and attachment links render.
 */
export interface NoteAttachments {
  /**
   * The graph-relative attachment a link or image destination names (the
   * path to display and open), or null for URLs, notes, and unsafe paths.
   * Reads the catalog as loaded so far.
   */
  resolveAttachmentPath: (destination: string) => string | null
  /**
   * A displayable URL for an image source: http(s) as-is (never for a note in
   * a local-only folder, which must not reach the network), a local
   * attachment as a generation-pinned `reflect-asset://` URL, a PDF as its
   * first page. Answers synchronously once the catalog is loaded and waits
   * for it before that.
   */
  resolveImageUrl: ImageUrlResolver
  /**
   * Classifies an Obsidian `![[target]]` embed: an attachment renders as an
   * image, a PDF preview (through the editor's `resolveEmbed`), or a file
   * pill; a note renders as a link chip unless the host supplies a standalone
   * note reader; an unsafe path stays literal.
   */
  resolveWikiEmbed: WikiEmbedResolver
}

/**
 * Attachment resolution for rendering `notePath` in the open `graph`; only a
 * remote image resolves while no graph is open, and nothing local resolves
 * once another graph session replaced `graph`.
 */
export function createNoteAttachments(
  graph: GraphInfo | null,
  notePath: string,
  attachments: AttachmentService,
  graphSession: GraphSessionService,
): NoteAttachments {
  const isCurrent = (): boolean =>
    graph !== null && graphSession.getState().session?.generation === graph.generation
  return {
    resolveAttachmentPath: (destination) =>
      isCurrent() ? attachments.resolveAttachmentPath(notePath, destination) : null,
    resolveImageUrl: (source) =>
      graph === null || isCurrent() ? attachments.resolveImageUrl(notePath, source) : undefined,
    resolveWikiEmbed: ({ target }) => attachments.resolveWikiEmbed(target),
  }
}

/**
 * {@link createNoteAttachments} memoized per note and open graph: an image
 * URL carries the graph's generation, so a reopened graph gets new resolvers.
 * The caller re-renders whenever the catalog changes.
 */
export function useNoteAttachments(notePath: string): NoteAttachments {
  const graph = useMaybeGraph()?.graph ?? null
  const { attachments, graphSession } = useCoreServices()
  const subscribeCatalog = useCallback(
    (listener: () => void) => attachments.onCatalogChanged(listener),
    [attachments],
  )
  useSyncExternalStore(subscribeCatalog, () => attachments.peekCatalog())
  return useMemo(
    () => createNoteAttachments(graph, notePath, attachments, graphSession),
    [attachments, graph, graphSession, notePath],
  )
}
