import { createRef } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MarkdownEditor, type EditorHandle } from '@meowdown/react'
import { createMarkdownSourceMap } from '@meowdown/core'
import { AllSelection, TextSelection } from '@prosekit/pm/state'
import { undo, redo } from '@prosekit/pm/history'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownPreview } from '@/editor/markdown-preview.tsx'
import { resolveWikilink } from '@/editor/resolve-wikilink.ts'
import { WikiAnchorsBridge } from './wiki-anchors-bridge.tsx'
import { revealPreviewHeading } from '@/editor/reveal-preview-heading.ts'
import { WikiArticleBridge } from './wiki-article-bridge.tsx'
import { wikiArticleKey } from './wiki-article-plugin.tsx'
import { noteArticleFor } from './wiki-article-store.ts'
import { wikiEditorRange } from './wiki-article-projection.ts'

vi.mock('@/providers/graph-provider.tsx', () => ({ useGraph: () => ({ graph: null }) }))
vi.mock('@/lib/open-url.ts', () => ({ openUrlSync: vi.fn() }))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      wikiTrustDisplay: 'inline',
      wikiTrustReportPath: '.harness/wiki-trust.json',
      wikiLanguages: [{ label: 'English', folder: 'wiki' }],
    },
  }),
}))

const SOURCE = [
  '# Example',
  '',
  'Lead <!-- claim:c1 -->**first** [ref][one]<!-- /claim:c1 --> and <!-- claim:c4 -->second [ref][two] [ref][other-page]<!-- /claim:c4 -->.',
  '',
  '## Several paragraphs',
  '',
  '<!-- claim:c7 -->',
  '',
  'Third paragraph.',
  '',
  'Fourth paragraph.<!-- /claim:c7 -->',
  '',
  '## Evidence',
  '',
  '```anchors c1',
  '@anchor: url:https://example.org/one | valid_at: 2020-01-02',
  '@pass: reviewer | status: verified | at: 2020-01-03',
  '```',
  '',
  '```anchors c4',
  '@anchor: url:https://example.org/one | valid_at: 2020-01-02',
  '@anchor: url:https://example.org/two | valid_at: 2020-01-02',
  '```',
  '',
  '```anchors c7',
  '```',
  '',
  '[one]: https://example.org/one "Study one, p. 2"',
  '[two]: https://example.org/two "Study two, p. 3"',
  '[other-page]: https://example.org/one "Study one, p. 7"',
  '',
  '## Revision Log',
  '',
  '- Old review history.',
  '',
].join('\n')

afterEach(async () => {
  await cleanup()
})

async function editorFixture(source = SOURCE, path = 'wiki/Example.md') {
  const ref = createRef<EditorHandle>()
  const onDocChange = vi.fn()
  const rendered = await render(
    <QueryClientProvider client={new QueryClient()}>
      <MarkdownEditor
        initialMarkdown={source}
        mode="hide"
        handleRef={ref}
        onDocChange={onDocChange}
        resolveWikilink={resolveWikilink}
      >
        <WikiAnchorsBridge onWikiLinkClick={vi.fn()} />
        <WikiArticleBridge path={path} onWikiLinkClick={vi.fn()} />
      </MarkdownEditor>
    </QueryClientProvider>,
  )
  await vi.waitFor(() => expect(ref.current?.getEditor()?.mounted).toBe(true))
  const editor = ref.current!.getEditor()!
  await vi.waitFor(() => expect(wikiArticleKey.getState(editor.state)).toBeDefined())
  return { ...rendered, editor, ref, onDocChange }
}

