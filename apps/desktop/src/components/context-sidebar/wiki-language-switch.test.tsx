import { render } from 'vitest-browser-react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { WikiLanguageSwitch } from './wiki-language-switch.tsx'

const wikiCopies = vi.hoisted(() => vi.fn())
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  wikiCopies,
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
        { label: '日本語', folder: 'wiki-ja' },
      ],
    },
    updateSettings: () => {},
  }),
}))

const ENGLISH = { label: 'English', folder: 'wiki' }
const CHINESE = { label: '简体中文', folder: 'wiki-cn' }
const JAPANESE = { label: '日本語', folder: 'wiki-ja' }

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSection(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <WikiLanguageSwitch path={path} />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
  wikiCopies.mockReset().mockResolvedValue([
    { language: ENGLISH, path: 'wiki/memory/Spacing Effect.md' },
    { language: CHINESE, path: 'wiki-cn/memory/Spacing Effect.md' },
    { language: JAPANESE, path: null },
  ])
})

describe('WikiLanguageSwitch', () => {
  it('presses the copy being read, on one line, and opens another language in place', async () => {
    const view = await renderSection('wiki/memory/Spacing Effect.md')

    const switcher = view.getByRole('group', { name: 'Language' })
    await expect
      .element(switcher.getByRole('button', { name: 'English' }))
      .toHaveAttribute('aria-pressed', 'true')
    const buttons = [...switcher.element().querySelectorAll('button')]
    expect(new Set(buttons.map((button) => button.getBoundingClientRect().top)).size).toBe(1)

    await view.getByRole('button', { name: 'English' }).click()
    // Pressing the copy being read stays put.
    expect(JSON.parse(view.getByTestId('route').element().textContent ?? 'null')).toEqual({
      kind: 'today',
    })

    await view.getByRole('button', { name: '简体中文' }).click()

    expect(JSON.parse(view.getByTestId('route').element().textContent ?? 'null')).toEqual({
      kind: 'note',
      path: 'wiki-cn/memory/Spacing Effect.md',
    })
  })

  it('opens a language in a new window on ⌘-click', async () => {
    const view = await renderSection('wiki/memory/Spacing Effect.md')

    await view.getByRole('button', { name: '简体中文' }).click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'wiki-cn/memory/Spacing Effect.md',
      }),
    )
  })

  it('dims a language without a copy', async () => {
    const view = await renderSection('wiki/memory/Spacing Effect.md')

    await expect
      .element(view.getByRole('button', { name: '日本語, not translated' }))
      .toBeDisabled()
  })

  it('renders nothing for a note outside the wiki', async () => {
    const view = await renderSection('notes/plan.md')

    expect(view.getByRole('group', { name: 'Language' }).query()).toBeNull()
    expect(wikiCopies).not.toHaveBeenCalled()
  })
})
