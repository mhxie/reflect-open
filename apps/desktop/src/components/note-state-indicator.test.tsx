import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveNoteState } from '@reflect/core'
import '@/test-utils/locator.ts'
import { clearNoteStatus, publishNoteStatus } from '@/editor/status/note-status-store.ts'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { NoteStateIndicator } from './note-state-indicator.tsx'

let generation = 1

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { generation } }),
}))

const path = 'notes/plan.md'
const owner = Symbol('indicator-test')

afterEach(async () => {
  await cleanup()
  clearNoteStatus({ generation: 1, path }, owner)
  clearNoteStatus({ generation: 2, path }, owner)
  generation = 1
})

describe('NoteStateIndicator', () => {
  it('marks an ordinary daily note Editable with one document glyph', async () => {
    const view = await render(<NoteStateIndicator path="daily/2026-10-05.md" isPrivate={false} />)

    await expect.element(page.getByRole('img', { name: 'Editable' })).toBeInTheDocument()
    expect(view.container.querySelectorAll('svg')).toHaveLength(1)
    expect(view.container.querySelector('.lucide-file-text')).not.toBeNull()
  })

  it('explains Private in its tooltip behind a one-word accessible label', async () => {
    await render(
      <TooltipProvider delay={0}>
        <NoteStateIndicator path={path} isPrivate />
      </TooltipProvider>,
    )

    const indicator = page.getByRole('img', { name: 'Private', exact: true })
    await expect.element(indicator).toBeInTheDocument()
    await userEvent.hover(indicator)
    await expect.element(page.getByText('Private', { exact: true })).toBeVisible()
    await expect
      .element(page.getByText('Never sent to AI or other services', { exact: false }))
      .toBeVisible()
  })

  it('lists every state that applies in the tooltip of a single glyph', async () => {
    const view = await render(
      <TooltipProvider delay={0}>
        <NoteStateIndicator path={path} isPrivate hasConflict />
      </TooltipProvider>,
    )

    const indicator = page.getByRole('img', { name: 'Protected', exact: true })
    expect(view.container.querySelectorAll('svg')).toHaveLength(1)
    await userEvent.hover(indicator)
    await expect.element(page.getByText('Protected', { exact: true })).toBeVisible()
    await expect.element(page.getByText('Private', { exact: true })).toBeVisible()
  })

  it('gives a conflict priority over the Private flag with one glyph', async () => {
    const view = await render(<NoteStateIndicator path={path} isPrivate hasConflict />)

    await expect.element(page.getByRole('img', { name: 'Protected' })).toBeInTheDocument()
    expect(view.container.querySelectorAll('svg')).toHaveLength(1)
  })

  it('updates from a live session and never carries it into another graph generation', async () => {
    const view = await render(<NoteStateIndicator path={path} isPrivate={false} />)
    publishNoteStatus({ generation, path }, owner, {
      characters: 12,
      protection: null,
      selectedCharacters: 0,
      editedAt: null,
      state: deriveNoteState({ path, isPrivate: true }),
    })
    await expect.element(page.getByRole('img', { name: 'Private' })).toBeInTheDocument()

    generation = 2
    await view.rerender(<NoteStateIndicator path={path} isPrivate={false} />)
    await expect.element(page.getByRole('img', { name: 'Editable' })).toBeInTheDocument()
  })

  it('uses indexed metadata again when the mounted session closes', async () => {
    publishNoteStatus({ generation, path }, owner, {
      characters: 12,
      protection: null,
      selectedCharacters: 0,
      editedAt: null,
      state: deriveNoteState({ path, isPrivate: false, protected: true }),
    })
    await render(<NoteStateIndicator path={path} isPrivate />)
    await expect.element(page.getByRole('img', { name: 'Protected' })).toBeInTheDocument()

    clearNoteStatus({ generation, path }, owner)
    await expect.element(page.getByRole('img', { name: 'Private' })).toBeInTheDocument()
  })

  it('preserves the containing row click and keyboard action without nesting a button', async () => {
    const navigate = vi.fn()
    const view = await render(
      <button type="button" aria-label="Open plan" onClick={navigate}>
        Plan <NoteStateIndicator path={path} isPrivate />
      </button>,
    )
    expect(view.container.querySelectorAll('button')).toHaveLength(1)
    await userEvent.click(page.getByRole('img', { name: 'Private' }))
    expect(navigate).toHaveBeenCalledOnce()
    const row = page.getByRole('button', { name: 'Open plan' })
    row.element().focus()
    await expect.element(row).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(navigate).toHaveBeenCalledTimes(2)
  })
})
