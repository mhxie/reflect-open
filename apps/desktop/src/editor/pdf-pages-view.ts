import { pdfPageWidthBucket, type PdfPageSize } from '@reflect/core'

export interface PdfPagesViewOptions {
  /** Page sizes in document order; there is at least one. */
  readonly pages: readonly PdfPageSize[]
  /** The URL of 1-based `page` rendered `width` device pixels wide. */
  readonly pageUrl: (page: number, width: number) => string
  /** The PDF's file name, for the pages' alt text. */
  readonly name: string
  /** Opens the PDF in the default app, on a double-click. */
  readonly onOpen?: () => void
}

/** A mounted embed body and its teardown. */
export interface PdfEmbedView {
  readonly element: HTMLElement
  readonly destroy: () => void
}

/**
 * An inline PDF embed's body: a one-page-tall scroller that snaps page to page.
 * Pages load within a page of the viewport, at the box's width bucket. A
 * double-click opens the PDF (ProseMirror reports only single clicks).
 */
export function createPdfPagesView({
  pages,
  pageUrl,
  name,
  onOpen,
}: PdfPagesViewOptions): PdfEmbedView {
  const element = document.createElement('div')
  element.className = 'reflect-pdf-embed'
  element.dataset.testid = 'pdf-embed'

  const scroller = document.createElement('div')
  scroller.className = 'reflect-pdf-embed-pages'
  element.append(scroller)

  const images = pages.map((_page, index) => {
    const slot = document.createElement('div')
    slot.className = 'reflect-pdf-embed-page'
    const image = document.createElement('img')
    image.alt = `Page ${index + 1} of ${name}`
    image.draggable = false
    image.decoding = 'async'
    slot.append(image)
    scroller.append(slot)
    return image
  })

  const indicator = document.createElement('span')
  indicator.className = 'reflect-pdf-embed-indicator'
  indicator.hidden = pages.length < 2
  element.append(indicator)

  let bucket: number | null = null
  const nearby = new Set<number>()

  const load = (index: number): void => {
    const image = images[index]
    if (image === undefined || bucket === null || image.dataset.bucket === String(bucket)) {
      return
    }
    image.dataset.bucket = String(bucket)
    image.src = pageUrl(index + 1, bucket)
  }

  const indexOf = new Map<Element, number>(images.map((image, index) => [image, index]))
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = indexOf.get(entry.target)
        if (index === undefined) {
          continue
        }
        if (entry.isIntersecting) {
          nearby.add(index)
          load(index)
        } else {
          nearby.delete(index)
        }
      }
    },
    { root: scroller, rootMargin: '100% 0px' },
  )
  for (const image of images) {
    visibility.observe(image)
  }

  const sizing = new ResizeObserver(() => {
    const width = scroller.clientWidth
    if (width === 0) {
      return
    }
    const next = pdfPageWidthBucket(Math.ceil(width * window.devicePixelRatio))
    if (next === bucket) {
      return
    }
    bucket = next
    for (const index of nearby) {
      load(index)
    }
  })
  sizing.observe(scroller)

  let frame = 0
  const showCurrentPage = (): void => {
    frame = 0
    const height = scroller.clientHeight
    const current = height > 0 ? Math.round(scroller.scrollTop / height) + 1 : 1
    indicator.textContent = `${Math.min(current, pages.length)} / ${pages.length}`
  }
  const onScroll = (): void => {
    if (frame === 0) {
      frame = requestAnimationFrame(showCurrentPage)
    }
  }
  scroller.addEventListener('scroll', onScroll, { passive: true })
  showCurrentPage()

  const onDoubleClick = (): void => onOpen?.()
  element.addEventListener('dblclick', onDoubleClick)

  return {
    element,
    destroy: () => {
      visibility.disconnect()
      sizing.disconnect()
      scroller.removeEventListener('scroll', onScroll)
      element.removeEventListener('dblclick', onDoubleClick)
      cancelAnimationFrame(frame)
    },
  }
}
