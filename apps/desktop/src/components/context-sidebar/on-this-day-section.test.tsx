import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OnThisDayEntry } from '@reflect/core'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { OnThisDaySection } from './on-this-day-section.tsx'

const listOnThisDay = vi.hoisted(() => vi.fn<(date: string) => Promise<OnThisDayEntry[]>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  listOnThisDay,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy' }, updateSettings: () => {} }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSection(date: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <OnThisDaySection date={date} />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  listOnThisDay.mockReset().mockResolvedValue([])
})

afterEach(async () => {
  await cleanup()
})

describe('OnThisDaySection', () => {
  it('lists earlier years of the day with their previews', async () => {
    listOnThisDay.mockResolvedValue([
      { path: 'daily/2025-10-03.md', dailyDate: '2025-10-03', preview: 'Shipped v1', yearsAgo: 1 },
      { path: 'daily/2023-10-03.md', dailyDate: '2023-10-03', preview: '', yearsAgo: 3 },
    ])
    await renderSection('2026-10-03')

    await expect.element(page.getByText('On this day')).toBeVisible()
    await expect.element(page.getByText('1 year ago')).toBeVisible()
    await expect.element(page.getByText('Shipped v1')).toBeVisible()
    await expect.element(page.getByText('3 years ago')).toBeVisible()
    expect(listOnThisDay).toHaveBeenCalledWith('2026-10-03')
  })

  it('opens the earlier day when a row is clicked', async () => {
    listOnThisDay.mockResolvedValue([
      { path: 'daily/2025-10-03.md', dailyDate: '2025-10-03', preview: 'Shipped v1', yearsAgo: 1 },
    ])
    await renderSection('2026-10-03')

    await userEvent.click(page.getByRole('button', { name: /1 year ago/ }))

    await expect
      .element(page.getByTestId('route'))
      .toHaveTextContent(JSON.stringify({ kind: 'daily', date: '2025-10-03' }))
  })

  it('renders nothing when no earlier year has an entry', async () => {
    const view = await renderSection('2026-10-03')

    await vi.waitFor(() => expect(listOnThisDay).toHaveBeenCalled())
    expect(view.container.textContent).not.toContain('On this day')
  })
})
