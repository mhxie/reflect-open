import { describe, expect, it, vi } from 'vitest'
import { createPdfErrorView } from './pdf-error-view.ts'

describe('createPdfErrorView', () => {
  it('names the file and says why it has no preview', () => {
    const view = createPdfErrorView({
      name: 'paper.pdf',
      message: 'This PDF is password-protected.',
    })
    expect(view.element.textContent).toContain('paper.pdf')
    expect(view.element.textContent).toContain('This PDF is password-protected.')
    expect(view.element.querySelector('button')).toBeNull()
  })

  it('opens the file from its button without letting the click reach the editor', () => {
    const onOpen = vi.fn()
    const onParentClick = vi.fn()
    const view = createPdfErrorView({ name: 'paper.pdf', message: 'Unreadable.', onOpen })
    const parent = document.createElement('div')
    parent.addEventListener('click', onParentClick)
    parent.append(view.element)
    document.body.append(parent)

    view.element.querySelector('button')?.click()
    expect(onOpen).toHaveBeenCalledOnce()
    expect(onParentClick).not.toHaveBeenCalled()

    view.destroy()
    view.element.querySelector('button')?.click()
    expect(onOpen).toHaveBeenCalledOnce()
    parent.remove()
  })
})
