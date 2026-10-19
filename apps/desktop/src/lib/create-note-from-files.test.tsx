import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestAppServices, type TestAppServices } from '@reflect/app/testing'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry.ts'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import type { Route } from '@/routing/route.ts'
import {
  createNoteFromFiles,
  noteMarkdownForFiles,
  type NoteFromFilesContext,
} from './create-note-from-files.ts'

const TODAY: Route = { kind: 'today' }

const handle = { insertMarkdown: vi.fn() } as unknown as NoteEditorHandle & {
  insertMarkdown: ReturnType<typeof vi.fn>
}

let app: TestCoreServices
let appServices: TestAppServices

beforeEach(() => {
  app = createTestCoreServices()
  app.graphSession.setGraph({ generation: 4 })
  appServices = createTestAppServices(app)
  vi.spyOn(app.noteCreation, 'untitledNotePath').mockReturnValue('notes/new.md')
  handle.insertMarkdown.mockReset()
})

afterEach(() => {
  unregisterNoteEditorHandle('notes/new.md', handle)
})

function contextFor(
  navigate: NoteFromFilesContext['navigate'],
  route: () => Route = () => TODAY,
): NoteFromFilesContext {
  return { services: app, app: appServices, navigate, route }
}

function noteOperation() {
  return app.progress.findByLabel('Creating note from files')
}

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
    const save = vi.spyOn(app.attachments, 'saveFile')
    const navigate = vi.fn(() => registerNoteEditorHandle('notes/new.md', handle, 4))

    await createNoteFromFiles(
      [new File(['x'], 'Quarterly Report.pdf', { type: 'application/pdf' })],
      4,
      contextFor(navigate),
    )

    // The attachment is for the note about to open, named before the upload,
    // and keeps the file's own name.
    expect(save).toHaveBeenCalledWith(expect.any(File), 'notes/new.md', { keepName: true })
    expect(app.attachments.saves()).toMatchObject([
      { name: 'Quarterly Report.pdf', notePath: 'notes/new.md', generation: 4 },
    ])
    expect(navigate).toHaveBeenCalledWith({ kind: 'note', path: 'notes/new.md' })
    expect(handle.insertMarkdown).toHaveBeenCalledWith(
      '# Quarterly Report\n\n![](assets/quarterly-report.pdf)',
    )
  })

  it('opens nothing when no file could be copied', async () => {
    app.attachments.failSaves({ kind: 'file', message: 'disk full' })
    const navigate = vi.fn()

    await createNoteFromFiles([new File(['x'], 'a.pdf')], 4, contextFor(navigate))

    expect(navigate).not.toHaveBeenCalled()
    expect(noteOperation()).toMatchObject({ status: 'failed', message: 'a.pdf: disk full' })
  })

  it('leaves the user where they went while the files copied', async () => {
    let route: Route = TODAY
    vi.spyOn(app.attachments, 'saveFile').mockImplementation(() => {
      route = { kind: 'tasks' }
      return Promise.resolve({ ok: true, path: 'assets/a.pdf', destination: 'assets/a.pdf' })
    })
    const navigate = vi.fn()

    await createNoteFromFiles(
      [new File(['x'], 'a.pdf')],
      4,
      contextFor(navigate, () => route),
    )

    expect(navigate).not.toHaveBeenCalled()
    expect(noteOperation()).toMatchObject({ status: 'warning' })
  })

  it('stops copying once another graph opens', async () => {
    const save = vi.spyOn(app.attachments, 'saveFile').mockImplementation(() => {
      app.graphSession.setGraph({ generation: 5 })
      return Promise.resolve({ ok: true, path: 'assets/a.pdf', destination: 'assets/a.pdf' })
    })
    const navigate = vi.fn(() => registerNoteEditorHandle('notes/new.md', handle, 4))

    await createNoteFromFiles(
      [new File(['x'], 'a.pdf'), new File(['y'], 'b.pdf')],
      4,
      contextFor(navigate),
    )

    expect(save).toHaveBeenCalledOnce()
    expect(noteOperation()).toMatchObject({
      status: 'warning',
      message: 'Not added: b.pdf: the graph it was dropped in is no longer open',
    })
  })

  it('gives up on an editor that never mounts, even without animation frames', async () => {
    const navigate = vi.fn()

    const created = createNoteFromFiles([new File(['x'], 'a.pdf')], 4, contextFor(navigate))
    await vi.waitFor(() => expect(navigate).toHaveBeenCalled())
    await app.clock.advance(3100)
    await created

    expect(handle.insertMarkdown).not.toHaveBeenCalled()
    expect(noteOperation()).toMatchObject({ status: 'failed' })
  })
})
