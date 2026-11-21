import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import { userEvent } from 'vitest/browser'
import type { LinkNavigationService } from '@reflect/app'
import { createTestAppServices, type TestAppServices } from '@reflect/app/testing'
import type {
  AttachmentService,
  IndexQueryService,
  NoteCreationService,
  NoteDocumentService,
  NoteLinkResolverService,
} from '@reflect/core'
import {
  createTestAttachmentService,
  createTestCoreServices,
  seedNotes,
  type TestCoreServices,
} from '@reflect/core/testing'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MarkdownPreview } from './markdown-preview.tsx'
import { NoteEmbedReader, type NoteEmbedReaderOptions } from './note-embed-reader.tsx'
import { NoteEditor, type NoteEditorHandle } from './note-editor.tsx'
import { OutlineBridge } from './outline/outline-bridge.tsx'
import { noteOutlineFor } from './outline/outline-store.ts'
import { OutlineSection } from '@/components/context-sidebar/outline-section.tsx'

const IMAGE =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/%3E'

/**
 * The open graph: `secure` is a local-only folder.
 */
const GRAPH = { root: '/graph-a', name: 'A', generation: 7, localOnlyFolders: ['secure'] }

const OPTIONS: NoteEmbedReaderOptions = {
  sourcePath: 'notes/Summary.md',
  generation: 7,
  graphKey: '/graph-a',
  ancestors: ['notes/Summary.md'],
  remoteEmbeds: true,
}
const resolveWikiEmbed = () => ({ kind: 'note' as const })

let app: TestCoreServices
let appLayer: TestAppServices
/**
 * The note sources the readers read, by path.
 */
let sources: Map<string, string>
let resolveWiki: MockInstance<NoteLinkResolverService['resolveWikiTarget']>
let resolveMarkdown: MockInstance<NoteLinkResolverService['resolveMarkdownHref']>
let read: MockInstance<NoteDocumentService['readExisting']>
let create: MockInstance<NoteCreationService['resolveOrCreateNoteWithTitle']>
let getNote: MockInstance<IndexQueryService['getNote']>
let resolveImageUrl: MockInstance<AttachmentService['resolveImageUrl']>
let loadCatalog: MockInstance<AttachmentService['loadCatalog']>
let openOrReveal: MockInstance<AttachmentService['openOrReveal']>
let navigate: MockInstance<LinkNavigationService['openNoteLink']>
let external: MockInstance<LinkNavigationService['followMarkdownLink']>

