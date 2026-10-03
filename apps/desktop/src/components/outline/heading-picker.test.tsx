import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import {
  registerNoteEditorHandle,
  unregisterNoteEditorHandle,
} from '@/editor/editor-handle-registry.ts'
import type { NoteEditorHandle } from '@/editor/note-editor.tsx'
import { clearNoteOutline, publishNoteOutline } from '@/editor/outline/outline-store.ts'
import type { CommandContext } from '@/lib/commands/types.ts'
import { HeadingPickerProvider, useHeadingPicker } from '@/providers/heading-picker-provider.tsx'
import { HeadingPicker } from './heading-picker.tsx'

const PATH = 'notes/plan.md'
const owner = Symbol('test editor')
const reveal = vi.fn()

function commandContext(notePath: string | null): CommandContext {
  return {
    navigate: vi.fn(),
    route: () => ({ kind: 'note', path: PATH }),
    notePath: () => notePath,
    back: vi.fn(),
    forward: vi.fn(),
    clearScrollState: vi.fn(),
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
    generation: () => 1,
    graphRoot: () => '/notes',
    openPalette: vi.fn(),
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    openHeadingPicker: vi.fn(),
    enableSemanticSearch: vi.fn(),
    sortAllNotes: vi.fn(),
  }
}

function OpenOnMount() {
  const { openHeadingPicker } = useHeadingPicker()
  useEffect(() => {
    openHeadingPicker()
  }, [openHeadingPicker])
  return null
}

async function renderOpenPicker(notePath: string | null = PATH): Promise<void> {
  await render(
    <HeadingPickerProvider>
      <OpenOnMount />
      <HeadingPicker context={commandContext(notePath)} />
    </HeadingPickerProvider>,
  )
  // Typing before the dialog's autofocus lands would go to <body>.
  await expect.element(page.getByPlaceholder('Jump to heading…')).toHaveFocus()
}

afterEach(() => {
  clearNoteOutline(PATH, owner)
  reveal.mockReset()
})

describe('HeadingPicker', () => {
  it('lists the note headings and jumps to the chosen one', async () => {
    publishNoteOutline(PATH, owner, {
      headings: [
        { level: 2, text: 'Goals', position: 10 },
        { level: 2, text: 'Risks', position: 40 },
        { level: 2, text: 'Notes', position: 80 },
        { level: 2, text: 'Notes', position: 120 },
      ],
      activeIndex: null,
      reveal,
    })
    await renderOpenPicker()
    await expect.element(page.getByRole('option', { name: 'Risks' })).toBeInTheDocument()
    await expect.element(page.getByRole('option', { name: 'Notes' }).nth(1)).toBeInTheDocument()

    await userEvent.keyboard('risk')
    await expect.element(page.getByRole('option', { name: 'Goals' })).not.toBeInTheDocument()
    await userEvent.keyboard('{Enter}')

    expect(reveal).toHaveBeenCalledWith(1)
    await expect.element(page.getByPlaceholder('Jump to heading…')).not.toBeInTheDocument()
  })

  it('matches heading text, not the editor positions that keep rows distinct', async () => {
    publishNoteOutline(PATH, owner, {
      headings: [{ level: 2, text: 'Goals', position: 10 }],
      activeIndex: null,
      reveal,
    })
    await renderOpenPicker()
    await userEvent.keyboard('10')
    await expect.element(page.getByText('No matching headings')).toBeInTheDocument()
  })

  it('returns focus to the note editor when dismissed', async () => {
    const focus = vi.fn()
    const handle: NoteEditorHandle = {
      getMarkdown: () => '',
      setMarkdown: vi.fn(),
      insertMarkdown: vi.fn(),
      focus,
      setSelection: vi.fn(),
      getSelectedText: () => '',
      openSelectionMenu: vi.fn(),
      startPendingReplacement: () => false,
      appendPendingReplacementText: vi.fn(),
      acceptPendingReplacement: vi.fn(),
      discardPendingReplacement: vi.fn(),
      findNext: vi.fn(),
      findPrevious: vi.fn(),
    }
    registerNoteEditorHandle(PATH, handle)
    try {
      await renderOpenPicker()
      await userEvent.keyboard('{Escape}')
      await expect.element(page.getByPlaceholder('Jump to heading…')).not.toBeInTheDocument()
      expect(focus).toHaveBeenCalledTimes(1)
    } finally {
      unregisterNoteEditorHandle(PATH, handle)
    }
  })

  it('opens to the empty state for a note without section headings', async () => {
    await renderOpenPicker()
    await expect.element(page.getByText('No headings')).toBeInTheDocument()
  })
})
