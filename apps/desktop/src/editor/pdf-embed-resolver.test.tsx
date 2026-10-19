import type { HostEmbed } from '@meowdown/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReflectError, type PdfPageSize } from '@reflect/core'
import {
  createTestAttachmentService,
  createTestGraphSessionService,
  type TestAttachmentService,
} from '@reflect/core/testing'
import { queryClient } from '@/lib/query-client.ts'
import { createPdfEmbedResolver } from './pdf-embed-resolver.ts'

const GENERATION = 3
const NOTE = 'Home.md'

/**
 * Attachments of an open graph of {@link GENERATION} listing `files`, with `pdfs` page sizes.
 */
function attachmentsOver(
  files: readonly string[],
  pdfs: Readonly<Record<string, { readonly pages: PdfPageSize[] }>> = {},
): TestAttachmentService {
  return createTestAttachmentService({
    catalog: files.map((path) => ({ path, size: 100 })),
    pdfs,
    graphSession: createTestGraphSessionService({ graph: { generation: GENERATION } }),
  })
}

function resolverOver(
  attachments: TestAttachmentService,
  options: { generation?: number | null; mobileApp?: boolean; openAsset?: () => void } = {},
) {
  return createPdfEmbedResolver({
    generation: options.generation === undefined ? GENERATION : options.generation,
    notePath: NOTE,
    attachments,
    noteAttachments: {
      resolveAttachmentPath: (destination) => attachments.resolveAttachmentPath(NOTE, destination),
    },
    mobileApp: options.mobileApp ?? false,
    openAsset: options.openAsset ?? vi.fn(),
  })
}

async function resolve(
  attachments: TestAttachmentService,
  src: string,
  options?: { mobileApp?: boolean; openAsset?: () => void },
): Promise<HostEmbed | undefined> {
  return await resolverOver(attachments, options)(src)
}

afterEach(() => {
  queryClient.clear()
})

describe('createPdfEmbedResolver', () => {
  it('leaves images, remote URLs, and a closed graph to the image path', () => {
    const resolver = resolverOver(attachmentsOver([]))
    expect(resolver('assets/cat.png')).toBeUndefined()
    expect(resolver('https://example.com/paper.pdf')).toBeUndefined()
    const closed = resolverOver(attachmentsOver([]), { generation: null })
    expect(closed('assets/paper.pdf')).toBeUndefined()
  })

  it('previews a PDF at its first page size, read in the note’s graph session', async () => {
    const attachments = attachmentsOver(['assets/paper.pdf'], {
      'assets/paper.pdf': {
        pages: [
          { width: 612, height: 792 },
          { width: 792, height: 612 },
        ],
      },
    })
    const pdfInfo = vi.spyOn(attachments, 'pdfInfo')
    const embed = await resolve(attachments, 'assets/paper.pdf')

    expect(embed?.width).toBe(612)
    expect(embed?.height).toBe(792)
    expect(embed?.element.dataset['testid']).toBe('pdf-embed')
    expect(embed?.element.querySelectorAll('img')).toHaveLength(2)
    expect(pdfInfo).toHaveBeenCalledWith('assets/paper.pdf', GENERATION)
    embed?.destroy?.()
  })

  it('previews a PDF saved before the catalog lists it', async () => {
    const attachments = attachmentsOver([], {
      'assets/just-dropped.pdf': { pages: [{ width: 612, height: 792 }] },
    })
    const embed = await resolve(attachments, 'assets/just-dropped.pdf')

    expect(embed?.element.dataset['testid']).toBe('pdf-embed')
    embed?.destroy?.()
  })

  it('shows a card with nothing to open for a missing file', async () => {
    const attachments = attachmentsOver([])
    vi.spyOn(attachments, 'pdfInfo').mockRejectedValue(new ReflectError('notFound', 'not found'))
    const embed = await resolve(attachments, 'assets/gone.pdf')

    expect(embed?.element.dataset['testid']).toBe('pdf-embed-error')
    expect(embed?.element.textContent).toContain('This file is missing.')
    expect(embed?.element.querySelector('button')).toBeNull()
  })

  it('offers to open a locked PDF in the default app', async () => {
    const attachments = attachmentsOver(['assets/secret.pdf'])
    vi.spyOn(attachments, 'pdfInfo').mockRejectedValue(
      new ReflectError('locked', 'the PDF is password-protected'),
    )
    const openAsset = vi.fn()
    const embed = await resolve(attachments, 'assets/secret.pdf', { openAsset })

    expect(embed?.element.textContent).toContain('This PDF is password-protected.')
    embed?.element.querySelector('button')?.click()
    expect(openAsset).toHaveBeenCalledWith('assets/secret.pdf')
  })

  it('shows a card with no open action on iOS, where previews are unsupported', async () => {
    const attachments = attachmentsOver(['assets/paper.pdf'])
    vi.spyOn(attachments, 'pdfInfo').mockRejectedValue(
      new ReflectError('unsupported', 'PDF previews are only available on macOS'),
    )
    const embed = await resolve(attachments, 'assets/paper.pdf', { mobileApp: true })

    expect(embed?.element.textContent).toContain('PDF previews are available in the Mac app.')
    expect(embed?.element.querySelector('button')).toBeNull()
  })

  it('explains a PDF past the size limit on the Mac and still offers to open it', async () => {
    const attachments = attachmentsOver(['assets/scan.pdf'])
    vi.spyOn(attachments, 'pdfInfo').mockRejectedValue(
      new ReflectError('unsupported', 'PDF previews are limited to 200 MB; this file is 312 MB'),
    )
    const openAsset = vi.fn()
    const embed = await resolve(attachments, 'assets/scan.pdf', { openAsset })

    expect(embed?.element.textContent).toContain(
      'PDF previews are limited to 200 MB; this file is 312 MB.',
    )
    embed?.element.querySelector('button')?.click()
    expect(openAsset).toHaveBeenCalledWith('assets/scan.pdf')
  })
})
