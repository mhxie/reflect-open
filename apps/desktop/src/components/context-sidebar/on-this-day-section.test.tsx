import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { DailyActivityService } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import { useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { OnThisDaySection } from './on-this-day-section.tsx'

const listOnThisDay = vi.fn<DailyActivityService['listOnThisDay']>()

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

async function renderSection(date: string) {
  const app = createTestCoreServices()
  vi.spyOn(app.dailyActivity, 'listOnThisDay').mockImplementation(listOnThisDay)
  return await renderInApp(
    <>
      <OnThisDaySection date={date} />
      <RouteProbe />
    </>,
    { app, graph: { root: '/g', name: 'g' }, settings: { dateFormat: 'mdy' } },
  )
}

beforeEach(() => {
  listOnThisDay.mockReset().mockResolvedValue([])
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
