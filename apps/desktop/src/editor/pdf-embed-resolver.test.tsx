import type { HostEmbed } from '@meowdown/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReflectError, setBridge } from '@reflect/core'
import { queryClient } from '@/lib/query-client.ts'
import { createPdfEmbedResolver, pdfPageUrl } from './pdf-embed-resolver.ts'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (filePath: string, protocol = 'asset') =>
    `${protocol}://localhost/${encodeURIComponent(filePath)}`,
}))

const GENERATION = 3

/** A bridge listing `files` as attachments and answering `pdf_info` with `info`. */
function installBridge(files: string[], info: () => unknown): ReturnType<typeof vi.fn> {
  const invoke = vi.fn(async (command: string) => {
    if (command === 'list_attachments') {
      return files.map((path) => ({ path, size: 100, modifiedMs: 0 }))
    }
    if (command === 'pdf_info') {
      return info()
    }
    return null
  })
  setBridge({ invoke, invokeBinary: async () => null, listen: async () => () => {} })
  return invoke
}

async function resolve(src: string, openAsset = vi.fn()): Promise<HostEmbed | undefined> {
  const resolver = createPdfEmbedResolver({
    generation: GENERATION,
    notePath: 'Home.md',
    openAsset,
  })
  return await resolver(src)
}

afterEach(() => {
  setBridge(null)
  queryClient.clear()
})

describe('createPdfEmbedResolver', () => {
  it('leaves images, remote URLs, and a closed graph to the image path', () => {
    const resolver = createPdfEmbedResolver({
      generation: GENERATION,
      notePath: 'Home.md',
      openAsset: vi.fn(),
    })
    expect(resolver('assets/cat.png')).toBeUndefined()
    expect(resolver('https://example.com/paper.pdf')).toBeUndefined()
    const closed = createPdfEmbedResolver({
      generation: null,
      notePath: 'Home.md',
      openAsset: vi.fn(),
    })
    expect(closed('assets/paper.pdf')).toBeUndefined()
  })

  it('previews a PDF at its first page size, pages served by the asset protocol', async () => {
    const invoke = installBridge(['assets/paper.pdf'], () => ({
      pages: [
        { width: 612, height: 792 },
        { width: 792, height: 612 },
      ],
    }))
    const embed = await resolve('assets/paper.pdf')

    expect(embed?.width).toBe(612)
    expect(embed?.height).toBe(792)
    expect(embed?.element.dataset['testid']).toBe('pdf-embed')
    expect(embed?.element.querySelectorAll('img')).toHaveLength(2)
    expect(invoke).toHaveBeenCalledWith('pdf_info', {
      path: 'assets/paper.pdf',
      generation: GENERATION,
    })
    embed?.destroy?.()
  })

  it('builds page URLs on the reflect-asset protocol', () => {
    expect(pdfPageUrl(GENERATION, 'assets/my paper.pdf', 2, 960)).toBe(
      `reflect-asset://localhost/${encodeURIComponent('3/assets/my paper.pdf')}` +
        '?reflect-preview=pdf-page&page=2&width=960',
    )
  })

  it('shows a card for a missing file without asking for page sizes', async () => {
    const invoke = installBridge([], () => ({ pages: [{ width: 1, height: 1 }] }))
    const embed = await resolve('assets/gone.pdf')

    expect(embed?.element.dataset['testid']).toBe('pdf-embed-error')
    expect(embed?.element.textContent).toContain('This file is missing.')
    expect(invoke).not.toHaveBeenCalledWith('pdf_info', expect.anything())
  })

  it('offers to open a locked PDF in the default app', async () => {
    installBridge(['assets/secret.pdf'], () => {
      throw new ReflectError('locked', 'the PDF is password-protected')
    })
    const openAsset = vi.fn()
    const embed = await resolve('assets/secret.pdf', openAsset)

    expect(embed?.element.textContent).toContain('This PDF is password-protected.')
    embed?.element.querySelector('button')?.click()
    expect(openAsset).toHaveBeenCalledWith('assets/secret.pdf')
  })

  it('shows a card with no open action where previews are unsupported', async () => {
    installBridge(['assets/paper.pdf'], () => {
      throw new ReflectError('unsupported', 'PDF previews need the macOS app')
    })
    const embed = await resolve('assets/paper.pdf')

    expect(embed?.element.textContent).toContain('PDF previews are available in the Mac app.')
    expect(embed?.element.querySelector('button')).toBeNull()
  })
})
