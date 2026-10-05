import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry.ts'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import { getOperations, resetOperations } from '@/lib/operations.ts'
import type { Route } from '@/routing/route.ts'

const createAsset = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  createAsset,
  untitledNotePath: () => 'notes/new.md',
}))

const { createNoteFromFiles, noteMarkdownForFiles } = await import('./create-note-from-files.ts')

const TODAY: Route = { kind: 'today' }

const handle = { insertMarkdown: vi.fn() } as unknown as NoteEditorHandle & {
  insertMarkdown: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  resetOperations()
  createAsset.mockReset()
  handle.insertMarkdown.mockReset()
})

afterEach(() => {
  unregisterNoteEditorHandle('notes/new.md', handle)
})

describe('noteMarkdownForFiles', () => {
  it('titles the note after the first named file and lists every file', () => {
    expect(
      noteMarkdownForFiles(
        [
          { name: 'shot.png', type: 'image/png' },
          { name: 'Quarterly Report.pdf', type: 'application/pdf' },
        ],
        ['assets/shot.png', 'assets/quarterly-report.pdf'],
      ),
    ).toBe('# Quarterly Report\n\n![](assets/shot.png)\n\n![](assets/quarterly-report.pdf)')
  })

  it('leaves an image-only note untitled', () => {
    expect(
      noteMarkdownForFiles([{ name: 'shot.png', type: 'image/png' }], ['assets/shot.png']),
    ).toBe('#\n\n![](assets/shot.png)')
  })
})

describe('createNoteFromFiles', () => {
  it('copies the files, opens a new note, and fills its editor', async () => {
    createAsset.mockResolvedValue('assets/quarterly-report.pdf')
    const navigate = vi.fn(() => registerNoteEditorHandle('notes/new.md', handle, 4))

    await createNoteFromFiles(
      [new File(['x'], 'Quarterly Report.pdf', { type: 'application/pdf' })],
      4,
      { navigate, route: () => TODAY },
    )

    // The attachment is for the note about to open, named before the upload.
    expect(createAsset).toHaveBeenCalledWith(
      'quarterly-report.pdf',
      expect.anything(),
      'notes/new.md',
      4,
    )
    expect(navigate).toHaveBeenCalledWith({ kind: 'note', path: 'notes/new.md' })
    expect(handle.insertMarkdown).toHaveBeenCalledWith(
      '# Quarterly Report\n\n![](assets/quarterly-report.pdf)',
    )
  })

  it('opens nothing when no file could be copied', async () => {
    createAsset.mockRejectedValue(new Error('disk full'))
    const navigate = vi.fn()

    await createNoteFromFiles([new File(['x'], 'a.pdf')], 4, { navigate, route: () => TODAY })

    expect(navigate).not.toHaveBeenCalled()
    expect(getOperations().at(-1)).toMatchObject({ status: 'failed' })
  })

  it('leaves the user where they went while the files copied', async () => {
    let route: Route = TODAY
    createAsset.mockImplementation(async () => {
      route = { kind: 'tasks' }
      return 'assets/a.pdf'
    })
    const navigate = vi.fn()

    await createNoteFromFiles([new File(['x'], 'a.pdf')], 4, { navigate, route: () => route })

    expect(navigate).not.toHaveBeenCalled()
    expect(getOperations().at(-1)).toMatchObject({ status: 'warning' })
  })

  it('gives up on an editor that never mounts, even without animation frames', async () => {
    vi.useFakeTimers()
    try {
      createAsset.mockResolvedValue('assets/a.pdf')
      const navigate = vi.fn()

      const created = createNoteFromFiles([new File(['x'], 'a.pdf')], 4, {
        navigate,
        route: () => TODAY,
      })
      await vi.advanceTimersByTimeAsync(3100)
      await created

      expect(navigate).toHaveBeenCalled()
      expect(handle.insertMarkdown).not.toHaveBeenCalled()
      expect(getOperations().at(-1)).toMatchObject({ status: 'failed' })
    } finally {
      vi.useRealTimers()
    }
  })
})
