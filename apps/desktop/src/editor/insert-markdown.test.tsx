import { describe, expect, it } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import '@/test-utils/locator.ts'
import { NoteEditor, type NoteEditorHandle } from './note-editor.tsx'

const pmRoot = page.locate('.ProseMirror')

describe('NoteEditorHandle.insertMarkdown', () => {
  it('inserts the fragment into the document through the meowdown handle', async () => {
    let handle: NoteEditorHandle | null = null
    await render(
      <NoteEditor
        privateNote={false}
        initialContent=""
        handleRef={(grabbed) => {
          handle = grabbed
        }}
      />,
    )
    await expect.element(pmRoot).toBeInTheDocument()

    handle!.insertMarkdown('# Journal\n\nMood:\n')
    await expect.element(page.getByText('Journal')).toBeInTheDocument()
    expect(handle!.getMarkdown()).toBe('# Journal\n\nMood:\n')
  })

  it('fills a blank note’s empty heading, then adds blocks after it', async () => {
    let handle: NoteEditorHandle | null = null
    await render(
      <NoteEditor
        privateNote={false}
        initialContent={'#\n'}
        handleRef={(grabbed) => {
          handle = grabbed
        }}
      />,
    )
    await expect.element(pmRoot).toBeInTheDocument()
    handle!.focus()

    handle!.insertMarkdown('# Quarterly Report\n\n[report.pdf](assets/report.pdf)')
    expect(handle!.getMarkdown()).toBe('# Quarterly Report\n\n[report.pdf](assets/report.pdf)\n')
  })

  it('keeps a blank note’s empty heading when the fragment brings its own', async () => {
    let handle: NoteEditorHandle | null = null
    await render(
      <NoteEditor
        privateNote={false}
        initialContent={'#\n'}
        handleRef={(grabbed) => {
          handle = grabbed
        }}
      />,
    )
    await expect.element(pmRoot).toBeInTheDocument()
    handle!.focus()

    handle!.insertMarkdown('#\n\n[shot.png](assets/shot.png)')
    expect(handle!.getMarkdown()).toBe('#\n\n[shot.png](assets/shot.png)\n')
  })
})
