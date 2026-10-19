import { createTestAppServices, type TestAppServices } from '@reflect/app/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestCoreServices, type TestCoreServices } from '@reflect/core/testing'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry.ts'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import type { CommandContext } from '@/lib/commands/types.ts'
import { attachFilesToNote } from './attach-files.ts'

let app: TestCoreServices
let appLayer: TestAppServices

beforeEach(() => {
  app = createTestCoreServices()
  appLayer = createTestAppServices(app)
  app.graphSession.setGraph({ generation: 4 })
})

afterEach(() => {
  app.database.close()
})

function contextFor(notePath: string | null): CommandContext {
  return {
    services: app,
    app: appLayer,
    navigate: vi.fn(),
    route: () => ({ kind: 'today' }),
    notePath: () => notePath,
    back: vi.fn(),
    forward: vi.fn(),
    togglePin: vi.fn(() => {}),
    togglePrivate: vi.fn(() => {}),
    showNoteDetails: vi.fn(),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    openNoteFind: vi.fn(),
    findNextInNote: vi.fn(),
    findPreviousInNote: vi.fn(),
    switchGraph: vi.fn(),
    openPinnedNote: vi.fn(),
    toggleAudioMemo: vi.fn(),
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openHeadingPicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
    sortAllNotes: vi.fn(),
    wikiLanguages: () => [],
    clearScrollState: vi.fn(),
  }
}

function editorHandle(): NoteEditorHandle {
  return {
    getMarkdown: () => '',
    setMarkdown: () => {},
    insertMarkdown: vi.fn(),
    focus: () => {},
    setSelection: () => {},
    getSelectedText: () => '',
    openSelectionMenu: () => {},
    startPendingReplacement: () => false,
    appendPendingReplacementText: () => {},
    acceptPendingReplacement: () => {},
    discardPendingReplacement: () => {},
    findNext: () => {},
    findPrevious: () => {},
    revealHeading: () => false,
  }
}

describe('attachFilesToNote', () => {
  it("attaches the picked files into the routed note's editor, looked up on every call", async () => {
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle, 4)
    appLayer.dialog.setFiles(['/tmp/a.pdf'])

    await attachFilesToNote(contextFor('notes/plan.md'))

    expect(appLayer.dialog.calls()).toEqual([
      { kind: 'files', options: { multiple: true, title: 'Attach files' } },
    ])
    const [request] = app.attachments.attachRequests()
    expect(request?.notePath).toBe('notes/plan.md')
    expect(request?.sources).toEqual(['/tmp/a.pdf'])
    expect(request?.findEditor()).toBe(handle)
    unregisterNoteEditorHandle('notes/plan.md', handle)
    expect(request?.findEditor()).toBeNull()
  })

  it('does nothing without a routed note, an editor, a graph session or a pick', async () => {
    appLayer.dialog.setFiles(['/tmp/a.pdf'])
    await attachFilesToNote(contextFor(null))
    await attachFilesToNote(contextFor('notes/plan.md'))
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle, 4)
    app.graphSession.setGraph(null)
    await attachFilesToNote(contextFor('notes/plan.md'))
    app.graphSession.setGraph({ generation: 4 })
    appLayer.dialog.setFiles(null)
    await attachFilesToNote(contextFor('notes/plan.md'))
    unregisterNoteEditorHandle('notes/plan.md', handle)

    expect(app.attachments.attachRequests()).toEqual([])
    expect(appLayer.dialog.calls()).toHaveLength(1)
  })

  it('never hands over an editor handle rebound to a later graph generation during the picker', async () => {
    const path = 'finance/secure/bank.md'
    const handle = editorHandle()
    registerNoteEditorHandle(path, handle, 4)
    vi.spyOn(appLayer.dialog, 'pickFiles').mockImplementation(() => {
      registerNoteEditorHandle(path, handle, 5)
      return ['/tmp/private.pdf']
    })

    await attachFilesToNote(contextFor(path))

    const [request] = app.attachments.attachRequests()
    expect(request?.findEditor()).toBeNull()
    expect(handle.insertMarkdown).not.toHaveBeenCalled()
    unregisterNoteEditorHandle(path, handle)
  })

  it('takes nothing into a read-only local-only note', async () => {
    app.graphSession.setGraph({ generation: 4, localOnlyFolders: ['archive'] })
    const handle = editorHandle()
    registerNoteEditorHandle('archive/2019/q1.md', handle, 4)
    appLayer.dialog.setFiles(['/tmp/a.pdf'])

    await attachFilesToNote(contextFor('archive/2019/q1.md'))

    expect(appLayer.dialog.calls()).toEqual([])
    expect(app.attachments.attachRequests()).toEqual([])
    unregisterNoteEditorHandle('archive/2019/q1.md', handle)
  })

  it('attaches into an editable local-only note, whose own folder takes the copies', async () => {
    app.graphSession.setGraph({
      generation: 4,
      localOnlyFolders: ['secure'],
      localOnlyEditableFolders: ['secure'],
    })
    const handle = editorHandle()
    registerNoteEditorHandle('finance/secure/bank.md', handle, 4)
    appLayer.dialog.setFiles(['/Users/me/Q3 Report.pdf'])

    await attachFilesToNote(contextFor('finance/secure/bank.md'))

    const [request] = app.attachments.attachRequests()
    expect(request?.notePath).toBe('finance/secure/bank.md')
    expect(request?.sources).toEqual(['/Users/me/Q3 Report.pdf'])
    unregisterNoteEditorHandle('finance/secure/bank.md', handle)
  })
})