describe('article source projection', () => {
  it('wraps long translated article headings inside a narrow preview', async () => {
    const title = 'A Long Technical Article Title for a Narrow Reading Pane'
    const view = await render(
      <main style={{ width: '272px' }}>
        <MarkdownPreview
          content={`# ${title} (中文)\n\nReading prose.`}
          titleMetadata={{ displayTitle: title, lang: 'zh-CN' }}
        />
      </main>,
    )
    const main = view.container.querySelector('main')!
    expect(main.scrollWidth).toBeLessThanOrEqual(main.clientWidth + 1)
    expect(main.querySelector('h1')?.textContent).toBe(`${title}中文`)
    expect(main.querySelector('sup')?.textContent).toBe('中文')
  })

  it('keeps two claims in one paragraph with formatting and identical editor/preview numbering', async () => {
    const editable = await editorFixture()
    await vi.waitFor(() =>
      expect(editable.container.querySelectorAll('.wiki-article-reference')).toHaveLength(3),
    )
    expect(editable.container.querySelector('.wiki-article-reference')?.checkVisibility()).toBe(
      true,
    )
    const paragraph = editable.container.querySelector('[data-wiki-claim="c1"]')?.closest('p')
    expect(paragraph?.querySelector('[data-wiki-claim="c4"]')).not.toBeNull()
    expect(paragraph?.querySelector('strong')?.textContent).toContain('first')
    expect(
      [...editable.container.querySelectorAll('.wiki-article-reference')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['[1]', '[1]', '[2]'])
    const preview = await render(<MarkdownPreview content={SOURCE} />)
    expect(
      [...preview.container.querySelectorAll('.wiki-article-reference')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['[1]', '[1]', '[2]'])
    expect(preview.container.querySelector('[data-wiki-claim="c1"] strong')?.textContent).toContain(
      'first',
    )
    expect(preview.container.querySelectorAll('[data-wiki-claim="c7"]')).toHaveLength(2)
    expect(preview.container.querySelector('.wiki-article-revision')?.hasAttribute('open')).toBe(
      false,
    )
    expect(preview.container.querySelector('.wiki-article-revision')?.textContent).toContain(
      'Old review history.',
    )
    expect(editable.container.querySelector('[data-wiki-revision-folded]')?.checkVisibility()).toBe(
      false,
    )
  })

  it('keeps range toggles out of source and undo history; exact fragments never widen', async () => {
    const { editor, ref, container, onDocChange } = await editorFixture()
    const before = ref.current!.getMarkdown()
    noteArticleFor('wiki/Example.md')!.toggleRanges()
    await vi.waitFor(() =>
      expect(container.querySelectorAll('[data-wiki-claim-visible]').length).toBeGreaterThan(0),
    )
    expect(ref.current!.getMarkdown()).toBe(before)
    expect(onDocChange).not.toHaveBeenCalled()
    expect(undo(editor.state)).toBe(false)
    const preview = await render(<MarkdownPreview content={SOURCE} />)
    expect(revealPreviewHeading(preview.container, SOURCE, '^c7')).toBe(true)
    expect(preview.container.querySelectorAll('[data-wiki-claim-target]')).toHaveLength(2)
    expect(revealPreviewHeading(preview.container, SOURCE, '^c9')).toBe(false)
  })

  it('retains each locator in ascending groups and returns keyboard focus on close', async () => {
    const view = await render(<MarkdownPreview content={SOURCE} />)
    const trigger = view.getByRole('button', { name: 'Reference 1: Study one, p. 7' })
    await trigger.click()
    await expect.element(page.getByText('Study one, p. 7', { exact: true }).last()).toBeVisible()
    await userEvent.keyboard('{Escape}')
    await expect.element(trigger).toHaveFocus()
  })

  it('marks an ordinary prose edit pending once and restores text plus record on undo/redo', async () => {
    const { editor, ref } = await editorFixture()
    const before = ref.current!.getMarkdown()
    const projection = wikiArticleKey.getState(editor.state)!
    const claim = projection.index.claims.find((item) => item.id === 'c1')!
    const from = wikiEditorRange(projection.map, claim)!.from
    editor.view.dispatch(editor.state.tr.insertText('Changed ', from))
    expect(ref.current!.getMarkdown()).toContain('@pass: editor | status: pending')
    expect(ref.current!.getMarkdown()).toContain(
      '@pass: reviewer | status: verified | at: 2020-01-03',
    )
    expect(ref.current!.getMarkdown().match(/@pass: editor/g)).toHaveLength(1)
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(ref.current!.getMarkdown()).toBe(before)
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(ref.current!.getMarkdown()).toContain('@pass: editor | status: pending')
  })

  it('records no review work when the file is reloaded with changed claim text', async () => {
    const { ref } = await editorFixture()
    const reloaded = SOURCE.replace('**first**', '**first, revised on disk**')
    ref.current!.setMarkdown(reloaded)
    expect(ref.current!.getMarkdown()).toContain('revised on disk')
    expect(ref.current!.getMarkdown()).not.toContain('@pass: editor')
  })

  it('copies prose without ownership, cuts a whole range with endpoints, and blocks a partial cut', async () => {
    const { editor, ref } = await editorFixture()
    const projection = wikiArticleKey.getState(editor.state)!
    const claim = projection.index.claims.find((item) => item.id === 'c1')!
    const range = wikiEditorRange(projection.map, claim)!
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, range.from, range.to)),
    )
    const copy = new DataTransfer()
    editor.view.dom.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: copy, bubbles: true, cancelable: true }),
    )
    expect(copy.getData('text/plain')).not.toContain('claim:c1')
    expect(copy.getData('text/html')).not.toContain('claim:c1')
    expect(copy.getData('text/html')).toContain('data-md-references')
    const before = ref.current!.getMarkdown()
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, range.from + 2, range.to),
      ),
    )
    const partial = new ClipboardEvent('cut', {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    })
    editor.view.dom.dispatchEvent(partial)
    expect(partial.defaultPrevented).toBe(true)
    expect(ref.current!.getMarkdown()).toBe(before)
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, range.from, range.to)),
    )
    const cut = new DataTransfer()
    editor.view.dom.dispatchEvent(
      new ClipboardEvent('cut', { clipboardData: cut, bubbles: true, cancelable: true }),
    )
    expect(cut.getData('text/html')).toContain('claim:c1')
    expect(ref.current!.getMarkdown()).not.toContain('<!-- claim:c1 -->')
    expect(ref.current!.getMarkdown()).not.toContain('<!-- /claim:c1 -->')
    expect(wikiArticleKey.getState(editor.state)!.index.diagnostics).toEqual([])
    expect(cut.getData('text/plain')).toContain('```anchors c1')
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(ref.current!.getMarkdown()).toBe(before)
  })

  it('keeps passive article previews free of controls and preserves a paragraph split inside its ID', async () => {
    const preview = await render(<MarkdownPreview content={SOURCE} interactive={false} />)
    expect(preview.container.querySelector('a, button, summary, [tabindex]')).toBeNull()
    const { editor, ref } = await editorFixture()
    const map = createMarkdownSourceMap(editor.state.doc)
    const at = map.sourceToEditor(map.markdown.indexOf('Third paragraph.') + 5)!
    editor.view.dispatch(editor.state.tr.split(at))
    const index = wikiArticleKey.getState(editor.state)!.index
    expect(index.claims.map((claim) => claim.id)).toEqual(['c1', 'c4', 'c7'])
    expect(index.diagnostics).toEqual([])
    expect(ref.current!.getMarkdown()).toContain('Third\n\n paragraph.')
  })

  it('renders an exact hover excerpt in its full emphasis context and rejects missing claims', async () => {
    const content =
      '# Title\n\n**before <!-- claim:c3 -->中文 😀 selected<!-- /claim:c3 --> after**\n\n## Evidence\n\n```anchors c3\n```'
    const view = await render(
      <MarkdownPreview content={content} claimFragment="^c3" interactive={false} />,
    )
    expect(view.container.textContent).toContain('中文 😀 selected')
    expect(view.container.textContent).not.toContain('before')
    expect(view.container.textContent).not.toContain('after')
    expect(view.container.querySelector('strong')?.textContent).toContain('中文 😀 selected')
    expect(view.container.querySelector('h1')).toBeNull()
    await view.rerender(
      <MarkdownPreview content={content} claimFragment="^c9" interactive={false} />,
    )
    expect(view.container.textContent).toBe('')
  })

  it('strips claim ledgers from whole-note prose HTML copy', async () => {
    const { editor } = await editorFixture()
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    const data = new DataTransfer()
    editor.view.dom.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    expect(data.getData('text/html')).not.toContain('anchors c1')
    expect(data.getData('text/html')).not.toContain('@pass: reviewer')
    expect(data.getData('text/html')).not.toContain('claim:c1')
    expect(data.getData('text/plain')).not.toContain('@anchor')
  })

  it('moves a cut range with its records and reference locator into another note', async () => {
    const source = await editorFixture()
    const destination = await editorFixture(
      '# Destination\n\nLanding.\n\n[one]: https://example.org/one "Different page"',
      'wiki/Destination.md',
    )
    const projection = wikiArticleKey.getState(source.editor.state)!
    const range = wikiEditorRange(
      projection.map,
      projection.index.claims.find((claim) => claim.id === 'c1')!,
    )!
    source.editor.view.dispatch(
      source.editor.state.tr.setSelection(
        TextSelection.create(source.editor.state.doc, range.from, range.to),
      ),
    )
    const data = new DataTransfer()
    source.editor.view.dom.dispatchEvent(
      new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    expect(data.getData('text/html')).toContain('Study one, p. 2')
    const landing = createMarkdownSourceMap(destination.editor.state.doc)
    const at = landing.sourceToEditor(landing.markdown.indexOf('Landing.') + 8)!
    destination.editor.view.dispatch(
      destination.editor.state.tr.setSelection(
        TextSelection.create(destination.editor.state.doc, at),
      ),
    )
    destination.editor.view.dom.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    const index = wikiArticleKey.getState(destination.editor.state)!.index
    expect(destination.ref.current!.getMarkdown()).toContain('[ONE-2]')
    expect(index.diagnostics).toEqual([])
    expect(index.claims.map((claim) => claim.id)).toEqual(['c1'])
    expect(index.references[0]?.locator).toBe('Study one, p. 2')
    expect(index.ledgers[0]?.raw).toContain('@pass: reviewer | status: verified | at: 2020-01-03')
    expect(wikiArticleKey.getState(source.editor.state)!.index.diagnostics).toEqual([])
    expect(destination.ref.current!.getMarkdown()).toContain('[ONE-2]')
  })

  it('copy-drags prose without duplicating its ID and moves records across notes', async () => {
    const source = await editorFixture()
    const projection = wikiArticleKey.getState(source.editor.state)!
    const range = wikiEditorRange(
      projection.map,
      projection.index.claims.find((claim) => claim.id === 'c1')!,
    )!
    source.editor.view.dispatch(
      source.editor.state.tr.setSelection(
        TextSelection.create(source.editor.state.doc, range.from, range.to),
      ),
    )
    const copy = new DataTransfer()
    source.editor.view.dom.dispatchEvent(
      new DragEvent('dragstart', {
        dataTransfer: copy,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    const sourceMap = createMarkdownSourceMap(source.editor.state.doc)
    const position = sourceMap.sourceToEditor(sourceMap.markdown.indexOf('Lead '))!
    const coordinates = source.editor.view.coordsAtPos(position)
    source.editor.view.dom.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: copy,
        altKey: true,
        bubbles: true,
        cancelable: true,
        clientX: coordinates.left + 1,
        clientY: coordinates.top + 2,
      }),
    )
    expect(
      wikiArticleKey.getState(source.editor.state)!.index.claims.map((claim) => claim.id),
    ).toEqual(['c1', 'c4', 'c7'])
    expect(wikiArticleKey.getState(source.editor.state)!.index.diagnostics).toEqual([])

    const destination = await editorFixture(
      '# Destination\n\nLanding.\n\n[one]: https://example.org/one "Different page"',
      'wiki/Destination.md',
    )
    const next = wikiArticleKey.getState(source.editor.state)!
    const movedRange = wikiEditorRange(
      next.map,
      next.index.claims.find((claim) => claim.id === 'c1')!,
    )!
    source.editor.view.dispatch(
      source.editor.state.tr.setSelection(
        TextSelection.create(source.editor.state.doc, movedRange.from, movedRange.to),
      ),
    )
    const move = new DataTransfer()
    source.editor.view.dom.dispatchEvent(
      new DragEvent('dragstart', { dataTransfer: move, bubbles: true, cancelable: true }),
    )
    const targetMap = createMarkdownSourceMap(destination.editor.state.doc)
    const target = targetMap.sourceToEditor(targetMap.markdown.indexOf('Landing.') + 8)!
    const targetCoordinates = destination.editor.view.coordsAtPos(target)
    destination.editor.view.dom.dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: move,
        bubbles: true,
        cancelable: true,
        clientX: targetCoordinates.left - 1,
        clientY: targetCoordinates.top + 2,
      }),
    )
    const index = wikiArticleKey.getState(destination.editor.state)!.index
    expect(index.diagnostics).toEqual([])
    expect(index.claims.map((claim) => claim.id)).toEqual(['c1'])
    expect(index.references[0]?.locator).toBe('Study one, p. 2')
    expect(index.ledgers[0]?.raw).toContain('@pass: reviewer | status: verified')
    expect(wikiArticleKey.getState(source.editor.state)!.index.diagnostics).toEqual([])
  })

  it('records pending text edits for an existing claim without a ledger', async () => {
    const { editor, ref } = await editorFixture(SOURCE.replace('```anchors c7\n```\n\n', ''))
    const projection = wikiArticleKey.getState(editor.state)!
    const claim = projection.index.claims.find((item) => item.id === 'c7')!
    const from = TextSelection.near(
      editor.state.doc.resolve(wikiEditorRange(projection.map, claim)!.from),
      1,
    ).from
    editor.view.dispatch(editor.state.tr.insertText('Changed ', from))
    expect(
      wikiArticleKey.getState(editor.state)!.index.ledgers.find((ledger) => ledger.owner === 'c7')
        ?.raw,
    ).toContain('@pass: editor | status: pending')
    expect(wikiArticleKey.getState(editor.state)!.index.diagnostics).toEqual([])
    expect(ref.current!.getMarkdown()).toContain('@pass: reviewer | status: verified')
  })

  it('keeps moved markers portable at a paragraph start', async () => {
    const source = await editorFixture()
    const destination = await editorFixture('# Destination\n\nLanding.', 'wiki/Destination.md')
    const projection = wikiArticleKey.getState(source.editor.state)!
    const range = wikiEditorRange(
      projection.map,
      projection.index.claims.find((claim) => claim.id === 'c1')!,
    )!
    source.editor.view.dispatch(
      source.editor.state.tr.setSelection(
        TextSelection.create(source.editor.state.doc, range.from, range.to),
      ),
    )
    const data = new DataTransfer()
    source.editor.view.dom.dispatchEvent(
      new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    expect(data.getData('text/plain')).toContain('<!-- claim:c1 -->\n\n')
    const map = createMarkdownSourceMap(destination.editor.state.doc)
    const position = map.sourceToEditor(map.markdown.indexOf('Landing.'))!
    destination.editor.view.dispatch(
      destination.editor.state.tr.setSelection(
        TextSelection.create(destination.editor.state.doc, position),
      ),
    )
    destination.editor.view.dom.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    expect(wikiArticleKey.getState(destination.editor.state)!.index.diagnostics).toEqual([])
    expect(
      wikiArticleKey.getState(destination.editor.state)!.index.claims.map((claim) => claim.id),
    ).toEqual(['c1'])
    expect(destination.ref.current!.getMarkdown()).toContain('<!-- claim:c1 -->\n\n**first**')
    expect(destination.ref.current!.getMarkdown()).toContain('Landing.')
  })

  it('replaces the production wikilink reference mark view with exactly one article number', async () => {
    const content = SOURCE.replace(
      'Third paragraph.',
      'Third paragraph. [[Related#^c1|ref]]<!-- {"metadata":{"citation":{"valid_at":"2020-01-02"}}} -->',
    )
    const { container } = await editorFixture(content)
    await vi.waitFor(() =>
      expect(container.querySelectorAll('.wiki-article-reference')).toHaveLength(4),
    )
    const native = container.querySelector('.md-wikilink-view-preview.meowdown-reference')
    expect(native).not.toBeNull()
    expect(native?.checkVisibility()).toBe(false)
    expect(
      [...container.querySelectorAll('.wiki-article-reference')].every((node) =>
        node.checkVisibility(),
      ),
    ).toBe(true)
  })

  it('preserves enclosing emphasis when moving an exact claim slice', async () => {
    const content =
      '# Source\n\n**before <!-- claim:c3 -->selected<!-- /claim:c3 --> after**\n\n## Evidence\n\n```anchors c3\n```'
    const source = await editorFixture(content)
    const destination = await editorFixture('# Destination\n\nLanding.', 'wiki/Destination.md')
    const projection = wikiArticleKey.getState(source.editor.state)!
    const range = wikiEditorRange(projection.map, projection.index.claims[0]!)!
    source.editor.view.dispatch(
      source.editor.state.tr.setSelection(
        TextSelection.create(source.editor.state.doc, range.from, range.to),
      ),
    )
    const data = new DataTransfer()
    source.editor.view.dom.dispatchEvent(
      new ClipboardEvent('cut', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    const map = createMarkdownSourceMap(destination.editor.state.doc)
    const at = map.sourceToEditor(map.markdown.indexOf('Landing.') + 8)!
    destination.editor.view.dispatch(
      destination.editor.state.tr.setSelection(
        TextSelection.create(destination.editor.state.doc, at),
      ),
    )
    destination.editor.view.dom.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    )
    expect(wikiArticleKey.getState(destination.editor.state)!.index.diagnostics).toEqual([])
    expect(destination.container.querySelector('strong')?.textContent).toContain('selected')
    expect(wikiArticleKey.getState(source.editor.state)!.index.diagnostics).toEqual([])
  })

  it('reveals original citation syntax for deliberate editing and folds it with Escape', async () => {
    const view = await editorFixture()
    const before = view.ref.current!.getMarkdown()
    await view.getByRole('button', { name: 'Reference 1: Study one, p. 2' }).click()
    await page.getByRole('button', { name: 'Edit citation' }).click()
    await vi.waitFor(() => {
      const marker = view.container.querySelector<HTMLElement>('.md-mark:has(.show)')
      expect(marker).not.toBeNull()
      expect(Number.parseFloat(getComputedStyle(marker!).fontSize)).toBeGreaterThan(0)
    })
    expect(view.ref.current!.getMarkdown()).toBe(before)
    await userEvent.keyboard('{Escape}')
    await expect
      .element(view.getByRole('button', { name: 'Reference 1: Study one, p. 2' }))
      .toBeVisible()
  })
})