beforeEach(() => {
  const database = createWasmTestDatabaseService()
  onTestFinished(() => database.close())
  app = createTestCoreServices({ database })
  // Public index rows: a source's privacy then rests on its path, its header,
  // and the in-app overlay.
  seedNotes(app.database, [
    { path: 'notes/Original.md', markdown: '# Original' },
    { path: 'notes/Child.md', markdown: '# Child' },
    { path: 'secure/Original.md', markdown: '# Original' },
  ])
  sources = new Map([
    [
      'notes/Original.md',
      `---\ntitle: Original\n---\n# Original\n\nOriginal paragraph\n\n## Details\n\n| Tool | Usage |\n| --- | --- |\n| Editor | 42 |`,
    ],
    ['notes/Child.md', '# Child\n\nChild paragraph'],
  ])
  resolveWiki = vi.spyOn(app.noteLinkResolver, 'resolveWikiTarget').mockImplementation((target) => {
    return Promise.resolve({
      kind: 'resolved',
      path:
        target.replace(/^\//, '').split('#')[0] === 'Child'
          ? 'notes/Child.md'
          : 'notes/Original.md',
    })
  })
  resolveMarkdown = vi
    .spyOn(app.noteLinkResolver, 'resolveMarkdownHref')
    .mockResolvedValue({ kind: 'resolved', path: 'notes/Sibling.md' })
  read = vi
    .spyOn(app.noteDocuments, 'readExisting')
    .mockImplementation((path) => Promise.resolve(sources.get(path) ?? ''))
  create = vi.spyOn(app.noteCreation, 'resolveOrCreateNoteWithTitle')
  getNote = vi.spyOn(app.indexQuery, 'getNote')
  resolveImageUrl = vi.spyOn(app.attachments, 'resolveImageUrl').mockReturnValue(IMAGE)
  loadCatalog = vi.spyOn(app.attachments, 'loadCatalog')
  openOrReveal = vi.spyOn(app.attachments, 'openOrReveal').mockResolvedValue(undefined)
  appLayer = createTestAppServices(app)
  navigate = vi.spyOn(appLayer.linkNavigation, 'openNoteLink').mockImplementation(() => {})
  external = vi.spyOn(appLayer.linkNavigation, 'followMarkdownLink').mockImplementation(() => {})
})

function render(ui: ReactNode) {
  return renderInApp(ui, { core: app, appServices: appLayer, graph: GRAPH })
}

function reader(options: Partial<NoteEmbedReaderOptions> = {}, target = 'Original') {
  return <NoteEmbedReader {...OPTIONS} {...options} target={target} display="Read original" />
}

/**
 * A listed catalog with no files, for a scripted `loadCatalog` to answer with.
 */
async function emptyCatalog() {
  return await createTestAttachmentService().loadCatalog()
}

/**
 * The text of the element that has focus.
 */
function focusedText(): string | null | undefined {
  const focused = document.activeElement
  return focused?.textContent
}

/**
 * Whether the index row of `path` was asked for: the privacy verdict reads it.
 */
function privacyRead(path: string): boolean {
  return getNote.mock.calls.some(([asked]) => asked === path)
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
    sources.set(
      'notes/Original.md',
      `# Original\n\n## Details\n\n${'Long prose. '.repeat(600)}\n\n## Later\n\nLast paragraph`,
    )
    const content = '# Host\n\n## Before\n\n![[Original]]\n\n## After'
    const { view, markdown } = await outlinedReader(content)
    await vi.waitFor(() => {
      expect(
        noteOutlineFor(OPTIONS.sourcePath)?.headings.map(({ level, text }) => ({ level, text })),
      ).toEqual([
        { level: 2, text: 'Before' },
        { level: 2, text: 'Original' },
        { level: 3, text: 'Details' },
        { level: 3, text: 'Later' },
        { level: 2, text: 'After' },
      ])
    })
    await expect
      .element(view.getByRole('button', { name: 'Original', exact: true }).first())
      .toHaveAttribute('aria-expanded', 'false')
    expect(
      view.container.querySelector('[data-testid="note-embed-preview"]')?.textContent,
    ).not.toContain('Later')
    expect(markdown()).toBe(`${content}\n`)
  })

  it('expands and focuses a source chapter from the sidebar without changing the host', async () => {
    sources.set('notes/Original.md', `# Original\n\n${'Prose. '.repeat(900)}\n\n## Later\n\nTail`)
    const content = '# Host\n\n![[Original]]'
    const { view, markdown } = await outlinedReader(content)
    const original = markdown()
    await expect.element(view.getByRole('button', { name: 'Later', exact: true })).toBeVisible()
    const reads = read.mock.calls.length
    await view.getByRole('button', { name: 'Later', exact: true }).click()
    await expect.element(view.getByTestId('note-embed-full')).toBeInTheDocument()
    await expect.element(view.getByRole('heading', { name: 'Later', level: 3 })).toHaveFocus()
    const scroller = view.getByTestId('outline-scroller').element()
    await vi.waitFor(() => {
      expect(
        Math.abs(
          view.getByRole('heading', { name: 'Later', level: 3 }).element().getBoundingClientRect()
            .top -
            scroller.getBoundingClientRect().top -
            16,
        ),
      ).toBeLessThanOrEqual(1)
    })
    expect(markdown()).toBe(original)
    expect(read).toHaveBeenCalledTimes(reads)
  })

  it('keeps repeated source instances distinct and reveals only the selected instance', async () => {
    const { view } = await outlinedReader('# Host\n\n![[Original|First]]\n\n![[Original|Second]]')
    await vi.waitFor(() => {
      expect(noteOutlineFor(OPTIONS.sourcePath)?.headings.map((heading) => heading.text)).toEqual([
        'Original',
        'Details',
        'Original',
        'Details',
      ])
    })
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
    sources.set('notes/Original.md', '# Original\n\n![[Child]]\n\n## Details')
    sources.set('notes/Child.md', '# Child\n\n## Child chapter\n\nChild text')
    const { view } = await outlinedReader('# Host\n\n![[Original|Read original]]')
    await expect
      .element(view.getByRole('button', { name: 'Read original', exact: true }))
      .toHaveAttribute('aria-expanded', 'false')
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await vi.waitFor(() => {
      expect(
        noteOutlineFor(OPTIONS.sourcePath)?.headings.map(({ level, text }) => ({ level, text })),
      ).toEqual([
        { level: 2, text: 'Original' },
        { level: 3, text: 'Child' },
        { level: 4, text: 'Child chapter' },
        { level: 3, text: 'Details' },
      ])
    })
    await view.getByRole('button', { name: 'Child chapter', exact: true }).click()
    await expect
      .element(view.getByRole('heading', { name: 'Child chapter', level: 4 }))
      .toHaveFocus()
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await vi.waitFor(() => {
      expect(noteOutlineFor(OPTIONS.sourcePath)?.headings.map((heading) => heading.text)).toEqual([
        'Original',
        'Details',
      ])
    })
  })

  it('keeps a chapter jump pinned when expansion inserts nested chapters before it', async () => {
    sources.set(
      'notes/Original.md',
      `# Original\n\n![[Child]]\n\n${'Prose. '.repeat(300)}\n\n## Details\n\nTail`,
    )
    sources.set('notes/Child.md', '# Child\n\n## Child chapter\n\nChild text')
    const { view } = await outlinedReader('# Host\n\n![[Original]]')
    await expect.element(view.getByRole('button', { name: 'Details', exact: true })).toBeVisible()
    await view.getByRole('button', { name: 'Details', exact: true }).click()
    await vi.waitFor(() => expect(noteOutlineFor(OPTIONS.sourcePath)?.headings).toHaveLength(4))
    await expect.element(view.getByRole('heading', { name: 'Details', level: 3 })).toHaveFocus()
    await vi.waitFor(() => expect(noteOutlineFor(OPTIONS.sourcePath)?.activeIndex).toBe(3))
    const scroller = view.getByTestId('outline-scroller').element()
    await vi.waitFor(() => {
      expect(
        Math.abs(
          view.getByRole('heading', { name: 'Details', level: 3 }).element().getBoundingClientRect()
            .top -
            scroller.getBoundingClientRect().top -
            16,
        ),
      ).toBeLessThanOrEqual(1)
    })
    const oldOutline = noteOutlineFor(OPTIONS.sourcePath)!
    await view.unmount()
    expect(() => oldOutline.reveal(3)).not.toThrow()
    expect(noteOutlineFor(OPTIONS.sourcePath)).toBeNull()
  })

  it('keeps a host chapter pinned when an earlier embedded source finishes loading', async () => {
    const source = Promise.withResolvers<string>()
    read.mockImplementation(() => source.promise)
    const { view } = await outlinedReader('# Host\n\n![[Original]]\n\n## After\n\nTail')
    await expect.element(view.getByRole('button', { name: 'After', exact: true })).toBeVisible()
    await view.getByRole('button', { name: 'After', exact: true }).click()
    source.resolve(`# Original\n\n${'Prose. '.repeat(300)}\n\n## Details\n\nTail`)
    await vi.waitFor(() => expect(noteOutlineFor(OPTIONS.sourcePath)?.headings).toHaveLength(3))
    await vi.waitFor(() => expect(noteOutlineFor(OPTIONS.sourcePath)?.activeIndex).toBe(2))
    const scroller = view.getByTestId('outline-scroller').element()
    await vi.waitFor(() => {
      expect(
        Math.abs(
          view.getByRole('heading', { name: 'After', level: 2 }).element().getBoundingClientRect()
            .top -
            scroller.getBoundingClientRect().top -
            16,
        ),
      ).toBeLessThanOrEqual(1)
    })
  })
})

