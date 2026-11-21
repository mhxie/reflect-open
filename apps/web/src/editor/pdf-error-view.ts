import type { PdfEmbedView } from '@/editor/pdf-pages-view.ts'

export interface PdfErrorViewOptions {
  /** The PDF's file name. */
  readonly name: string
  /** Why there is no preview, in a short sentence. */
  readonly message: string
  /** Opens the PDF in the default app; omitted where that is unavailable. */
  readonly onOpen?: () => void
}

/**
 * The card an inline PDF embed shows in place of its pages: the file name,
 * why it can't be previewed, and (when available) a way to open it.
 */
export function createPdfErrorView({ name, message, onOpen }: PdfErrorViewOptions): PdfEmbedView {
  const element = document.createElement('div')
  element.className = 'reflect-pdf-embed reflect-pdf-embed-error'
  element.dataset.testid = 'pdf-embed-error'

  const title = document.createElement('span')
  title.className = 'reflect-pdf-embed-error-name'
  title.textContent = name
  const reason = document.createElement('span')
  reason.className = 'reflect-pdf-embed-error-message'
  reason.textContent = message
  element.append(title, reason)

  if (onOpen === undefined) {
    return { element, destroy: () => {} }
  }
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'reflect-pdf-embed-error-open'
  button.textContent = 'Open in default app'
  const onClick = (event: MouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    onOpen()
  }
  button.addEventListener('click', onClick)
  element.append(button)
  return { element, destroy: () => button.removeEventListener('click', onClick) }
}
