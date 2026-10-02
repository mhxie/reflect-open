import type { EmbedResolver, HostEmbed } from '@meowdown/core'
import {
  isPdfAttachmentPath,
  resolveAttachmentLink,
  toAppError,
  type AppError,
  type PdfPageSize,
} from '@reflect/core'
import { createPdfErrorView } from '@/editor/pdf-error-view.ts'
import { createPdfPagesView, type PdfEmbedView } from '@/editor/pdf-pages-view.ts'
import { pdfPageUrl } from '@/editor/use-note-attachments.ts'
import { loadAttachmentCatalog, peekAttachmentCatalog } from '@/lib/attachment-catalog.ts'
import { isMobileSurface } from '@/lib/platform-surface.ts'
import { queryClient } from '@/lib/query-client.ts'
import { createPdfInfoQueryOptions } from '@/lib/query-options.ts'

/** US Letter in points: the box a "can't preview" card fills. */
const CARD_SIZE: PdfPageSize = { width: 612, height: 792 }

export interface PdfEmbedResolverOptions {
  /** The graph session the note was opened in, or null with no graph open. */
  readonly generation: number | null
  /** The note's graph-relative path, which relative destinations resolve against. */
  readonly notePath: string
  /** Opens a graph-relative attachment in the OS default application. */
  readonly openAsset: (path: string) => void
}

/**
 * Meowdown's `resolveEmbed`: a local PDF previews inline, anything else defers
 * to the image path. Never rejects: an unpreviewable PDF shows a card saying why.
 */
export function createPdfEmbedResolver({
  generation,
  notePath,
  openAsset,
}: PdfEmbedResolverOptions): EmbedResolver {
  return (src) => {
    if (generation === null || /^[a-z][a-z\d+.-]*:/i.test(src) || !isPdfAttachmentPath(src)) {
      return
    }
    return resolvePdfEmbed(generation, notePath, src, openAsset)
  }
}

async function resolvePdfEmbed(
  generation: number,
  notePath: string,
  src: string,
  openAsset: (path: string) => void,
): Promise<HostEmbed | undefined> {
  const catalog =
    peekAttachmentCatalog(generation) ?? (await loadAttachmentCatalog(generation).catch(() => null))
  const path = resolveAttachmentLink(notePath, src, catalog)
  if (path === null) {
    return undefined
  }
  const name = path.slice(path.lastIndexOf('/') + 1)
  // No catalog check: a PDF dropped a moment ago exists before the watcher
  // re-lists the catalog, so only `pdf_info` can say a file is missing.
  try {
    const info = await queryClient.fetchQuery(
      createPdfInfoQueryOptions(generation, path, catalog?.size(path)),
    )
    const view = createPdfPagesView({
      name,
      pages: info.pages,
      pageUrl: (page, width) => pdfPageUrl(generation, path, page, width),
      onOpen: () => openAsset(path),
    })
    return hostEmbed(view, info.pages[0] ?? CARD_SIZE)
  } catch (cause) {
    const error = toAppError(cause)
    // Off the Mac (iOS) there is no preview and no default app to hand the
    // PDF to; on the Mac, `unsupported` means the file is past the size limit.
    // A missing file has nothing to open.
    const onMobile = isMobileSurface()
    const openable = error.kind !== 'notFound' && !(error.kind === 'unsupported' && onMobile)
    return hostEmbed(
      createPdfErrorView({
        name,
        message: previewFailureMessage(error, onMobile),
        ...(openable ? { onOpen: () => openAsset(path) } : {}),
      }),
      CARD_SIZE,
    )
  }
}

function hostEmbed(view: PdfEmbedView, size: PdfPageSize): HostEmbed {
  return { element: view.element, width: size.width, height: size.height, destroy: view.destroy }
}

/** Why a PDF has no preview, as the card says it. */
function previewFailureMessage(error: AppError, onMobile: boolean): string {
  switch (error.kind) {
    case 'unsupported':
      return onMobile ? 'PDF previews are available in the Mac app.' : asSentence(error.message)
    case 'locked':
      return 'This PDF is password-protected.'
    case 'invalid':
      return 'This file couldn’t be read as a PDF.'
    case 'notFound':
      return 'This file is missing.'
    default:
      return 'This PDF couldn’t be previewed.'
  }
}

/** A Rust error message as a card sentence: capitalized, ending in a period. */
function asSentence(message: string): string {
  const sentence = message.charAt(0).toUpperCase() + message.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}
