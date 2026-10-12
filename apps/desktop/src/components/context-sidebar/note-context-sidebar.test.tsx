import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { NoteContextSidebar } from './note-context-sidebar.tsx'

const relatedNotes = vi.hoisted(() => vi.fn())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  relatedNotes,
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

  it('scrolls its sections within the context region', async () => {
    const view = await renderSidebar('notes/rust.md', 80)
    await expect.element(view.getByText('Pin this note')).toBeVisible()

    const panel = view.getByTestId('context-frame').element().firstElementChild!
    panel.scrollTop = panel.scrollHeight
    expect(panel.scrollTop).toBeGreaterThan(0)
    await view.unmount()
  })

  it('lists similar notes under their own section and navigates on click', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/zig.md',
        title: 'Zig',
        score: 0.8,
        snippet: 'comptime experiments',
        heading: null,
        isPrivate: false,
      },
    ])
    const view = await renderSidebar('notes/rust.md')
    await expect.element(view.getByText('Similar notes')).toBeInTheDocument()
    await userEvent.click(view.getByText('Zig'))
    await expect.element(view.getByTestId('route')).toMatchTextContent('"kind":"note"')
    await expect.element(view.getByTestId('route')).toMatchTextContent('notes/zig.md')
    await view.unmount()
  })
})
