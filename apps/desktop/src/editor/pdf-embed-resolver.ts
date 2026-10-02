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
import { attachmentUrl } from '@/editor/use-note-attachments.ts'
import { loadAttachmentCatalog, peekAttachmentCatalog } from '@/lib/attachment-catalog.ts'
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

/** The `reflect-asset://` URL of a PDF page rendered at a width bucket. */
export function pdfPageUrl(generation: number, path: string, page: number, width: number): string {
  return `${attachmentUrl(generation, path)}?reflect-preview=pdf-page&page=${page}&width=${width}`
}

/**
 * Meowdown's `resolveEmbed` for a note (Plan 25): a local PDF embed renders as
 * an inline preview, scrolling page by page; anything else defers to the
 * image path. The answer is asynchronous — it waits for the attachment
 * catalog and the PDF's page sizes — and never rejects: a PDF that can't be
 * previewed (missing, locked, unreadable, or off macOS) shows a card saying
 * so instead.
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
  if (catalog !== null && !catalog.has(path)) {
    return hostEmbed(createPdfErrorView({ name, message: 'This file is missing.' }), CARD_SIZE)
  }
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
    return hostEmbed(
      createPdfErrorView({
        name,
        message: previewFailureMessage(error),
        ...(error.kind === 'unsupported' ? {} : { onOpen: () => openAsset(path) }),
      }),
      CARD_SIZE,
    )
  }
}

function hostEmbed(view: PdfEmbedView, size: PdfPageSize): HostEmbed {
  return { element: view.element, width: size.width, height: size.height, destroy: view.destroy }
}

/** Why a PDF has no preview, as the card says it. */
function previewFailureMessage(error: AppError): string {
  switch (error.kind) {
    case 'unsupported':
      return 'PDF previews are available in the Mac app.'
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
