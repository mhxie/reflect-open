import { afterEach, describe, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { clearNoteOutline, publishNoteOutline } from '@/editor/outline/outline-store.ts'
import { OutlineSection } from './outline-section.tsx'

const PATH = 'notes/plan.md'
const owner = Symbol('test editor')
const reveal = vi.fn()

function publish(activeIndex: number | null): void {
  publishNoteOutline(PATH, owner, {
    headings: [
      { level: 2, text: 'Goals', position: 10 },
      { level: 3, text: 'Metrics', position: 30 },
      { level: 2, text: 'Risks', position: 60 },
    ],
    activeIndex,
    reveal,
  })
}

afterEach(() => {
  clearNoteOutline(PATH, owner)
  reveal.mockReset()
})

describe('OutlineSection', () => {
  it('renders nothing until the note publishes section headings', async () => {
    const screen = await render(<OutlineSection path={PATH} />)
    expect(screen.container.textContent).toBe('')

    publishNoteOutline(PATH, owner, { headings: [], activeIndex: null, reveal })
    expect(screen.container.textContent).toBe('')

    publish(null)
    await expect.element(page.getByText('Outline')).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Metrics' })).toBeInTheDocument()
  })

  it('marks the section being read and follows it', async () => {
    publish(0)
    await render(<OutlineSection path={PATH} />)
    await expect
      .element(page.getByRole('button', { name: 'Goals' }))
      .toHaveAttribute('aria-current', 'location')

    publish(2)
    await expect
      .element(page.getByRole('button', { name: 'Risks' }))
      .toHaveAttribute('aria-current', 'location')
    await expect
      .element(page.getByRole('button', { name: 'Goals' }))
      .not.toHaveAttribute('aria-current')
  })

  it('indents rows by level and jumps on click', async () => {
    publish(null)
    await render(<OutlineSection path={PATH} />)
    const metrics = page.getByRole('button', { name: 'Metrics' })
    await expect.element(metrics).toHaveClass('pl-6')
    await expect.element(page.getByRole('button', { name: 'Goals' })).toHaveClass('pl-3')

    await metrics.click()
    expect(reveal).toHaveBeenCalledWith(1)
  })
})
