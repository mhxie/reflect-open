import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { scrollContainerOf } from '@/test-utils/scroll-container.ts'
import { NoteContextSidebar } from './note-context-sidebar.tsx'

const relatedNotes = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  relatedNotes,
  // `archive` is a read-only local-only folder.
  isLocalOnlyPath: (path: string) => path.startsWith('archive/'),
  isLocalOnlyReadOnlyPath: (path: string) => path.startsWith('archive/'),
}))
vi.mock('@/lib/use-embed-status.ts', () => ({
  useEmbedStatus: () => ({ status: 'ready', model: 'all-MiniLM-L6-v2' }),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      semanticSearchEnabled: true,
      wikiLanguages: [{ label: 'English', folder: 'wiki' }],
    },
    updateSettings: () => {},
  }),
}))

const zig = {
  path: 'notes/zig.md',
  title: 'Zig',
  score: 0.8,
  snippet: 'comptime experiments',
  heading: null,
  isPrivate: false,
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

/** Renders the sidebar in a clipping frame like AppShell's context region, `height` px tall if given. */
function renderSidebar(path: string, height?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <RouterProvider>
          <div data-testid="context-frame" className="overflow-hidden" style={{ height }}>
            <NoteContextSidebar path={path} />
          </div>
          <RouteProbe />
        </RouterProvider>
      </QueryClientProvider>
    </TooltipProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  relatedNotes.mockReset().mockResolvedValue([])
})

describe('NoteContextSidebar', () => {
  it('queries the note path for similar notes and shows no section without results', async () => {
    const view = await renderSidebar('notes/rust.md')
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('notes/rust.md', 6))
    expect(view.getByText('Similar notes').query()).toBeNull()
    await view.unmount()
  })

  it('keeps the note actions at the top while the sections scroll', async () => {
    relatedNotes.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        path: `notes/neighbor-${index}.md`,
        title: `Neighbor ${index}`,
        score: 0.9,
        snippet: 'a semantic neighbor of the note',
        heading: null,
        isPrivate: false,
      })),
    )
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
    await view.unmount()
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
    await view.unmount()
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
    await view.unmount()
  })

  it('lists similar notes under their own section and navigates on click', async () => {
    relatedNotes.mockResolvedValue([zig])
    const view = await renderSidebar('notes/rust.md')
    await expect.element(view.getByText('Similar notes')).toBeInTheDocument()
    await userEvent.click(view.getByText('Zig'))
    await expect.element(view.getByTestId('route')).toMatchTextContent('"kind":"note"')
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/zig.md')
    await view.unmount()
  })
})