describe('NoteEmbedReader', () => {
  it('previews the source without frontmatter and expands without reading it again', async () => {
    const view = await render(
      <MarkdownPreview
        sourcePath={null}
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
    expect(resolveWiki).toHaveBeenCalledWith('Original', 7, 'notes/Summary.md')
    expect(read).toHaveBeenCalledTimes(1)
    // No privacy verdict and no attachment of the source resolve before the reader opens.
    expect(privacyRead('notes/Original.md')).toBe(false)
    expect(resolveImageUrl).not.toHaveBeenCalled()
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
    await vi.waitFor(() => expect(privacyRead('notes/Original.md')).toBe(true))
    expect(create).not.toHaveBeenCalled()
    await toggle.click()
    await expect.element(view.getByTestId('note-embed-preview')).toBeVisible()
    await expect.element(view.getByTestId('note-embed-full')).not.toBeInTheDocument()
    await expect.element(view.getByText('Original paragraph')).toBeVisible()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('previews only the named section under the source title while collapsed', async () => {
    sources.set(
      'notes/Original.md',
      '# Original\n\n## Coverage\n\nBookkeeping text\n\n## Findings\n\nFinding text\n\n## Gaps\n\nGap text',
    )
    const view = await render(
      <MarkdownPreview
        sourcePath={null}
        content={'![[Original#Findings]]'}
        resolveWikiEmbed={resolveWikiEmbed}
        renderNoteEmbed={(payload) => <NoteEmbedReader {...OPTIONS} {...payload} />}
      />,
    )
    const preview = view.getByTestId('note-embed-preview')
    await expect.element(preview.getByText('Finding text')).toBeVisible()
    await expect.element(preview.getByRole('heading', { name: 'Original', level: 2 })).toBeVisible()
    expect(preview.element().textContent).not.toContain('Bookkeeping text')
    expect(preview.element().textContent).not.toContain('Gap text')
  })

  it('bounds the passive preview and loads no media, attachments, or nested readers before activation', async () => {
    sources.set(
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
    expect(read).toHaveBeenCalledTimes(1)
    expect(resolveImageUrl).not.toHaveBeenCalled()
    expect(privacyRead('notes/Original.md')).toBe(false)
    expect(loadCatalog).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(external).not.toHaveBeenCalled()
    expect(openOrReveal).not.toHaveBeenCalled()
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
    expect(focusedText()).toBe('Original')
  })

  it('opens the resolved source path and keeps the requested heading', async () => {
    const view = await render(reader({}, 'Original#Details'))
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByTestId('note-embed-full')).toBeVisible()
    await expect.element(view.getByText('Original paragraph')).toBeVisible()
    expect(focusedText()).toBe('Details')
    await view.getByRole('button', { name: 'Open Read original', exact: true }).click()
    await vi.waitFor(() => {
      expect(resolveWiki).toHaveBeenLastCalledWith(
        '/notes/Original.md#Details',
        7,
        'notes/Original.md',
      )
    })
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        {
          target: { kind: 'note', path: 'notes/Original.md' },
          openInNewWindow: false,
          revealHeading: 'Details',
        },
        expect.anything(),
      )
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('follows wiki and Markdown links from the embedded source, preserves decoded fragments, and uses the external opener for URLs', async () => {
    sources.set(
      'notes/Original.md',
      '# Original\n\n[[Other#Next|Other note]]\n\n[Sibling](./Sibling.md#Next%20steps)\n\n[Site](https://example.com)',
    )
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByText('Other note', { exact: true })).toBeVisible()
    resolveWiki.mockResolvedValue({ kind: 'resolved', path: 'notes/Other.md' })
    await view.getByText('Other note', { exact: true }).click()
    await vi.waitFor(() => {
      expect(resolveWiki).toHaveBeenLastCalledWith('Other#Next', 7, 'notes/Original.md')
    })
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith(
        {
          target: { kind: 'note', path: 'notes/Other.md' },
          openInNewWindow: false,
          revealHeading: 'Next',
        },
        expect.anything(),
      )
    })
    await view.getByRole('link', { name: /Sibling$/ }).click()
    await vi.waitFor(() => {
      expect(resolveMarkdown).toHaveBeenCalledWith(
        'notes/Original.md',
        './Sibling.md#Next%20steps',
        7,
      )
    })
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenLastCalledWith(
        {
          target: { kind: 'note', path: 'notes/Sibling.md' },
          openInNewWindow: false,
          revealHeading: 'Next steps',
        },
        expect.anything(),
      )
    })
    await view.getByRole('link', { name: /Site$/ }).click()
    // A link that names no note follows the external-link policy, as Markdown from no note.
    expect(external).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://example.com', sourcePath: null }),
      expect.anything(),
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('stops cyclic bodies and excludes nested headings when revealing a parent heading', async () => {
    sources.set(
      'notes/Original.md',
      '# Original\n\n## A\n\n![[Child]]\n\n## B\n\n[[#B|Jump B]]\n\n[Markdown jump](#A)',
    )
    sources.set('notes/Child.md', '# Child\n\nChild paragraph\n\n![[Original]]')
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByRole('button', { name: 'Child', exact: true })).toBeVisible()
    await view.getByRole('button', { name: 'Child', exact: true }).click()
    await expect.element(view.getByText('Child paragraph')).toBeVisible()
    await expect.element(view.getByRole('heading', { name: 'Child', level: 3 })).toBeVisible()
    await view.getByText('Jump B', { exact: true }).click()
    expect(focusedText()).toBe('B')
    await view.getByRole('link', { name: /Markdown jump$/ }).click()
    expect(focusedText()).toBe('A')
    await view.getByRole('button', { name: 'Original', exact: true }).click()
    await expect
      .element(view.getByText('This note is already embedded above. Open it to continue reading.'))
      .toBeVisible()
    expect(read).toHaveBeenCalledTimes(2)
    expect(create).not.toHaveBeenCalled()
  })

  it('opens file pills and Markdown attachments from the source folder after loading its catalog', async () => {
    sources.set(
      'notes/Original.md',
      '# Original\n\n![[bundle.zip]]\n\n[Archive](attachments/bundle.zip)',
    )
    const listed = await emptyCatalog()
    const catalog = Promise.withResolvers<typeof listed>()
    let loaded = false
    loadCatalog.mockReturnValue(catalog.promise)
    vi.spyOn(app.attachments, 'resolveAttachmentPath').mockImplementation((_notePath, href) => {
      return href.endsWith('bundle.zip')
        ? loaded
          ? 'notes/attachments/bundle.zip'
          : 'bundle.zip'
        : null
    })
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByTestId('file-pill')).toBeVisible()
    await view.getByTestId('file-pill').click()
    expect(loadCatalog).toHaveBeenCalled()
    expect(openOrReveal).not.toHaveBeenCalled()
    loaded = true
    catalog.resolve(listed)
    await vi.waitFor(() => {
      expect(openOrReveal).toHaveBeenCalledWith('notes/attachments/bundle.zip')
    })
    openOrReveal.mockClear()
    await view.getByRole('link', { name: /Archive$/ }).click()
    await vi.waitFor(() => {
      expect(openOrReveal).toHaveBeenCalledWith('notes/attachments/bundle.zip')
    })
    expect(external).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['collapse', 'graph switch'] as const)(
    'retires a pending attachment catalog lookup after %s',
    async (change) => {
      sources.set('notes/Original.md', '# Original\n\n[Archive](attachments/bundle.zip)')
      const listed = await emptyCatalog()
      const catalog = Promise.withResolvers<typeof listed>()
      loadCatalog.mockReturnValue(catalog.promise)
      vi.spyOn(app.attachments, 'resolveAttachmentPath').mockReturnValue(
        'notes/attachments/bundle.zip',
      )
      const view = await render(reader())
      await view.getByRole('button', { name: 'Read original', exact: true }).click()
      await expect.element(view.getByRole('link', { name: /Archive$/ })).toBeVisible()
      await view.getByRole('link', { name: /Archive$/ }).click()
      expect(loadCatalog).toHaveBeenCalled()
      if (change === 'collapse')
        await view.getByRole('button', { name: 'Read original', exact: true }).click()
      else await view.rerender(reader({ graphKey: '/graph-b', generation: 8 }))
      catalog.resolve(listed)
      await catalog.promise
      // Flush the activation's continuation before checking that no open escaped.
      await Promise.resolve()
      expect(openOrReveal).not.toHaveBeenCalled()
    },
  )

  it('retires a pending attachment lookup when a newer external link is activated', async () => {
    sources.set(
      'notes/Original.md',
      '# Original\n\n[Archive](attachments/bundle.zip)\n\n[Site](https://example.com)',
    )
    const listed = await emptyCatalog()
    const catalog = Promise.withResolvers<typeof listed>()
    loadCatalog.mockReturnValue(catalog.promise)
    vi.spyOn(app.attachments, 'resolveAttachmentPath').mockImplementation((_notePath, href) => {
      return href.endsWith('bundle.zip') ? 'notes/attachments/bundle.zip' : null
    })
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByRole('link', { name: /Archive$/ })).toBeVisible()
    await view.getByRole('link', { name: /Archive$/ }).click()
    await view.getByRole('link', { name: /Site$/ }).click()
    expect(external).toHaveBeenCalledWith(
      expect.objectContaining({ href: 'https://example.com' }),
      expect.anything(),
    )
    catalog.resolve(listed)
    await catalog.promise
    await Promise.resolve()
    expect(openOrReveal).not.toHaveBeenCalled()
  })

  it.each(['parent', 'header', 'local-only', 'pending', 'overlay'] as const)(
    'blocks remote media for a %s privacy restriction',
    async (restriction) => {
      sources.set(
        'notes/Original.md',
        `${restriction === 'header' ? '---\nprivate: true\n---\n' : ''}# Original\n\n![](https://example.test/a.png)`,
      )
      // The editor's resolver passes remote sources through; the policy must block them.
      resolveImageUrl.mockImplementation((_notePath, source) => source)
      if (restriction === 'local-only') {
        resolveWiki.mockResolvedValue({ kind: 'resolved', path: 'secure/Original.md' })
        sources.set('secure/Original.md', sources.get('notes/Original.md') ?? '')
      }
      // The index row never arrives, so the verdict waits.
      if (restriction === 'pending') getNote.mockReturnValue(new Promise(() => {}))
      // An in-app Lock, ahead of the index.
      if (restriction === 'overlay')
        app.noteRows.setOverlay('notes/Original.md', 7, { isPrivate: true })
      const view = await render(reader({ remoteEmbeds: restriction !== 'parent' }))
      await view.getByRole('button', { name: 'Read original', exact: true }).click()
      await expect
        .element(view.getByRole('heading', { name: 'Original', exact: true }))
        .toBeVisible()
      expect(view.container.querySelector('img')).toBeNull()
      // The verdict is the resolved source's own.
      await vi.waitFor(() => {
        expect(
          privacyRead(restriction === 'local-only' ? 'secure/Original.md' : 'notes/Original.md'),
        ).toBe(true)
      })
    },
  )

  it('applies an immediate Lock verdict to an expanded source and its expanded descendants', async () => {
    sources.set('notes/Original.md', '# Original\n\n![](https://example.test/a.png)\n\n![[Child]]')
    sources.set('notes/Child.md', '# Child\n\n![](https://example.test/b.png)')
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByRole('button', { name: 'Child', exact: true })).toBeVisible()
    await view.getByRole('button', { name: 'Child', exact: true }).click()
    await vi.waitFor(() => expect(view.container.querySelectorAll('img')).toHaveLength(2))
    // Each body resolves its images from its own note.
    expect(resolveImageUrl).toHaveBeenCalledWith('notes/Original.md', 'https://example.test/a.png')
    expect(resolveImageUrl).toHaveBeenCalledWith('notes/Child.md', 'https://example.test/b.png')
    app.noteRows.setOverlay('notes/Original.md', 7, { isPrivate: true })
    await vi.waitFor(() => expect(view.container.querySelector('img')).toBeNull())
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('ignores a pending link resolution after a graph switch', async () => {
    sources.set('notes/Original.md', '# Original\n\n[[Other]]')
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByText('Other', { exact: true })).toBeVisible()
    const link = Promise.withResolvers<{ kind: 'resolved'; path: string }>()
    resolveWiki.mockReturnValueOnce(link.promise)
    await view.getByText('Other', { exact: true }).click()
    await view.rerender(reader({ graphKey: '/graph-b', generation: 8 }))
    await vi.waitFor(() => expect(read).toHaveBeenLastCalledWith('notes/Original.md', 8))
    link.resolve({ kind: 'resolved', path: 'notes/OldGraph.md' })
    await link.promise
    expect(navigate).not.toHaveBeenCalled()
  })

  it('reports a missing source and retries without creating anything', async () => {
    resolveWiki.mockResolvedValue({ kind: 'missing' })
    const view = await render(reader())
    await view.getByRole('button', { name: 'Read original', exact: true }).click()
    await expect.element(view.getByText('Note not found.')).toBeVisible()
    expect(read).not.toHaveBeenCalled()
    resolveWiki.mockResolvedValue({ kind: 'resolved', path: 'notes/Original.md' })
    await view.getByRole('button', { name: 'Try again' }).click()
    await expect.element(view.getByText('Original paragraph')).toBeVisible()
    expect(create).not.toHaveBeenCalled()
  })

  it.each(['wiki', 'markdown'] as const)(
    'retires a pending note lookup after a local %s heading jump',
    async (kind) => {
      sources.set(
        'notes/Original.md',
        '# Original\n\n## Details\n\n[[Other]]\n\n[[#Details|Jump details]]\n\n[Markdown details](#Details)',
      )
      const view = await render(reader())
      await view.getByRole('button', { name: 'Read original', exact: true }).click()
      await expect.element(view.getByText('Other', { exact: true })).toBeVisible()
      const pending = Promise.withResolvers<{ kind: 'resolved'; path: string }>()
      resolveWiki.mockReturnValueOnce(pending.promise)
      await view.getByText('Other', { exact: true }).click()
      if (kind === 'wiki') await view.getByText('Jump details', { exact: true }).click()
      else await view.getByRole('link', { name: /Markdown details$/ }).click()
      expect(focusedText()).toBe('Details')
      pending.resolve({ kind: 'resolved', path: 'notes/Retired.md' })
      await pending.promise
      expect(navigate).not.toHaveBeenCalled()
    },
  )
})
