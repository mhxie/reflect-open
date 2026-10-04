import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import '@/test-utils/locator.ts'
import { PdfPeekPages } from './pdf-peek-pages.tsx'

const pdfInfo = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  pdfInfo,
}))
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string, protocol: string) => `${protocol}://localhost/${path}`,
}))

function renderPages() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <div style={{ width: 600, height: 400, display: 'flex' }}>
        <PdfPeekPages generation={3} path="papers/a.pdf" />
      </div>
    </QueryClientProvider>,
  )
}

describe('PdfPeekPages', () => {
  it('stacks every page, each reserving its size', async () => {
    pdfInfo.mockResolvedValue({
      pages: [
        { width: 612, height: 792 },
        { width: 612, height: 792 },
        { width: 792, height: 612 },
      ],
    })
    await renderPages()

    await expect.element(page.getByRole('img', { name: 'Page 3' })).toBeInTheDocument()
    const third = page.getByRole('img', { name: 'Page 3' }).element() as HTMLImageElement
    expect(third.getAttribute('width')).toBe('792')
    expect(third.src).toContain('3/papers/a.pdf?reflect-preview=pdf-page&page=3&width=')
    expect(pdfInfo).toHaveBeenCalledWith('papers/a.pdf', 3)
  })

  it('says so when the PDF can’t be previewed', async () => {
    pdfInfo.mockRejectedValue(new Error('locked'))
    await renderPages()

    await expect.element(page.getByText('This PDF couldn’t be previewed.')).toBeVisible()
  })
})
