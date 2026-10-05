import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { useSyncExternalStore } from 'react'
import type { PrivateNoteOptions, PrivateNoteState } from '@/hooks/use-private-note.ts'
import { deferred } from '@/test-utils/deferred.ts'
import { MarkdownPreview } from './markdown-preview.tsx'
import { NoteEmbedReader, type NoteEmbedReaderOptions } from './note-embed-reader.tsx'
import { NoteEditor, type NoteEditorHandle } from './note-editor.tsx'
import { OutlineBridge } from './outline/outline-bridge.tsx'
import { noteOutlineFor } from './outline/outline-store.ts'
import { OutlineSection } from '@/components/context-sidebar/outline-section.tsx'

const IMAGE =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/%3E'
const mocks = vi.hoisted(() => ({
  resolveWiki: vi.fn(),
  resolveMarkdown: vi.fn(),
  read: vi.fn(),
  create: vi.fn(),
  navigate: vi.fn(),
  external: vi.fn(),
  attachments: vi.fn(),
  loadCatalog: vi.fn(),
  openAttachment: vi.fn(),
  privacy: vi.fn<(path: string, options: PrivateNoteOptions) => PrivateNoteState>(),
  privatePaths: new Set<string>(),
  privacyListeners: new Set<() => void>(),
  privacyRevision: 0,
  pending: false,
  sources: new Map<string, string>(),
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  resolveExistingWikiTarget: mocks.resolveWiki,
  resolveExistingMarkdownTarget: mocks.resolveMarkdown,
  resolveOrCreateNoteWithTitle: mocks.create,
}))
vi.mock('@/lib/read-existing-note-source.ts', () => ({ readExistingNoteSource: mocks.read }))
vi.mock('@/lib/use-file-changes.ts', () => ({ useFileChanges: () => {} }))
vi.mock('@/hooks/use-note-link-navigation.ts', () => ({
  useNoteLinkNavigation: () => mocks.navigate,
}))
vi.mock('@/editor/open-external-link.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/editor/open-external-link.ts')>()),
  useOpenExternalLink: () => mocks.external,
}))
vi.mock('@/hooks/use-private-note.ts', () => ({
  usePrivateNoteState: (path: string, options: PrivateNoteOptions) => {
    useSyncExternalStore(
      (listener) => {
        mocks.privacyListeners.add(listener)
        return () => mocks.privacyListeners.delete(listener)
      },
      () => mocks.privacyRevision,
    )
    return mocks.privacy(path, options)
  },
}))
vi.mock('@/editor/use-note-attachments.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/editor/use-note-attachments.ts')>()),
  useNoteAttachments: mocks.attachments,
}))
vi.mock('@/lib/attachment-catalog.ts', () => ({
  loadAttachmentCatalog: mocks.loadCatalog,
  peekAttachmentCatalog: () => null,
}))
vi.mock('@/lib/open-attachment.ts', () => ({ openAttachment: mocks.openAttachment }))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/graph-a', name: 'A', generation: 7 } }),
}))

const OPTIONS: NoteEmbedReaderOptions = {
  sourcePath: 'notes/Summary.md',
  generation: 7,
  graphKey: '/graph-a',
  ancestors: ['notes/Summary.md'],
  remoteEmbeds: true,
}
const resolveWikiEmbed = () => ({ kind: 'note' as const })

