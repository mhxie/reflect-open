import { page } from 'vitest/browser'
import { describe, expect, it, vi } from 'vitest'
import {
  createTestCoreServices,
  createTestNoteFileService,
  createTestPlatformService,
  seedNotes,
} from '@reflect/core/testing'
import { MobileNote } from '@/mobile/screens/note.tsx'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'

/**
 * Conflict containment on the mobile note screen (Plan 19, step 10): a note
 * whose file carries sync conflict markers opens **protected** — the same
 * session contract as desktop (markers classify as lossy through the real
 * round-trip check) — with the raw file visible and the same marker-resolution
 * actions desktop offers. Only the ProseMirror view is stubbed (jsdom can't
 * host contenteditable).
 */

vi.mock('@/editor/note-editor.tsx', () => ({
  NoteEditor: () => <div data-testid="fake-editor" />,
}))

vi.mock('@/mobile/note-actions-menu.tsx', () => ({
  NoteActionsMenu: () => null,
}))

const CONFLICTED = [
  '# Standup',
  '<<<<<<< this device',
  '- phone line',
  '=======',
  '- desktop line',
  '>>>>>>> other device',
  '',
].join('\n')

describe('MobileNote with a conflicted note', () => {
  it('opens protected with raw markers and conflict resolution actions', async () => {
    // The file and its indexed row both carry the markers, as after a sync.
    const app = createTestCoreServices({
      platform: createTestPlatformService(MOBILE_PLATFORM),
      noteFile: createTestNoteFileService({ files: { 'notes/standup.md': CONFLICTED } }),
    })
    seedNotes(app.database, [{ path: 'notes/standup.md', markdown: CONFLICTED }])
    await renderInApp(<MobileNote path="notes/standup.md" />, {
      app,
      graph: { root: '/g', name: 'g', generation: 1 },
      route: { kind: 'note', path: 'notes/standup.md' },
      settings: { editorMarkdownSyntax: 'hide', editorDefaultBullet: false },
    })

    await expect.element(page.getByText(/choose what to keep/i)).toBeVisible()
    // Protected: raw file shown verbatim, no live editor mounted.
    await expect.element(page.getByText(/desktop line/)).toBeVisible()
    await expect.element(page.getByTestId('fake-editor')).not.toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: /keep this device’s version/i }))
      .toBeVisible()
    await expect
      .element(page.getByRole('button', { name: /keep the other device’s/i }))
      .toBeVisible()
    await expect.element(page.getByRole('button', { name: /keep both/i })).toBeVisible()
  })
})
