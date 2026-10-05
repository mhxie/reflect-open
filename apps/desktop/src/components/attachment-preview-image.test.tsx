import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { AttachmentPreviewImage } from './attachment-preview-image.tsx'

/**
 * The preview's fallback chain against real image loads: the shell's
 * thumbnail and PDF-page URLs are made to fail, the raster-filter URL to load
 * (a 1×1 PNG).
 */

const sources = vi.hoisted(() => {
  const bytes = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    ),
    (character) => character.charCodeAt(0),
  )
  return {
    image: URL.createObjectURL(new Blob([bytes], { type: 'image/png' })),
    broken: URL.createObjectURL(new Blob(['not an image'], { type: 'image/png' })),
  }
})
// The asset path rides in the fragment, so the queries the component appends
// keep the blob URLs loadable.
vi.mock('@/editor/use-note-attachments.ts', () => ({
  attachmentUrl: (_generation: number, path: string) =>
    `${path.includes('bad') ? sources.broken : sources.image}#asset`,
  imageThumbnailUrl: () => `${sources.broken}#thumb`,
  pdfPageUrl: () => `${sources.broken}#page`,
}))

describe('AttachmentPreviewImage', () => {
  it('falls back to the budgeted raster filter when the shell refuses the thumbnail', async () => {
    const onLoadSize = vi.fn()
    const onError = vi.fn()
    const view = await render(
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
      `${sources.image}#asset?reflect-preview=raster&budget=thumb&v=1-1`,
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
    const view = await render(preview('assets/bad.png'))
    await expect.element(view.getByText('fallback')).toBeInTheDocument()

    await view.rerender(preview('assets/good.png'))

    await vi.waitFor(() => expect(onLoadSize).toHaveBeenCalledWith(1, 1))
    expect(view.container.textContent).not.toContain('fallback')
  })

  it('shows the fallback once a PDF page fails, with no raster fallback', async () => {
    const onError = vi.fn()
    const view = await render(
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