beforeEach(() => {
  mocks.sources.clear()
  mocks.sources.set(
    'notes/Original.md',
    `---\ntitle: Original\n---\n# Original\n\nOriginal paragraph\n\n## Details\n\n| Tool | Usage |\n| --- | --- |\n| Editor | 42 |`,
  )
  mocks.sources.set('notes/Child.md', '# Child\n\nChild paragraph')
  mocks.resolveWiki.mockReset().mockImplementation(async (target: string) => ({
    kind: 'resolved',
    path:
      target.replace(/^\//, '').split('#')[0] === 'Child' ? 'notes/Child.md' : 'notes/Original.md',
  }))
  mocks.resolveMarkdown
    .mockReset()
    .mockResolvedValue({ kind: 'resolved', path: 'notes/Sibling.md' })
  mocks.read.mockReset().mockImplementation(async (path: string) => mocks.sources.get(path) ?? '')
  mocks.create.mockReset()
  mocks.navigate.mockReset()
  mocks.external.mockReset()
  mocks.loadCatalog.mockReset().mockResolvedValue(undefined)
  mocks.openAttachment.mockReset().mockResolvedValue(undefined)
  mocks.privatePaths.clear()
  mocks.privacyListeners.clear()
  mocks.privacyRevision = 0
  mocks.pending = false
  mocks.privacy.mockReset().mockImplementation((path: string, options: PrivateNoteOptions) => ({
    privateNote:
      mocks.privatePaths.has(path) || path.startsWith('secure/') || options.privateHeader,
    pending: mocks.pending,
  }))
  mocks.attachments.mockReset().mockImplementation(() => ({
    resolveImageUrl: () => IMAGE,
    resolveWikiEmbed,
    resolveAttachmentPath: () => null,
  }))
})

function reader(options: Partial<NoteEmbedReaderOptions> = {}, target = 'Original') {
  return <NoteEmbedReader {...OPTIONS} {...options} target={target} display="Read original" />
}

async function outlinedReader(content: string) {
  let handle: NoteEditorHandle | null = null
  const view = await render(
    <div>
      <div
        data-testid="outline-scroller"
        style={{ height: 300, overflow: 'auto', overflowAnchor: 'none' }}
      >
        <NoteEditor
          privateNote={false}
          initialContent={content}
          handleRef={(next) => {
            handle = next
          }}
          resolveWikiEmbed={resolveWikiEmbed}
          renderNoteEmbed={(payload) => <NoteEmbedReader {...OPTIONS} {...payload} />}
        >
          <OutlineBridge path={OPTIONS.sourcePath} />
        </NoteEditor>
      </div>
      <OutlineSection path={OPTIONS.sourcePath} />
    </div>,
  )
  await vi.waitFor(() => expect(handle).not.toBeNull())
  return { view, markdown: () => handle!.getMarkdown() }
}

describe('embedded note outline', () => {
  it('includes complete demoted headings in reading order while the source is collapsed', async () => {
    mocks.sources.set(
      'notes/Original.md',
      `# Original\n\n## Details\n\n${'Long prose. '.repeat(600)}\n\n## Later\n\nLast paragraph`,
    )
    const content = '# Host\n\n## Before\n\n![[Original]]\n\n## After'
    const { view, markdown } = await outlinedReader(content)
    await vi.waitFor(() =>
      expect(
        noteOutlineFor(OPTIONS.sourcePath)?.headings.map(({ level, text }) => ({ level, text })),
      ).toEqual([
        { level: 2, text: 'Before' },
        { level: 2, text: 'Original' },
        { level: 3, text: 'Details' },
        { level: 3, text: 'Later' },
        { level: 2, text: 'After' },
      ]),
    )
    await expect
      .element(view.getByRole('button', { name: 'Original', exact: true }).first())
      .toHaveAttribute('aria-expanded', 'false')
    expect(
      view.container.querySelector('[data-testid="note-embed-preview"]')?.textContent,
    ).not.toContain('Later')
    expect(markdown()).toBe(`${content}\n`)
    await view.unmount()
  })

  it('expands and focuses a source chapter from the sidebar without changing the host', async () => {
    mocks.sources.set(
      'notes/Original.md',
      `# Original\n\n${'Prose. '.repeat(900)}\n\n## Later\n\nTail`,
    )
    const content = '# Host\n\n![[Original]]'
    const { view, markdown } = await outlinedReader(content)
    const original = markdown()
    await expect.element(view.getByRole('button', { name: 'Later', exact: true })).toBeVisible()
    const reads = mocks.read.mock.calls.length
    await view.getByRole('button', { name: 'Later', exact: true }).click()
    await expect.element(view.getByTestId('note-embed-full')).toBeInTheDocument()
    await expect.element(view.getByRole('heading', { name: 'Later', level: 3 })).toHaveFocus()
    const scroller = view.getByTestId('outline-scroller').element()
    await vi.waitFor(() =>
      expect(
        Math.abs(
          view.getByRole('heading', { name: 'Later', level: 3 }).element().getBoundingClientRect()
            .top -
            scroller.getBoundingClientRect().top -
            16,
        ),
      ).toBeLessThanOrEqual(1),
    )
    expect(markdown()).toBe(original)
    expect(mocks.read).toHaveBeenCalledTimes(reads)
    await view.unmount()
  })

  it('keeps repeated source instances distinct and reveals only the selected instance', async () => {
    const { view } = await outlinedReader('# Host\n\n![[Original|First]]\n\n![[Original|Second]]')
    await vi.waitFor(() =>
      expect(noteOutlineFor(OPTIONS.sourcePath)?.headings.map((heading) => heading.text)).toEqual([
        'Original',
        'Details',
        'Original',
        'Details',
      ]),
    )
    const outline = noteOutlineFor(OPTIONS.sourcePath)!
    expect(new Set(outline.headings.map((heading) => heading.embedded?.key)).size).toBe(4)
    outline.reveal(3)
    await expect
      .element(view.getByRole('button', { name: 'Second', exact: true }))
      .toHaveAttribute('aria-expanded', 'true')
    await expect
      .element(view.getByRole('button', { name: 'First', exact: true }))
      .toHaveAttribute('aria-expanded', 'false')
    await view.unmount()
    expect(noteOutlineFor(OPTIONS.sourcePath)).toBeNull()
  })

  it('merges nested source chapters at their paragraph and removes them on collapse', async () => {
    mocks.sources.set('notes/Original.md', '# Original\n\n![[Child]]\n\n## Details')
    mocks.sources.set('notes/Child.md', '# Child\n\n## Child chapter\n\nChild text')
    const { view } = await outlinedReader('# Host\n\n![[Original|Read original]]')
    await expect
      .element(view.getByRole('button', { name: 'Read original', exact: true }))
      .toHaveAttribute('aria-expanded', 'false')
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await vi.waitFor(() =>
      expect(
        noteOutlineFor(OPTIONS.sourcePath)?.headings.map(({ level, text }) => ({ level, text })),
      ).toEqual([
        { level: 2, text: 'Original' },
        { level: 3, text: 'Child' },
        { level: 4, text: 'Child chapter' },
        { level: 3, text: 'Details' },
      ]),
    )
    await view.getByRole('button', { name: 'Child chapter', exact: true }).click()
    await expect
      .element(view.getByRole('heading', { name: 'Child chapter', level: 4 }))
      .toHaveFocus()
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await vi.waitFor(() =>
      expect(noteOutlineFor(OPTIONS.sourcePath)?.headings.map((heading) => heading.text)).toEqual([
        'Original',
        'Details',
      ]),
    )
    await view.unmount()
  })

  it('keeps a chapter jump pinned when expansion inserts nested chapters before it', async () => {
    mocks.sources.set(
      'notes/Original.md',
      `# Original\n\n![[Child]]\n\n${'Prose. '.repeat(300)}\n\n## Details\n\nTail`,
    )
    mocks.sources.set('notes/Child.md', '# Child\n\n## Child chapter\n\nChild text')
    const { view } = await outlinedReader('# Host\n\n![[Original]]')
    await expect.element(view.getByRole('button', { name: 'Details', exact: true })).toBeVisible()
    await view.getByRole('button', { name: 'Details', exact: true }).click()
    await vi.waitFor(() => expect(noteOutlineFor(OPTIONS.sourcePath)?.headings).toHaveLength(4))
    await expect.element(view.getByRole('heading', { name: 'Details', level: 3 })).toHaveFocus()
    await vi.waitFor(() => expect(noteOutlineFor(OPTIONS.sourcePath)?.activeIndex).toBe(3))
    const scroller = view.getByTestId('outline-scroller').element()
    await vi.waitFor(() =>
      expect(
        Math.abs(
          view.getByRole('heading', { name: 'Details', level: 3 }).element().getBoundingClientRect()
            .top -
            scroller.getBoundingClientRect().top -
            16,
        ),
      ).toBeLessThanOrEqual(1),
    )
    const oldOutline = noteOutlineFor(OPTIONS.sourcePath)!
    await view.unmount()
    expect(() => oldOutline.reveal(3)).not.toThrow()
    expect(noteOutlineFor(OPTIONS.sourcePath)).toBeNull()
  })

  it('keeps a host chapter pinned when an earlier embedded source finishes loading', async () => {
    const source = deferred<string>()
    mocks.read.mockImplementation(() => source.promise)
    const { view } = await outlinedReader('# Host\n\n![[Original]]\n\n## After\n\nTail')
    await expect.element(view.getByRole('button', { name: 'After', exact: true })).toBeVisible()
    await view.getByRole('button', { name: 'After', exact: true }).click()
    source.resolve(`# Original\n\n${'Prose. '.repeat(300)}\n\n## Details\n\nTail`)
    await vi.waitFor(() => expect(noteOutlineFor(OPTIONS.sourcePath)?.headings).toHaveLength(3))
    await vi.waitFor(() => expect(noteOutlineFor(OPTIONS.sourcePath)?.activeIndex).toBe(2))
    const scroller = view.getByTestId('outline-scroller').element()
    await vi.waitFor(() =>
      expect(
        Math.abs(
          view.getByRole('heading', { name: 'After', level: 2 }).element().getBoundingClientRect()
            .top -
            scroller.getBoundingClientRect().top -
            16,
        ),
      ).toBeLessThanOrEqual(1),
    )
    await view.unmount()
  })
})

describe('NoteEmbedReader', () => {
  it('previews the source without frontmatter and expands without reading it again', async () => {
    const view = await render(
      <MarkdownPreview
        content={'## News\n\n![[Original|Read original]]'}
        resolveWikiEmbed={resolveWikiEmbed}
        renderNoteEmbed={(payload) => <NoteEmbedReader {...OPTIONS} {...payload} />}
      />,
    )
    const toggle = view.getByRole('button', { name: 'Read original', exact: true })
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect.element(view.getByText('Original paragraph')).toBeVisible()
    await expect.element(view.getByRole('heading', { name: 'News', level: 2 })).toBeVisible()
    await expect.element(view.getByRole('heading', { name: 'Original', level: 2 })).toBeVisible()
    expect(mocks.resolveWiki).toHaveBeenCalledWith('Original', 7, 'notes/Summary.md')
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(mocks.privacy).not.toHaveBeenCalled()
    expect(mocks.attachments).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain('title: Original')
    expect(view.getByTestId('note-embed').element().closest('p')).toBeNull()
    await toggle.click()
    await expect.element(view.getByTestId('note-embed-full')).toBeVisible()
    await expect.element(view.getByText('Original paragraph')).toBeVisible()
    await expect.element(view.getByRole('table')).toBeVisible()
    await expect.element(view.getByRole('heading', { name: 'Original', level: 2 })).toBeVisible()
    await expect.element(view.getByRole('heading', { name: 'Details', level: 3 })).toBeVisible()
    expect(view.container.textContent).not.toContain('title: Original')
    expect(view.container.querySelector('[contenteditable="true"]')).toBeNull()
    expect(mocks.attachments).toHaveBeenCalledWith(7, 'notes/Original.md')
    expect(mocks.create).not.toHaveBeenCalled()
    await toggle.click()
    await expect.element(view.getByTestId('note-embed-preview')).toBeVisible()
    await expect.element(view.getByTestId('note-embed-full')).not.toBeInTheDocument()
    await expect.element(view.getByText('Original paragraph')).toBeVisible()
    expect(mocks.read).toHaveBeenCalledTimes(1)
    await view.unmount()
  })

  it('bounds the passive preview and loads no media, attachments, or nested readers before activation', async () => {
    mocks.sources.set(
      'notes/Original.md',
      [
        '---\nprivate: true\n---\n# Original',
        'Preview text with **formatting**.',
        '[Site](https://example.test)',
        '![](https://example.test/image.png)',
        '![[attachments/chart.png]]',
        '![[bundle.zip]]',
        '![[Child]]',
        '- [ ] Read the source',
        'More text '.repeat(600),
        'End of full note',
      ].join('\n\n'),
    )
    const view = await render(reader())
    await expect.element(view.getByText('Preview text with', { exact: false })).toBeVisible()
    expect(view.container.querySelector('strong')?.textContent).toContain('formatting')
    expect(view.container.querySelector('img, iframe, a, input:not(:disabled)')).toBeNull()
    expect(view.container.textContent).not.toContain('private: true')
    expect(view.container.textContent).not.toContain('End of full note')
    expect(view.container.querySelectorAll('[data-testid="note-embed"]')).toHaveLength(1)
    expect(mocks.read).toHaveBeenCalledTimes(1)
    expect(mocks.attachments).not.toHaveBeenCalled()
    expect(mocks.privacy).not.toHaveBeenCalled()
    expect(mocks.loadCatalog).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.external).not.toHaveBeenCalled()
    expect(mocks.openAttachment).not.toHaveBeenCalled()
    const preview = view.getByTestId('note-embed-preview').element()
    await vi.waitFor(() => expect(getComputedStyle(preview).maskImage).not.toBe('none'))
    expect(preview.clientHeight).toBeGreaterThan(150)
    expect(preview.scrollHeight).toBeGreaterThan(preview.clientHeight)
    const caption = view.getByText('Read full note', { exact: true })
    await expect.element(caption).toBeVisible()
    expect(caption.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(
      preview.getBoundingClientRect().bottom,
    )
    const toggle = view.getByRole('button', { name: 'Read original', exact: true })
    toggle.element().focus()
    await userEvent.keyboard('{Enter}')
    await expect.element(view.getByTestId('note-embed-full')).toBeVisible()
    await expect.element(view.getByText('End of full note', { exact: true })).toBeVisible()
    expect(document.activeElement?.textContent).toBe('Original')
    await view.unmount()
  })

  it('opens the resolved source path and keeps the requested heading', async () => {
    const view = await render(reader({}, 'Original#Details'))
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByTestId('note-embed-full')).toBeVisible()
    await expect.element(view.getByText('Original paragraph')).toBeVisible()
    expect(document.activeElement?.textContent).toBe('Details')
    await view.getByRole('button', { name: 'Open Read original', exact: true }).click()
    await vi.waitFor(() =>
      expect(mocks.resolveWiki).toHaveBeenLastCalledWith(
        '/notes/Original.md#Details',
        7,
        'notes/Original.md',
      ),
    )
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        target: { kind: 'note', path: 'notes/Original.md' },
        openInNewWindow: false,
        revealHeading: 'Details',
      }),
    )
    expect(mocks.create).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('follows wiki and Markdown links from the embedded source, preserves fragments, and uses the external opener for URLs', async () => {
    mocks.sources.set(
      'notes/Original.md',
      '# Original\n\n[[Other#Next|Other note]]\n\n[Sibling](./Sibling.md#Next)\n\n[Site](https://example.com)',
    )
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByText('Other note', { exact: true })).toBeVisible()
    mocks.resolveWiki.mockResolvedValue({ kind: 'resolved', path: 'notes/Other.md' })
    await view.getByText('Other note', { exact: true }).click()
    await vi.waitFor(() =>
      expect(mocks.resolveWiki).toHaveBeenLastCalledWith('Other#Next', 7, 'notes/Original.md'),
    )
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        target: { kind: 'note', path: 'notes/Other.md' },
        openInNewWindow: false,
        revealHeading: 'Next',
      }),
    )
    await view.getByRole('link', { name: /Sibling$/ }).click()
    await vi.waitFor(() =>
      expect(mocks.resolveMarkdown).toHaveBeenCalledWith(
        './Sibling.md#Next',
        'notes/Original.md',
        7,
      ),
    )
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenLastCalledWith({
        target: { kind: 'note', path: 'notes/Sibling.md' },
        openInNewWindow: false,
        revealHeading: 'Next',
      }),
    )
    await view.getByRole('link', { name: /Site$/ }).click()
    expect(mocks.external).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://example.com' }),
    )
    expect(mocks.create).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('stops cyclic bodies and excludes nested headings when revealing a parent heading', async () => {
    mocks.sources.set(
      'notes/Original.md',
      '# Original\n\n## A\n\n![[Child]]\n\n## B\n\n[[#B|Jump B]]\n\n[Markdown jump](#A)',
    )
    mocks.sources.set('notes/Child.md', '# Child\n\nChild paragraph\n\n![[Original]]')
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByRole('button', { name: 'Child', exact: true })).toBeVisible()
    await view.getByRole('button', { name: 'Child', exact: true }).click()
    await expect.element(view.getByText('Child paragraph')).toBeVisible()
    await expect.element(view.getByRole('heading', { name: 'Child', level: 3 })).toBeVisible()
    await view.getByText('Jump B', { exact: true }).click()
    expect(document.activeElement?.textContent).toBe('B')
    await view.getByRole('link', { name: /Markdown jump$/ }).click()
    expect(document.activeElement?.textContent).toBe('A')
    await view.getByRole('button', { name: 'Original', exact: true }).click()
    await expect
      .element(view.getByText('This note is already embedded above. Open it to continue reading.'))
      .toBeVisible()
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.create).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('opens file pills and Markdown attachments from the source folder after loading its catalog', async () => {
    mocks.sources.set(
      'notes/Original.md',
      '# Original\n\n![[bundle.zip]]\n\n[Archive](attachments/bundle.zip)',
    )
    const catalog = deferred<void>()
    let loaded = false
    mocks.loadCatalog.mockReturnValue(catalog.promise)
    mocks.attachments.mockImplementation(() => ({
      resolveImageUrl: () => IMAGE,
      resolveWikiEmbed: ({ target }: { target: string }) => ({ kind: 'file', href: target }),
      resolveAttachmentPath: (href: string) =>
        href.endsWith('bundle.zip')
          ? loaded
            ? 'notes/attachments/bundle.zip'
            : 'bundle.zip'
          : null,
    }))
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByTestId('file-pill')).toBeVisible()
    await view.getByTestId('file-pill').click()
    expect(mocks.loadCatalog).toHaveBeenCalledWith(7)
    expect(mocks.openAttachment).not.toHaveBeenCalled()
    loaded = true
    catalog.resolve()
    await vi.waitFor(() =>
      expect(mocks.openAttachment).toHaveBeenCalledWith('notes/attachments/bundle.zip', 7),
    )
    mocks.openAttachment.mockClear()
    await view.getByRole('link', { name: /Archive$/ }).click()
    await vi.waitFor(() =>
      expect(mocks.openAttachment).toHaveBeenCalledWith('notes/attachments/bundle.zip', 7),
    )
    expect(mocks.external).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
    await view.unmount()
  })

  it.each(['collapse', 'graph switch'] as const)(
    'retires a pending attachment catalog lookup after %s',
    async (change) => {
      mocks.sources.set('notes/Original.md', '# Original\n\n[Archive](attachments/bundle.zip)')
      const catalog = deferred<void>()
      mocks.loadCatalog.mockReturnValue(catalog.promise)
      mocks.attachments.mockImplementation(() => ({
        resolveImageUrl: () => IMAGE,
        resolveWikiEmbed,
        resolveAttachmentPath: () => 'notes/attachments/bundle.zip',
      }))
      const view = await render(reader())
      await view.getByRole('button', { name: 'Read original', exact: true }).click()
      await expect.element(view.getByRole('link', { name: /Archive$/ })).toBeVisible()
      await view.getByRole('link', { name: /Archive$/ }).click()
      expect(mocks.loadCatalog).toHaveBeenCalledWith(7)
      if (change === 'collapse')
        await view.getByRole('button', { name: 'Read original', exact: true }).click()
      else await view.rerender(reader({ graphKey: '/graph-b', generation: 8 }))
      catalog.resolve()
      await catalog.promise
      // Flush the activation's continuation before checking that no open escaped.
      await Promise.resolve()
      expect(mocks.openAttachment).not.toHaveBeenCalled()
      await view.unmount()
    },
  )

  it('retires a pending attachment lookup when a newer external link is activated', async () => {
    mocks.sources.set(
      'notes/Original.md',
      '# Original\n\n[Archive](attachments/bundle.zip)\n\n[Site](https://example.com)',
    )
    const catalog = deferred<void>()
    mocks.loadCatalog.mockReturnValue(catalog.promise)
    mocks.attachments.mockImplementation(() => ({
      resolveImageUrl: () => IMAGE,
      resolveWikiEmbed,
      resolveAttachmentPath: (href: string) =>
        href.endsWith('bundle.zip') ? 'notes/attachments/bundle.zip' : null,
    }))
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByRole('link', { name: /Archive$/ })).toBeVisible()
    await view.getByRole('link', { name: /Archive$/ }).click()
    await view.getByRole('link', { name: /Site$/ }).click()
    expect(mocks.external).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://example.com' }),
    )
    catalog.resolve()
    await catalog.promise
    await Promise.resolve()
    expect(mocks.openAttachment).not.toHaveBeenCalled()
    await view.unmount()
  })

  it.each(['parent', 'header', 'local-only', 'pending', 'overlay'] as const)(
    'blocks remote media for a %s privacy restriction',
    async (restriction) => {
      mocks.sources.set(
        'notes/Original.md',
        `${restriction === 'header' ? '---\nprivate: true\n---\n' : ''}# Original\n\n![](https://example.test/a.png)`,
      )
      if (restriction === 'local-only')
        mocks.resolveWiki.mockResolvedValue({ kind: 'resolved', path: 'secure/Original.md' })
      if (restriction === 'local-only')
        mocks.sources.set('secure/Original.md', mocks.sources.get('notes/Original.md') ?? '')
      if (restriction === 'pending') mocks.pending = true
      if (restriction === 'overlay') mocks.privatePaths.add('notes/Original.md')
      const view = await render(reader({ remoteEmbeds: restriction !== 'parent' }))
      await view.getByRole('button', { name: 'Read original', exact: true }).click()
      await expect
        .element(view.getByRole('heading', { name: 'Original', exact: true }))
        .toBeVisible()
      expect(view.container.querySelector('img')).toBeNull()
      expect(mocks.privacy).toHaveBeenCalledWith(
        restriction === 'local-only' ? 'secure/Original.md' : 'notes/Original.md',
        {
          sessionEpoch: null,
          privateHeader: restriction === 'header',
        },
      )
      await view.unmount()
    },
  )

  it('applies an immediate Lock verdict to an expanded source and its expanded descendants', async () => {
    mocks.sources.set(
      'notes/Original.md',
      '# Original\n\n![](https://example.test/a.png)\n\n![[Child]]',
    )
    mocks.sources.set('notes/Child.md', '# Child\n\n![](https://example.test/b.png)')
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByRole('button', { name: 'Child', exact: true })).toBeVisible()
    await view.getByRole('button', { name: 'Child', exact: true }).click()
    await vi.waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(2))
    mocks.privatePaths.add('notes/Original.md')
    mocks.privacyRevision += 1
    for (const listener of mocks.privacyListeners) listener()
    await vi.waitFor(() => expect(view.container.querySelector('img')).toBeNull())
    expect(mocks.read).toHaveBeenCalledTimes(2)
    await view.unmount()
  })

  it('ignores a pending link resolution after a graph switch', async () => {
    mocks.sources.set('notes/Original.md', '# Original\n\n[[Other]]')
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByText('Other', { exact: true })).toBeVisible()
    const link = deferred<{ kind: 'resolved'; path: string }>()
    mocks.resolveWiki.mockReturnValueOnce(link.promise)
    await view.getByText('Other', { exact: true }).click()
    await view.rerender(reader({ graphKey: '/graph-b', generation: 8 }))
    await vi.waitFor(() => expect(mocks.read).toHaveBeenLastCalledWith('notes/Original.md', 8))
    link.resolve({ kind: 'resolved', path: 'notes/OldGraph.md' })
    await link.promise
    expect(mocks.navigate).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('reports a missing source and retries without creating anything', async () => {
    mocks.resolveWiki.mockResolvedValue({ kind: 'missing' })
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByText('Note not found.')).toBeVisible()
    expect(mocks.read).not.toHaveBeenCalled()
    mocks.resolveWiki.mockResolvedValue({ kind: 'resolved', path: 'notes/Original.md' })
    await view.getByRole('button', { name: 'Try again' }).click()
    await expect.element(view.getByText('Original paragraph')).toBeVisible()
    expect(mocks.create).not.toHaveBeenCalled()
    await view.unmount()
  })

  it.each(['wiki', 'markdown'] as const)(
    'retires a pending note lookup after a local %s heading jump',
    async (kind) => {
      mocks.sources.set(
        'notes/Original.md',
        '# Original\n\n## Details\n\n[[Other]]\n\n[[#Details|Jump details]]\n\n[Markdown details](#Details)',
      )
      const view = await render(reader())
      await view.getByRole('button', { name: 'Read original', exact: true }).click()
      await expect.element(view.getByText('Other', { exact: true })).toBeVisible()
      const pending = deferred<{ kind: 'resolved'; path: string }>()
      mocks.resolveWiki.mockReturnValueOnce(pending.promise)
      await view.getByText('Other', { exact: true }).click()
      if (kind === 'wiki') await view.getByText('Jump details', { exact: true }).click()
      else await view.getByRole('link', { name: /Markdown details$/ }).click()
      expect(document.activeElement?.textContent).toBe('Details')
      pending.resolve({ kind: 'resolved', path: 'notes/Retired.md' })
      await pending.promise
      expect(mocks.navigate).not.toHaveBeenCalled()
      await view.unmount()
    },
  )
})
