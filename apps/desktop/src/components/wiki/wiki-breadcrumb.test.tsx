import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { WikiBreadcrumb } from './wiki-breadcrumb.tsx'

const wikiAncestors = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  wikiAncestors,
}))
vi.mock('@/lib/windows/open-in-new-window.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window.ts')>()),
  openRouteInNewWindow,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      wikiLanguages: [
        { label: 'English', folder: 'wiki' },
        { label: '简体中文', folder: 'wiki-cn' },
      ],
    },
    updateSettings: () => {},
  }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderBreadcrumb(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <div data-testid="host">
          <WikiBreadcrumb path={path} />
        </div>
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
  wikiAncestors.mockReset().mockResolvedValue([
    { path: 'wiki-cn/index.md', title: 'Wiki 索引', displayTitle: null, lang: 'zh-CN' },
    { path: 'wiki-cn/memory/index.md', title: '记忆', displayTitle: null, lang: 'zh-CN' },
  ])
})

describe('WikiBreadcrumb', () => {
  it('shows the indexes above a note, root first, on one line, each opening in place', async () => {
    const view = await renderBreadcrumb('wiki-cn/memory/Spacing Effect.md')

    const trail = view.getByRole('navigation', { name: 'Wiki path' })
    await expect.element(trail.getByRole('button', { name: 'Wiki 索引，中文' })).toBeVisible()
    const crumbs = [...trail.element().querySelectorAll('button')]
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['Wiki 索引中文', '记忆中文'])
    expect(new Set(crumbs.map((crumb) => crumb.getBoundingClientRect().top)).size).toBe(1)
    expect(wikiAncestors).toHaveBeenCalledWith('wiki-cn/memory/Spacing Effect.md', [
      { label: 'English', folder: 'wiki' },
      { label: '简体中文', folder: 'wiki-cn' },
    ])

    await trail.getByRole('button', { name: '记忆，中文' }).click()

    expect(JSON.parse(view.getByTestId('route').element().textContent ?? 'null')).toEqual({
      kind: 'note',
      path: 'wiki-cn/memory/index.md',
    })
  })

  it('opens an index in a new window on a modifier click', async () => {
    const view = await renderBreadcrumb('wiki-cn/memory/Spacing Effect.md')

    await view
      .getByRole('button', { name: 'Wiki 索引，中文' })
      .click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({ kind: 'note', path: 'wiki-cn/index.md' }),
    )
  })

  it('holds its line while the lookup runs, so the title below does not jump', async () => {
    wikiAncestors.mockReturnValue(new Promise(() => {}))
    const view = await renderBreadcrumb('wiki/memory/Spacing Effect.md')

    await expect.element(view.getByTestId('wiki-path-pending')).toBeInTheDocument()
    const pending = view.getByTestId('wiki-path-pending').element()
    expect(pending.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(view.getByRole('navigation', { name: 'Wiki path' }).query()).toBeNull()
  })

  it('takes no space when the lookup fails', async () => {
    wikiAncestors.mockRejectedValue(new Error('index unavailable'))
    const view = await renderBreadcrumb('wiki/memory/Spacing Effect.md')

    await vi.waitFor(() => expect(wikiAncestors).toHaveBeenCalled())
    await vi.waitFor(() => expect(view.getByTestId('host').element().childElementCount).toBe(0))
  })

  it('takes no space when no index exists above a note', async () => {
    wikiAncestors.mockResolvedValue([])
    const view = await renderBreadcrumb('wiki/memory/Spacing Effect.md')

    await vi.waitFor(() => expect(view.getByTestId('host').element().childElementCount).toBe(0))
  })

  it('never asks the index where no index could sit above the note', async () => {
    for (const path of ['wiki/index.md', 'notes/plan.md']) {
      const view = await renderBreadcrumb(path)
      expect(view.getByTestId('host').element().childElementCount).toBe(0)
      await view.unmount()
    }
    expect(wikiAncestors).not.toHaveBeenCalled()
  })
})
