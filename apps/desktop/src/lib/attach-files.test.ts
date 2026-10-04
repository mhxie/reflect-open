import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry.ts'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import type { CommandContext } from '@/lib/commands/types.ts'
import { getOperations, resetOperations } from '@/lib/operations.ts'
import { attachFilesToNote } from './attach-files.ts'

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openMock }))

/** This graph's local-only folders: `secure` is editable, `archive` read-only. */
function localOnlyFolderOf(path: string): string | null {
  const directories = path.split('/').slice(0, -1)
  const innermost = directories.findLastIndex((name) => name === 'secure' || name === 'archive')
  return innermost === -1 ? null : directories.slice(0, innermost + 1).join('/')
}
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  localOnlyFolderRoot: localOnlyFolderOf,
  isLocalOnlyReadOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('archive'),
}))

function contextFor(notePath: string | null, generation: number | null): CommandContext {
  return {
    navigate: vi.fn(),
    route: () => ({ kind: 'today' }),
    notePath: () => notePath,
    back: vi.fn(),
    forward: vi.fn(),
    togglePin: vi.fn(async () => {}),
    togglePrivate: vi.fn(async () => {}),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    openNoteFind: vi.fn(),
    findNextInNote: vi.fn(),
    findPreviousInNote: vi.fn(),
    switchGraph: vi.fn(),
    toggleAudioMemo: vi.fn(),
    generation: () => generation,
    graphRoot: () => '/g',
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

function editorHandle(): NoteEditorHandle & {
  insertMarkdown: ReturnType<typeof vi.fn<(markdown: string) => void>>
} {
  return {
    getMarkdown: () => '',
    setMarkdown: () => {},
    insertMarkdown: vi.fn<(markdown: string) => void>(),
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

afterEach(() => {
  setBridge(null)
  openMock.mockReset()
})

describe('attachFilesToNote', () => {
  it('refuses an editor handle rebound to a later graph generation during the picker', async () => {
    const path = 'finance/secure/bank.md'
    const handle = editorHandle()
    const invoke = vi.fn(async () => 'finance/secure/assets/private.pdf')
    setBridge({ invoke, listen: async () => () => {} })
    registerNoteEditorHandle(path, handle, 4)
    openMock.mockImplementation(async () => {
      registerNoteEditorHandle(path, handle, 5)
      return '/tmp/private.pdf'
    })
    await attachFilesToNote(contextFor(path, 4))
    expect(handle.insertMarkdown).not.toHaveBeenCalled()
    unregisterNoteEditorHandle(path, handle)
    resetOperations()
  })

  it('does not insert a copied private filename into another graph’s same-path editor', async () => {
    const path = 'finance/secure/bank.md'
    const original = editorHandle()
    const other = editorHandle()
    let rejectSecond: (cause: unknown) => void = () => {}
    const invoke = vi
      .fn()
      .mockResolvedValueOnce('finance/secure/assets/private-statement.pdf')
      .mockImplementationOnce(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectSecond = reject
          }),
      )
    setBridge({ invoke, listen: async () => () => {} })
    openMock.mockResolvedValue(['/tmp/private-statement.pdf', '/tmp/second.pdf'])
    registerNoteEditorHandle(path, original, 4)
    const attached = attachFilesToNote(contextFor(path, 4))
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2))
    registerNoteEditorHandle(path, other, 5)
    rejectSecond(new Error('stale graph'))
    await attached
    expect(original.insertMarkdown).not.toHaveBeenCalled()
    expect(other.insertMarkdown).not.toHaveBeenCalled()
    expect(getOperations().at(-1)?.message).toContain('private-statement.pdf were still copied')
    unregisterNoteEditorHandle(path, other)
    resetOperations()
  })

  it('imports each pick and inserts one per line at the caret, embedding PDFs', async () => {
    const invoke = vi.fn(async (_command: string, args: Record<string, unknown>) =>
      typeof args['desiredName'] === 'string' ? `assets/${args['desiredName'] as string}` : null,
    )
    setBridge({ invoke, listen: async () => () => {} })
    openMock.mockResolvedValue(['/Users/me/Q3 Report.pdf', '/Users/me/archive.tar.gz'])
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle, 4)

    await attachFilesToNote(contextFor('notes/plan.md', 4))

    expect(invoke).toHaveBeenCalledWith('asset_import', {
      sourcePath: '/Users/me/Q3 Report.pdf',
      desiredName: 'q3-report.pdf',
      notePath: 'notes/plan.md',
      generation: 4,
    })
    expect(handle.insertMarkdown).toHaveBeenCalledWith(
      '![](assets/q3-report.pdf)\n[archive.tar.gz](assets/archive-tar.gz)',
    )
    unregisterNoteEditorHandle('notes/plan.md', handle)
  })

  it('escapes bracketed filenames in the link label', async () => {
    const invoke = vi.fn(async () => 'assets/report-v2.docx')
    setBridge({ invoke, listen: async () => () => {} })
    openMock.mockResolvedValue('/tmp/report [v2].docx')
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle, 4)

    await attachFilesToNote(contextFor('notes/plan.md', 4))

    expect(handle.insertMarkdown).toHaveBeenCalledWith(
      String.raw`[report \[v2\].docx](assets/report-v2.docx)`,
    )
    unregisterNoteEditorHandle('notes/plan.md', handle)
  })

  it('does nothing without a routed note, a mounted editor, or a pick', async () => {
    const invoke = vi.fn(async () => 'assets/x')
    setBridge({ invoke, listen: async () => () => {} })

    await attachFilesToNote(contextFor(null, 4))
    expect(openMock).not.toHaveBeenCalled()

    // Routed note but no mounted editor for it.
    await attachFilesToNote(contextFor('notes/closed.md', 4))
    expect(openMock).not.toHaveBeenCalled()

    // Cancelled picker.
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle, 4)
    openMock.mockResolvedValue(null)
    await attachFilesToNote(contextFor('notes/plan.md', 4))
    expect(invoke).not.toHaveBeenCalled()
    expect(handle.insertMarkdown).not.toHaveBeenCalled()
    unregisterNoteEditorHandle('notes/plan.md', handle)
  })

  it('re-resolves the editor after the picker and drops the insert when it unmounted', async () => {
    const invoke = vi.fn(async () => 'assets/report.pdf')
    setBridge({ invoke, listen: async () => () => {} })
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle, 4)
    // The pane unmounts while the (native, unbounded) picker is open.
    openMock.mockImplementation(async () => {
      unregisterNoteEditorHandle('notes/plan.md', handle)
      return '/tmp/report.pdf'
    })

    await attachFilesToNote(contextFor('notes/plan.md', 4))

    // The copy still happened (the file exists in assets/) but nothing is
    // dispatched into the dead editor.
    expect(invoke).toHaveBeenCalledWith('asset_import', expect.anything())
    expect(handle.insertMarkdown).not.toHaveBeenCalled()
  })

  it('continues past a failed copy and still links every file that landed', async () => {
    const invoke = vi.fn(async (_command: string, args: Record<string, unknown>) => {
      if (args['sourcePath'] === '/tmp/bad.bin') {
        throw { kind: 'io', message: 'copy failed' }
      }
      return `assets/${args['desiredName'] as string}`
    })
    setBridge({ invoke, listen: async () => () => {} })
    // The failure comes FIRST: the files picked after it must still import.
    openMock.mockResolvedValue(['/tmp/bad.bin', '/tmp/good.pdf', '/tmp/also good.pdf'])
    const handle = editorHandle()
    registerNoteEditorHandle('notes/plan.md', handle, 4)

    await attachFilesToNote(contextFor('notes/plan.md', 4))

    expect(handle.insertMarkdown).toHaveBeenCalledWith(
      '![](assets/good.pdf)\n![](assets/also-good.pdf)',
    )
    unregisterNoteEditorHandle('notes/plan.md', handle)
  })

  it('copies into an editable local-only note’s own folder and links it from the vault root', async () => {
    const invoke = vi.fn(async (_command: string, args: Record<string, unknown>) =>
      typeof args['desiredName'] === 'string'
        ? `finance/secure/assets/${args['desiredName'] as string}`
        : null,
    )
    setBridge({ invoke, listen: async () => () => {} })
    openMock.mockResolvedValue(['/Users/me/Q3 Report.pdf', '/Users/me/scan.png'])
    const handle = editorHandle()
    registerNoteEditorHandle('finance/secure/bank.md', handle, 4)

    await attachFilesToNote(contextFor('finance/secure/bank.md', 4))

    expect(invoke).toHaveBeenCalledWith('asset_import', {
      sourcePath: '/Users/me/Q3 Report.pdf',
      desiredName: 'q3-report.pdf',
      notePath: 'finance/secure/bank.md',
      generation: 4,
    })
    expect(handle.insertMarkdown).toHaveBeenCalledWith(
      '![](/finance/secure/assets/q3-report.pdf)\n[scan.png](/finance/secure/assets/scan.png)',
    )
    unregisterNoteEditorHandle('finance/secure/bank.md', handle)
  })

  it('names the local-only folder that kept the copies when the note closed meanwhile', async () => {
    const invoke = vi.fn(async () => 'finance/secure/assets/report.pdf')
    setBridge({ invoke, listen: async () => () => {} })
    const handle = editorHandle()
    registerNoteEditorHandle('finance/secure/bank.md', handle, 4)
    openMock.mockImplementation(async () => {
      unregisterNoteEditorHandle('finance/secure/bank.md', handle)
      return '/tmp/report.pdf'
    })

    await attachFilesToNote(contextFor('finance/secure/bank.md', 4))

    expect(getOperations().at(-1)?.message).toMatch(/still copied into finance\/secure\/assets\//)
    resetOperations()
  })

  it('takes nothing into a read-only local-only note', async () => {
    const invoke = vi.fn(async () => 'assets/x')
    setBridge({ invoke, listen: async () => () => {} })
    const handle = editorHandle()
    registerNoteEditorHandle('archive/2019/q1.md', handle, 4)

    await attachFilesToNote(contextFor('archive/2019/q1.md', 4))

    expect(openMock).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
    unregisterNoteEditorHandle('archive/2019/q1.md', handle)
  })
})
