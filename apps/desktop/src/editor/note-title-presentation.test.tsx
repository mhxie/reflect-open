import { createRef } from 'react'
import { expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import '@/test-utils/locator.ts'
import { NoteEditor, type NoteEditorHandle } from './note-editor.tsx'
import { MarkdownPreview } from './markdown-preview.tsx'
import { NoteTitlePresentationBridge } from './note-title-presentation.tsx'

it('shows a compact language title and reveals the unchanged source for editing', async () => {
  const handle = createRef<NoteEditorHandle>()
  const changed = vi.fn()
  await render(
    <>
      <NoteEditor
        initialContent={'# Anchoring (中文)\n\n正文'}
        privateNote
        onChange={changed}
        handleRef={handle}
      >
        <NoteTitlePresentationBridge metadata={{ displayTitle: 'Anchoring', lang: 'zh-CN' }} />
      </NoteEditor>
      <button type="button">Outside</button>
    </>,
  )
  const compact = page.getByRole('button', { name: 'Anchoring，中文' })
  await expect.element(compact).toBeVisible()
  const before = handle.current!.getMarkdown()
  expect(before).toContain('# Anchoring (中文)')
  await compact.click()
  await expect.element(page.locate('.reflect-title-presentation')).not.toBeInTheDocument()
  await expect.element(page.locate('.ProseMirror h1')).toHaveTextContent('Anchoring (中文)')
  await page.getByRole('button', { name: 'Outside' }).click()
  await expect.element(compact).toBeVisible()
  expect(handle.current!.getMarkdown()).toBe(before)
  expect(changed).not.toHaveBeenCalled()
})

it('uses language metadata alone with a simple H1 in reading and editing', async () => {
  const handle = createRef<NoteEditorHandle>()
  const source = '# Anchoring\n\n正文\n'
  await render(
    <>
      <NoteEditor initialContent={source} privateNote handleRef={handle} onChange={vi.fn()}>
        <NoteTitlePresentationBridge metadata={{ lang: 'zh-CN' }} />
      </NoteEditor>
      <button type="button">Outside</button>
    </>,
  )
  const title = page.getByRole('heading', { name: 'Anchoring，中文', level: 1 })
  await expect.element(title).toBeVisible()
  await title.click()
  await expect.element(page.locate('.ProseMirror h1')).toHaveTextContent('Anchoring中文')
  await expect.element(page.locate('.reflect-title-language')).toBeVisible()
  await expect.element(page.locate('.reflect-title-presentation')).not.toBeInTheDocument()
  await page.getByRole('button', { name: 'Outside' }).click()
  await expect.element(title).toBeVisible()
  expect(handle.current!.getMarkdown()).toBe(source)
})

it('applies the same presentation to a preview and respects embedded heading depth', async () => {
  await render(
    <MarkdownPreview
      content={'# Anchoring (中文)\n\n正文'}
      titleMetadata={{ displayTitle: 'Anchoring', lang: 'zh-CN' }}
      headingOffset={1}
      remoteEmbeds={false}
    />,
  )
  const heading = page.getByRole('heading', { level: 2 })
  await expect.element(heading).toHaveTextContent('Anchoring中文')
  await expect.element(heading.locate('sup')).toHaveTextContent('中文')
})

it('reveals an H1 that was autofocused before the presentation plugin installed', async () => {
  const changed = vi.fn()
  const source = '# Anchoring (中文)\n\n正文\n'
  let handle: NoteEditorHandle | null = null
  await render(
    <>
      <NoteEditor
        initialContent={source}
        privateNote
        onChange={changed}
        handleRef={(next) => {
          handle = next
          next?.focus()
        }}
      >
        <NoteTitlePresentationBridge metadata={{ displayTitle: 'Anchoring', lang: 'zh-CN' }} />
      </NoteEditor>
      <button type="button">Outside</button>
    </>,
  )
  await expect.element(page.locate('.ProseMirror')).toHaveFocus()
  await expect.element(page.locate('.ProseMirror h1')).toHaveTextContent('Anchoring (中文)')
  await expect.element(page.locate('.reflect-title-presentation')).not.toBeInTheDocument()
  // Blurring proves the plugin installed, rather than the assertion racing its timer.
  await page.getByRole('button', { name: 'Outside' }).click()
  await expect.element(page.getByRole('button', { name: 'Anchoring，中文' })).toBeVisible()
  expect(handle!.getMarkdown()).toBe(source)
  expect(changed).not.toHaveBeenCalled()
})
