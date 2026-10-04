import { afterEach, describe, expect, it, vi } from 'vitest'
import { pdfPageWidthBucket } from '@reflect/core'
import { createPdfPagesView, type PdfEmbedView } from './pdf-pages-view.ts'

const PAGES = Array.from({ length: 6 }, () => ({ width: 600, height: 800 }))

let mounted: { view: PdfEmbedView; box: HTMLElement } | null = null

/** Mount the view in a box one 300×400 page large, as meowdown's resizable root sizes it. */
function mount(pageUrl = (page: number, width: number) => `pdf://page/${page}?w=${width}`): {
  view: PdfEmbedView
  box: HTMLElement
} {
  const box = document.createElement('div')
  box.style.width = '300px'
  box.style.height = '400px'
  document.body.append(box)
  const view = createPdfPagesView({ pages: PAGES, pageUrl, name: 'paper.pdf' })
  view.element.style.width = '100%'
  view.element.style.height = '100%'
  box.append(view.element)
  mounted = { view, box }
  return mounted
}

function images(view: PdfEmbedView): HTMLImageElement[] {
  return Array.from(view.element.querySelectorAll('img'))
}

afterEach(() => {
  mounted?.view.destroy()
  mounted?.box.remove()
  mounted = null
})

describe('createPdfPagesView', () => {
  it('renders one alt-labelled image per page', () => {
    const { view } = mount()
    expect(images(view).map((image) => image.alt)).toEqual(
      PAGES.map((_page, index) => `Page ${index + 1} of paper.pdf`),
    )
  })

  it('loads only the pages within a page of the viewport, at the box width bucket', async () => {
    const pageUrl = vi.fn((page: number, width: number) => `pdf://page/${page}?w=${width}`)
    const { view } = mount(pageUrl)
    const bucket = pdfPageWidthBucket(Math.ceil(300 * window.devicePixelRatio))

    await vi.waitFor(() => {
      expect(images(view)[0]?.getAttribute('src')).toBe(`pdf://page/1?w=${bucket}`)
    })
    expect(images(view)[1]?.getAttribute('src')).toBe(`pdf://page/2?w=${bucket}`)
    expect(images(view)[4]?.getAttribute('src')).toBeNull()
    expect(images(view)[5]?.getAttribute('src')).toBeNull()
  })

  it('loads later pages as they scroll into range', async () => {
    const { view } = mount()
    const scroller = view.element.querySelector<HTMLElement>('.reflect-pdf-embed-pages')
    await vi.waitFor(() => expect(images(view)[0]?.getAttribute('src')).not.toBeNull())

    scroller?.scrollTo({ top: 400 * 4 })
    await vi.waitFor(() => expect(images(view)[5]?.getAttribute('src')).not.toBeNull())
  })

  it('re-requests nearby pages when a resize crosses a width bucket', async () => {
    const { view, box } = mount()
    await vi.waitFor(() => expect(images(view)[0]?.getAttribute('src')).not.toBeNull())
    const before = images(view)[0]?.getAttribute('src')

    box.style.width = '1600px'
    box.style.height = `${(1600 * 4) / 3}px`
    const bucket = pdfPageWidthBucket(Math.ceil(1600 * window.devicePixelRatio))
    await vi.waitFor(() => {
      expect(images(view)[0]?.getAttribute('src')).toBe(`pdf://page/1?w=${bucket}`)
    })
    expect(images(view)[0]?.getAttribute('src')).not.toBe(before)
  })

  it('counts pages as the scroller moves', async () => {
    const { view } = mount()
    const indicator = view.element.querySelector('.reflect-pdf-embed-indicator')
    const scroller = view.element.querySelector<HTMLElement>('.reflect-pdf-embed-pages')
    expect(indicator?.textContent).toBe('1 / 6')

    scroller?.scrollTo({ top: 400 * 2 })
    await vi.waitFor(() => expect(indicator?.textContent).toBe('3 / 6'))
  })

  it('hides the counter for a one-page PDF', () => {
    const view = createPdfPagesView({
      pages: [{ width: 600, height: 800 }],
      pageUrl: () => 'pdf://page/1',
      name: 'memo.pdf',
    })
    expect(view.element.querySelector<HTMLElement>('.reflect-pdf-embed-indicator')?.hidden).toBe(
      true,
    )
    view.destroy()
  })
})
