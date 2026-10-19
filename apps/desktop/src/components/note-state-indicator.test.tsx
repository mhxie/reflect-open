import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deriveNoteState, NO_LOCAL_ONLY_FOLDERS } from '@reflect/core'
import '@/test-utils/locator.ts'
import { clearNoteStatus, publishNoteStatus } from '@/editor/status/note-status-store.ts'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { actAsync } from '@/test-utils/act.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { NoteStateIndicator } from './note-state-indicator.tsx'

const path = 'notes/plan.md'
const owner = Symbol('indicator-test')

afterEach(() => {
  clearNoteStatus({ generation: 1, path }, owner)
  clearNoteStatus({ generation: 2, path }, owner)
})

describe('NoteStateIndicator', () => {
  it('leaves an ordinary note unmarked', async () => {
    const view = await renderInApp(
      <NoteStateIndicator path="daily/2026-10-05.md" isPrivate={false} />,
    )

    expect(view.container.querySelector('[role="img"]')).toBeNull()
    expect(view.container.querySelectorAll('svg')).toHaveLength(0)
  })

  it('explains Private in its tooltip behind a one-word accessible label', async () => {
    await renderInApp(
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
    const view = await renderInApp(
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
    const view = await renderInApp(<NoteStateIndicator path={path} isPrivate hasConflict />)

    await expect.element(page.getByRole('img', { name: 'Protected' })).toBeInTheDocument()
    expect(view.container.querySelectorAll('svg')).toHaveLength(1)
  })

  it('marks a note in a local-only folder from the open graph’s folders', async () => {
    await renderInApp(<NoteStateIndicator path="secure/vault.md" isPrivate={false} />, {
      graph: { localOnlyFolders: ['secure'], localOnlyEditableFolders: ['secure'] },
    })

    await expect.element(page.getByRole('img', { name: 'Local-only' })).toBeInTheDocument()
  })

  it('updates from a live session and never carries it into another graph generation', async () => {
    const view = await renderInApp(<NoteStateIndicator path={path} isPrivate={false} />, {
      graph: { generation: 1 },
    })
    await actAsync(() => {
      publishNoteStatus({ generation: 1, path }, owner, {
        characters: 12,
        protection: null,
        selectedCharacters: 0,
        editedAt: null,
        state: deriveNoteState(NO_LOCAL_ONLY_FOLDERS, { path, isPrivate: true }),
      })
    })
    await expect.element(page.getByRole('img', { name: 'Private' })).toBeInTheDocument()

    await actAsync(() => view.app.graphSession.setGraph({ generation: 2 }))
    await expect.element(page.getByRole('img', { name: 'Private' })).not.toBeInTheDocument()
    expect(view.container.querySelector('[role="img"]')).toBeNull()
  })

  it('uses indexed metadata again when the mounted session closes', async () => {
    publishNoteStatus({ generation: 1, path }, owner, {
      characters: 12,
      protection: null,
      selectedCharacters: 0,
      editedAt: null,
      state: deriveNoteState(NO_LOCAL_ONLY_FOLDERS, { path, isPrivate: false, protected: true }),
    })
    await renderInApp(<NoteStateIndicator path={path} isPrivate />, { graph: { generation: 1 } })
    await expect.element(page.getByRole('img', { name: 'Protected' })).toBeInTheDocument()

    await actAsync(() => clearNoteStatus({ generation: 1, path }, owner))
    await expect.element(page.getByRole('img', { name: 'Private' })).toBeInTheDocument()
  })

  it('preserves the containing row click and keyboard action without nesting a button', async () => {
    const navigate = vi.fn()
    const view = await renderInApp(
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
