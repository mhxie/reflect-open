import { useMemo } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import type { ImageUrlResolver, WikiEmbedResolver } from '@meowdown/core'
import {
  isLocalOnlyPath,
  isPdfAttachmentPath,
  pdfPageWidthBucket,
  resolveAttachmentLink,
  resolveWikiEmbedTarget,
  type AttachmentCatalog,
} from '@reflect/core'
import { loadAttachmentCatalog, peekAttachmentCatalog } from '@/lib/attachment-catalog.ts'

/** How one note's images, `![[embeds]]`, and attachment links render. */
export interface NoteAttachments {
  /**
   * The graph-relative attachment a link or image destination names — the
   * path to display and open — or null for URLs, notes, and unsafe paths.
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
  /** Classifies an Obsidian `![[target]]` embed. */
  resolveWikiEmbed: WikiEmbedResolver
}

/** The `reflect-asset://` URL serving a graph-relative attachment off the UI thread. */
export function attachmentUrl(generation: number, path: string): string {
  return convertFileSrc(`${generation}/${path}`, 'reflect-asset')
}

/** The `reflect-asset://` URL of a PDF page rendered at a width bucket. */
export function pdfPageUrl(generation: number, path: string, page: number, width: number): string {
  return `${attachmentUrl(generation, path)}?reflect-preview=pdf-page&page=${page}&width=${width}`
}

/**
 * An attachment renders as an image, a PDF preview (through the image view's
 * `resolveEmbed`), or a file pill, a note as a link chip to it (note content
 * is never transcluded), and an unsafe path stays literal.
 */
const resolveWikiEmbed: WikiEmbedResolver = ({ target }) => {
  const embed = resolveWikiEmbedTarget(target)
  if (embed === null) {
    return
  }
  if (embed.kind === 'note') {
    return { kind: 'note' }
  }
  return embed.kind === 'file'
    ? { kind: 'file', href: embed.source }
    : { kind: 'image', src: embed.source }
}

/** Attachment resolution for rendering `notePath` in graph session `generation`. */
export function createNoteAttachments(
  generation: number | null,
  notePath: string,
): NoteAttachments {
  const resolvePath = (destination: string, catalog: AttachmentCatalog | null): string | null =>
    generation === null ? null : resolveAttachmentLink(notePath, destination, catalog)
  const remoteAllowed = !isLocalOnlyPath(notePath)
  return {
    resolveAttachmentPath: (destination) =>
      resolvePath(destination, generation === null ? null : peekAttachmentCatalog(generation)),
    resolveImageUrl: (src) => {
      if (/^https?:\/\//i.test(src)) {
        return remoteAllowed ? src : undefined
      }
      if (generation === null) {
        return
      }
      // The editor previews a PDF's pages through `resolveEmbed` first; a
      // read-only preview shows its first page at the smallest width. Its
      // bytes never reach an <img>.
      const url = (catalog: AttachmentCatalog | null): string | undefined => {
        const path = resolvePath(src, catalog)
        if (path === null) {
          return
        }
        return isPdfAttachmentPath(path)
          ? pdfPageUrl(generation, path, 1, pdfPageWidthBucket(0))
          : attachmentUrl(generation, path)
      }
      const catalog = peekAttachmentCatalog(generation)
      return catalog === null
        ? loadAttachmentCatalog(generation).then(url, () => url(null))
        : url(catalog)
    },
    resolveWikiEmbed,
  }
}

/** {@link createNoteAttachments} memoized per note and graph session. */
export function useNoteAttachments(generation: number | null, notePath: string): NoteAttachments {
  return useMemo(() => createNoteAttachments(generation, notePath), [generation, notePath])
}
