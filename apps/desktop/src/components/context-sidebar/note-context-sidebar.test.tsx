import { userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { RetrievalService } from '@reflect/core'
import { createTestCoreServices, createTestRetrievalService } from '@reflect/core/testing'
import type { ReactNode } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { scrollContainerOf } from '@/test-utils/scroll-container.ts'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { NoteContextSidebar } from './note-context-sidebar.tsx'

const relatedNotes = vi.fn<RetrievalService['relatedNotes']>()

const zig = {
  path: 'notes/zig.md',
  title: 'Zig',
  score: 0.8,
  snippet: 'comptime experiments',
  heading: null,
  isPrivate: false,
}

/** More semantic neighbors than a short sidebar shows without scrolling. */
const neighbors = Array.from({ length: 6 }, (_, index) => ({
  path: `notes/neighbor-${index}.md`,
  title: `Neighbor ${index}`,
  score: 0.9,
  snippet: 'a semantic neighbor of the note',
  heading: null,
  isPrivate: false,
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function createCore() {
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    retrieval: createTestRetrievalService({ relatedNotes }),
  })
  onTestFinished(() => core.database.close())
  return core
}

/**
 * Renders the sidebar in a clipping frame like AppShell's context region, `height` px tall if given.
 */
async function renderSidebar(path: string, height?: number, core = createCore()) {
  return await renderInApp(
    <>
      <div data-testid="context-frame" className="overflow-hidden" style={{ height }}>
        <NoteContextSidebar path={path} />
      </div>
      <RouteProbe />
    </>,
    {
      core,
      // `archive` is a read-only local-only folder.
      graph: { root: '/g', name: 'g', localOnlyFolders: ['archive'] },
      settings: {
        semanticSearchEnabled: true,
        wikiLanguages: [{ label: 'English', folder: 'wiki' }],
      },
    },
  )
}

beforeEach(() => {
  relatedNotes.mockReset().mockResolvedValue([])
})

describe('NoteContextSidebar', () => {
  it('queries the note path for similar notes and shows no section without results', async () => {
    const view = await renderSidebar('notes/rust.md')
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('notes/rust.md', 6))
    expect(view.getByText('Similar notes').query()).toBeNull()
  })

  it('keeps the note actions at the top while the sections scroll', async () => {
    relatedNotes.mockResolvedValue(neighbors)
    // Room for the note actions and a few lines of sections.
    const view = await renderSidebar('notes/rust.md', 320)
    const pin = view.getByText('Pin this note')
    await expect.element(pin).toBeVisible()
    const neighbor = view.getByText('Neighbor 0')
    await expect.element(neighbor).toBeVisible()

    const sections = scrollContainerOf(neighbor.element())
    const panel = scrollContainerOf(sections)
    expect(panel.scrollHeight).toBeLessThanOrEqual(panel.clientHeight)
    expect(sections.scrollHeight).toBeGreaterThan(sections.clientHeight)
    const pinTop = pin.element().getBoundingClientRect().top
    sections.scrollTop = sections.scrollHeight
    expect(sections.scrollTop).toBeGreaterThan(0)
    expect(pin.element().getBoundingClientRect().top).toBe(pinTop)
  })

  it("keeps a wiki entry's language switch pinned above the scrolling sections", async () => {
    relatedNotes.mockResolvedValue(neighbors)
    const core = createCore()
    vi.spyOn(core.wiki, 'copies').mockResolvedValue([
      { language: { label: 'English', folder: 'wiki' }, path: 'wiki/rust.md' },
    ])
    const view = await renderSidebar('wiki/rust.md', 360, core)
    const languages = view.getByRole('group', { name: 'Language' })
    await expect.element(languages).toBeVisible()
    const neighbor = view.getByText('Neighbor 0')
    await expect.element(neighbor).toBeVisible()

    const sections = scrollContainerOf(neighbor.element())
    const languagesTop = languages.element().getBoundingClientRect().top
    sections.scrollTop = sections.scrollHeight
    expect(sections.scrollTop).toBeGreaterThan(0)
    expect(languages.element().getBoundingClientRect().top).toBe(languagesTop)
  })

  it('scrolls the whole sidebar when the window is too short for the note actions', async () => {
    relatedNotes.mockResolvedValue([zig])
    const view = await renderSidebar('notes/rust.md', 80)
    const neighbor = view.getByText('Zig')
    await expect.element(neighbor).toBeInTheDocument()

    const frame = view.getByTestId('context-frame').element()
    const sections = scrollContainerOf(neighbor.element())
    const panel = scrollContainerOf(sections)
    expect(frame.contains(panel)).toBe(true)
    // The sections keep room for their first lines instead of collapsing...
    expect(neighbor.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      sections.getBoundingClientRect().bottom,
    )
    // ...and are a scroll away.
    panel.scrollTop = panel.scrollHeight
    expect(panel.scrollTop).toBeGreaterThan(0)
    expect(neighbor.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      frame.getBoundingClientRect().bottom,
    )
  })

  it('starts with the sections when the note has nothing to pin', async () => {
    relatedNotes.mockResolvedValue([zig])
    // A read-only local-only note outside the wiki: no actions, no language switch.
    const view = await renderSidebar('archive/rust.md')
    const neighbor = view.getByText('Zig')
    await expect.element(neighbor).toBeVisible()
    expect(view.getByText('Note actions').query()).toBeNull()

    const frame = view.getByTestId('context-frame').element()
    expect(scrollContainerOf(neighbor.element()).getBoundingClientRect().top).toBe(
      frame.getBoundingClientRect().top,
    )
  })

  it('lists similar notes under their own section and navigates on click', async () => {
    relatedNotes.mockResolvedValue([zig])
    const view = await renderSidebar('notes/rust.md')
    await expect.element(view.getByText('Similar notes')).toBeInTheDocument()
    await userEvent.click(view.getByText('Zig'))
    await expect.element(view.getByTestId('route')).toMatchTextContent('"kind":"note"')
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/zig.md')
  })
})
