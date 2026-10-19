import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { AttachmentPreviewImage } from './attachment-preview-image.tsx'

/**
 * The preview's fallback chain against real image loads: the shell's
 * thumbnail and PDF-page URLs are made to fail, the raster-filter URL to load
 * (a 1×1 PNG).
 */

const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  ),
  (character) => character.charCodeAt(0),
)
const IMAGE = URL.createObjectURL(new Blob([PNG], { type: 'image/png' }))
const BROKEN = URL.createObjectURL(new Blob(['not an image'], { type: 'image/png' }))

/**
 * `ui` over attachment URLs that load only for the raster filter. The asset
 * path rides in the fragment, so the queries the component appends keep the
 * blob URLs loadable.
 */
async function renderPreview(ui: ReactNode) {
  const app = createTestCoreServices()
  vi.spyOn(app.attachments, 'assetUrl').mockImplementation(
    (path) => `${path.includes('bad') ? BROKEN : IMAGE}#asset`,
  )
  vi.spyOn(app.attachments, 'imageThumbnailUrl').mockReturnValue(`${BROKEN}#thumb`)
  vi.spyOn(app.attachments, 'pdfPageUrl').mockReturnValue(`${BROKEN}#page`)
  return await renderInApp(ui, { app, servicesOnly: true })
}

describe('AttachmentPreviewImage', () => {
  it('falls back to the budgeted raster filter when the shell refuses the thumbnail', async () => {
    const onLoadSize = vi.fn()
    const onError = vi.fn()
    const view = await renderPreview(
      <AttachmentPreviewImage
        generation={1}
        path="assets/photo.png"
        kind="image"
        width={200}
        version="v=1-1"
        fallback={<span>fallback</span>}
        onLoadSize={onLoadSize}
        onError={onError}
      />,
    )

    await vi.waitFor(() => expect(onLoadSize).toHaveBeenCalledWith(1, 1))
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(
      `${IMAGE}#asset?reflect-preview=raster&budget=thumb&v=1-1`,
    )
    expect(onError).not.toHaveBeenCalled()
  })

  it('starts over when its source changes after a failure', async () => {
    const onLoadSize = vi.fn()
    const preview = (path: string) => (
      <AttachmentPreviewImage
        generation={1}
        path={path}
        kind="image"
        width={200}
        fallback={<span>fallback</span>}
        onLoadSize={onLoadSize}
      />
    )
    const view = await renderPreview(preview('assets/bad.png'))
    await expect.element(view.getByText('fallback')).toBeInTheDocument()

    await view.rerender(preview('assets/good.png'))

    await vi.waitFor(() => expect(onLoadSize).toHaveBeenCalledWith(1, 1))
    expect(view.container.textContent).not.toContain('fallback')
  })

  it('shows the fallback once a PDF page fails, with no raster fallback', async () => {
    const onError = vi.fn()
    const view = await renderPreview(
      <AttachmentPreviewImage
        generation={1}
        path="assets/report.pdf"
        kind="pdf"
        width={200}
        fallback={<span>fallback</span>}
        onError={onError}
      />,
    )

    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    await expect.element(view.getByText('fallback')).toBeInTheDocument()
    expect(view.container.querySelector('img')).toBeNull()
  })
})
