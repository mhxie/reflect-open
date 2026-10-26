import {
  createTestAttachmentService,
  createTestCoreServices,
  type TestCoreServices,
} from '@reflect/core/testing'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import type { CoreServices, NoteListEntry } from '@reflect/core'
import type { ListSelection } from '@/lib/selection/use-list-selection.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { AttachmentGallery } from './attachment-gallery.tsx'

// Every asset URL serves one real 1×1 PNG, so previews load rather than
// falling back to the placeholder; the asset path rides in the fragment.
const imageUrl = (() => {
  const bytes = Uint8Array.from(
    atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    ),
    (character) => character.charCodeAt(0),
  )
  return URL.createObjectURL(new Blob([bytes], { type: 'image/png' }))
})()

function entry(path: string, title: string): NoteListEntry {
  return {
    isPrivate: false,
    path,
    title,
    snippet: '',
    tags: [],
    mtime: 1,
    isPinned: false,
    pinnedOrder: null,
  }
}

const selection = {
  isSelected: vi.fn((path: string) => path === 'notes/trip.md'),
  clickSelect: vi.fn(),
} as unknown as ListSelection & { clickSelect: ReturnType<typeof vi.fn> }

// The services of the rendered gallery; set by `renderGallery`.
let app: TestCoreServices
let listAttachmentPreviews: MockInstance<CoreServices['noteList']['listAttachmentPreviews']>

async function renderGallery(
  type: 'pdf' | 'image',
  onOpen = vi.fn(),
  registerScrollToIndex: (scrollToIndex: (index: number) => void) => void = vi.fn(),
) {
  const attachments = createTestAttachmentService({
    graphSession: { getState: () => app.graphSession.getState() },
    catalog: [
      { path: 'papers/a.pdf', size: 10 },
      { path: 'assets/map.png', size: 10 },
    ],
  })
  vi.spyOn(attachments, 'assetUrl').mockImplementation(
    (path, generation) => `${imageUrl}#reflect-asset/${generation}/${path}`,
  )
  app = createTestCoreServices({ database: createWasmTestDatabaseService(), attachments })
  onTestFinished(() => app.database.close())
  listAttachmentPreviews = vi.spyOn(app.noteList, 'listAttachmentPreviews').mockResolvedValue(
    new Map([
      // `a.pdf` linked from `papers/` may mean either spelling; only one exists.
      ['papers/socc.md', ['a.pdf', 'papers/a.pdf']],
      ['notes/trip.md', ['notes/assets/map.png', 'assets/map.png']],
    ]),
  )
  return await renderInApp(
    <AttachmentGallery
      type={type}
      notes={[entry('papers/socc.md', 'SoCC paper'), entry('notes/trip.md', 'Trip')]}
      selection={selection}
      onOpen={onOpen}
      registerScrollToIndex={registerScrollToIndex}
    />,
    {
      core: app,
      graph: { root: '/g', name: 'g', generation: 7 },
      settings: { dateFormat: 'iso', timeFormat: '24h' },
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AttachmentGallery', () => {
  it('shows each note’s first existing attachment, a PDF as its first page', async () => {
    const view = await renderGallery('pdf')

    await expect.element(page.getByRole('list', { name: 'Notes with PDFs' })).toBeVisible()
    await vi.waitFor(() => {
      const sources = [...view.container.querySelectorAll('img')].map((img) => img.src)
      expect(sources[0]).toContain('7/papers/a.pdf?reflect-preview=pdf-page&page=1')
    })
    expect(listAttachmentPreviews).toHaveBeenCalledWith('pdf')
  })

  it('shows an image attachment as its cached thumbnail and marks the selected card', async () => {
    const view = await renderGallery('image')

    await vi.waitFor(() => {
      const sources = [...view.container.querySelectorAll('img')].map((img) => img.src)
      expect(sources[1]).toMatch(/7\/assets\/map\.png\?reflect-preview=thumb&width=\d+$/)
    })
    const cards = view.container.querySelectorAll('li')
    expect(cards[1]!.className).toContain('border-accent')
    expect(cards[0]!.className).not.toContain('border-accent')
  })

  it('selects on click and opens from the title or a double-click', async () => {
    const onOpen = vi.fn()
    const view = await renderGallery('pdf', onOpen)

    const card = view.container.querySelector('li')!
    await userEvent.click(card, { position: { x: 20, y: 20 } })
    expect(selection.clickSelect).toHaveBeenCalledWith('papers/socc.md', expect.anything())

    await userEvent.click(page.getByRole('button', { name: 'SoCC paper' }))
    expect(onOpen).toHaveBeenCalledWith('papers/socc.md', expect.anything())

    onOpen.mockClear()
    await userEvent.dblClick(card, { position: { x: 20, y: 20 } })
    expect(onOpen).toHaveBeenCalledWith('papers/socc.md', expect.anything())
  })

  it('lets keyboard navigation bring a card into view', async () => {
    const registerScrollToIndex = vi.fn<(scrollToIndex: (index: number) => void) => void>()
    const view = await renderGallery('pdf', vi.fn(), registerScrollToIndex)
    await expect.element(page.getByRole('list', { name: 'Notes with PDFs' })).toBeVisible()

    const cards = view.container.querySelectorAll('li')
    const scrollIntoView = vi.spyOn(cards[1]!, 'scrollIntoView')
    const scrollToIndex = registerScrollToIndex.mock.calls.at(-1)![0]
    scrollToIndex(1)

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
  })
})
