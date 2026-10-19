import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import type { AttachmentService } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { PdfPeekPages } from './pdf-peek-pages.tsx'

type PdfInfo = Awaited<ReturnType<AttachmentService['pdfInfo']>>

async function renderPages(info: PdfInfo | Error) {
  const app = createTestCoreServices()
  const pdfInfo = vi.spyOn(app.attachments, 'pdfInfo')
  if (info instanceof Error) {
    pdfInfo.mockRejectedValue(info)
  } else {
    pdfInfo.mockResolvedValue(info)
  }
  await renderInApp(
    <div style={{ width: 600, height: 400, display: 'flex' }}>
      <PdfPeekPages generation={3} path="papers/a.pdf" />
    </div>,
    { app, servicesOnly: true },
  )
  return { app, pdfInfo }
}

describe('PdfPeekPages', () => {
  it('stacks every page, each reserving its size', async () => {
    const { app, pdfInfo } = await renderPages({
      pages: [
        { width: 612, height: 792 },
        { width: 612, height: 792 },
        { width: 792, height: 612 },
      ],
    })

    await expect.element(page.getByRole('img', { name: 'Page 3' })).toBeInTheDocument()
    const third = page.getByRole('img', { name: 'Page 3' }).element() as HTMLImageElement
    expect(third.getAttribute('width')).toBe('792')
    expect(third.src).toContain(
      `${app.attachments.assetUrl('papers/a.pdf', 3)}?reflect-preview=pdf-page&page=3&width=`,
    )
    expect(pdfInfo).toHaveBeenCalledWith('papers/a.pdf', 3)
  })

  it('says so when the PDF can’t be previewed', async () => {
    await renderPages(new Error('locked'))

    await expect.element(page.getByText('This PDF couldn’t be previewed.')).toBeVisible()
  })
})
