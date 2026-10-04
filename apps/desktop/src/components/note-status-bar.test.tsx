import { act } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearNoteStatus, publishNoteStatus } from '@/editor/status/note-status-store.ts'
import type { Route } from '@/routing/route.ts'
import { RouterProvider } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { NoteStatusBar } from './note-status-bar.tsx'

vi.mock('@/lib/use-today.ts', () => ({ useToday: () => '2026-10-03' }))
const settings = vi.hoisted(() => ({
  statusBarEnabled: true,
  timeFormat: '12h',
  dateFormat: 'mdy',
}))
vi.mock('@/providers/settings-provider.tsx', () => ({ useSettings: () => ({ settings }) }))
const mtime = vi.hoisted(() => ({ value: null as number | null }))
vi.mock('@/hooks/use-note-mtime.ts', () => ({ useNoteMtime: () => mtime.value }))

const owner = Symbol('test')

function renderBar(initialRoute: Route) {
  return render(
    <RouterProvider initialRoute={initialRoute}>
      <NoteStatusBar />
    </RouterProvider>,
  )
}

afterEach(async () => {
  settings.statusBarEnabled = true
  mtime.value = null
  clearNoteStatus('notes/a.md', owner)
  clearNoteStatus('daily/2026-10-03.md', owner)
  await cleanup()
})

describe('NoteStatusBar', () => {
  it('shows the routed note’s live character count', async () => {
    publishNoteStatus('notes/a.md', owner, {
      characters: 1234,
      selectedCharacters: 0,
      editedAt: null,
    })
    await renderBar({ kind: 'note', path: 'notes/a.md' })

    await expect
      .element(page.getByRole('status', { name: 'Note status' }))
      .toHaveTextContent('1,234 chars')
  })

  it('follows today’s daily note on the daily stream', async () => {
    publishNoteStatus('daily/2026-10-03.md', owner, {
      characters: 42,
      selectedCharacters: 0,
      editedAt: null,
    })
    await renderBar({ kind: 'today' })

    await expect
      .element(page.getByRole('status', { name: 'Note status' }))
      .toHaveTextContent('42 chars')
  })

  it('stays out of screens that edit no note', async () => {
    publishNoteStatus('notes/a.md', owner, {
      characters: 1234,
      selectedCharacters: 0,
      editedAt: null,
    })
    const view = await renderBar({ kind: 'allNotes', filter: null })

    expect(view.container.querySelector('[role="status"]')).toBeNull()
  })

  it('stays hidden when turned off in settings', async () => {
    settings.statusBarEnabled = false
    publishNoteStatus('notes/a.md', owner, {
      characters: 1234,
      selectedCharacters: 0,
      editedAt: null,
    })
    const view = await renderBar({ kind: 'note', path: 'notes/a.md' })

    expect(view.container.querySelector('[role="status"]')).toBeNull()
  })

  it('shows when the note was last edited, preferring a newer in-pane edit', async () => {
    mtime.value = Date.now() - 5 * 60_000
    publishNoteStatus('notes/a.md', owner, {
      characters: 10,
      selectedCharacters: 0,
      editedAt: null,
    })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    const status = page.getByRole('status', { name: 'Note status' })
    await expect.element(status.getByText('Edited 5 min ago')).toBeVisible()

    await act(async () => {
      publishNoteStatus('notes/a.md', owner, {
        characters: 11,
        selectedCharacters: 0,
        editedAt: Date.now(),
      })
    })
    await expect.element(status.getByText('Edited just now')).toBeVisible()
  })

  it('counts the selection against the whole note', async () => {
    publishNoteStatus('notes/a.md', owner, {
      characters: 1234,
      selectedCharacters: 38,
      editedAt: null,
    })
    await renderBar({ kind: 'note', path: 'notes/a.md' })

    await expect
      .element(page.getByRole('status', { name: 'Note status' }))
      .toHaveTextContent('38 / 1,234 chars')
  })

  it('fades out while typing in an editor and returns on a mouse move', async () => {
    publishNoteStatus('notes/a.md', owner, {
      characters: 10,
      selectedCharacters: 0,
      editedAt: null,
    })
    const view = await renderBar({ kind: 'note', path: 'notes/a.md' })
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    view.container.append(editor)
    const bar = () => view.container.querySelector<HTMLElement>('[role="status"]')!

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    await vi.waitFor(() => expect(bar().className).toContain('opacity-0'))

    document.dispatchEvent(new MouseEvent('mousemove'))
    await vi.waitFor(() => expect(bar().className).not.toContain('opacity-0'))
  })
})
