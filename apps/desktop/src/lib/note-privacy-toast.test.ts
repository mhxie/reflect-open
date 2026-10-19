import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  createNodeTestDatabaseService,
  createTestCoreServices,
  createTestNoteFileService,
} from '@reflect/core/testing'
import type { MockToastAddOptions } from '@/test-utils/toast.ts'
import { setNotesPrivate, toggleNotePrivate } from './note-privacy-toast.ts'

const toast = vi.hoisted(() => ({ add: vi.fn<(options: MockToastAddOptions) => string>() }))

vi.mock('@/components/ui/toast.tsx', () => ({ toast }))

afterEach(() => {
  toast.add.mockClear()
})

function setup(files: Record<string, string>) {
  const noteFile = createTestNoteFileService({ files })
  const core = createTestCoreServices({ database: createNodeTestDatabaseService(), noteFile })
  onTestFinished(() => core.database.close())
  core.graphSession.setGraph({ root: '/g', generation: 3 })
  return { noteActions: core.noteActions, noteFile }
}

/**
 * Click the Undo on the newest toast.
 */
function undo(): void {
  toast.add.mock.lastCall?.[0].actionProps?.onClick()
}

describe('toggleNotePrivate', () => {
  it('confirms a toggle and puts the note back on Undo', async () => {
    const { noteActions, noteFile } = setup({ 'notes/a.md': '# A\n' })

    await toggleNotePrivate(noteActions, 'notes/a.md')

    expect(noteFile.files().get('notes/a.md')).toBe('---\nprivate: true\n---\n\n# A\n')
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: 'Marked private' }))
    undo()
    await vi.waitFor(() => expect(noteFile.files().get('notes/a.md')).toBe('# A\n'))
  })

  it('says a note is no longer private when the toggle unlocks it', async () => {
    const { noteActions } = setup({ 'notes/a.md': '---\nprivate: true\n---\n# A\n' })

    await toggleNotePrivate(noteActions, 'notes/a.md')

    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: 'No longer private' }))
  })

  it('offers no Undo when nothing was written', async () => {
    const { noteActions } = setup({ 'notes/a.md': '---\nprivate: maybe\n---\n# A\n' })

    await toggleNotePrivate(noteActions, 'notes/a.md')

    expect(toast.add).not.toHaveBeenCalled()
  })
})

describe('setNotesPrivate', () => {
  it('marks every listed note, skips ones already private, and undoes only its own changes', async () => {
    const { noteActions, noteFile } = setup({
      'notes/a.md': '# A\n',
      'notes/b.md': '---\nprivate: true\n---\n# B\n',
      'daily/2026-10-01.md': '- standup\n',
    })

    const result = await setNotesPrivate(
      noteActions,
      ['notes/a.md', 'notes/b.md', 'daily/2026-10-01.md'],
      true,
    )

    expect(result).toEqual({ changed: ['notes/a.md', 'daily/2026-10-01.md'], skipped: 0 })
    expect(toast.add).toHaveBeenCalledOnce()
    expect(toast.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Marked 2 notes private' }),
    )
    undo()
    await vi.waitFor(() => expect(noteFile.files().get('daily/2026-10-01.md')).toBe('- standup\n'))
    expect(noteFile.files().get('notes/a.md')).toBe('# A\n')
    expect(noteFile.files().get('notes/b.md')).toBe('---\nprivate: true\n---\n# B\n')
  })

  it('counts unreadable notes as skipped and stays quiet when nothing changed', async () => {
    const { noteActions } = setup({ 'notes/a.md': '---\nprivate: maybe\n---\n# A\n' })

    await expect(setNotesPrivate(noteActions, ['notes/a.md'], false)).resolves.toEqual({
      changed: [],
      skipped: 1,
    })
    expect(toast.add).not.toHaveBeenCalled()
  })
})
