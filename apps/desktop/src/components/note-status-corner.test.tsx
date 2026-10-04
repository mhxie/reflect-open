import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearNoteStatus, publishNoteStatus } from '@/editor/status/note-status-store.ts'
import type { Route } from '@/routing/route.ts'
import { RouterProvider } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { NoteStatusCorner } from './note-status-corner.tsx'

vi.mock('@/lib/use-today.ts', () => ({ useToday: () => '2026-10-03' }))

const owner = Symbol('test')

function renderCorner(initialRoute: Route) {
  return render(
    <RouterProvider initialRoute={initialRoute}>
      <NoteStatusCorner />
    </RouterProvider>,
  )
}

afterEach(async () => {
  clearNoteStatus('notes/a.md', owner)
  clearNoteStatus('daily/2026-10-03.md', owner)
  await cleanup()
})

describe('NoteStatusCorner', () => {
  it('shows the routed note’s live character count', async () => {
    publishNoteStatus('notes/a.md', owner, { characters: 1234 })
    await renderCorner({ kind: 'note', path: 'notes/a.md' })

    await expect
      .element(page.getByRole('status', { name: 'Note status' }))
      .toHaveTextContent('1,234 chars')
  })

  it('follows today’s daily note on the daily stream', async () => {
    publishNoteStatus('daily/2026-10-03.md', owner, { characters: 42 })
    await renderCorner({ kind: 'today' })

    await expect
      .element(page.getByRole('status', { name: 'Note status' }))
      .toHaveTextContent('42 chars')
  })

  it('stays out of screens that edit no note', async () => {
    publishNoteStatus('notes/a.md', owner, { characters: 1234 })
    const view = await renderCorner({ kind: 'allNotes', filter: null })

    expect(view.container.querySelector('[role="status"]')).toBeNull()
  })
})
