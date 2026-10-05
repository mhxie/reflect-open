import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { DailyActivity, DailyEditCount, NoteListEntry, NoteListOptions } from '@reflect/core'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { ActivitySection } from './activity-section.tsx'

const TODAY = '2026-10-03'

const listDailyActivity = vi.hoisted(() => vi.fn<() => Promise<DailyActivity[]>>())
const listDailyEditCounts = vi.hoisted(() => vi.fn<() => Promise<DailyEditCount[]>>())
const listNotes = vi.hoisted(() =>
  vi.fn<(options: NoteListOptions) => Promise<NoteListEntry[]>>(async () => []),
)
const settingsState = vi.hoisted(() => ({ activityHeatmapEnabled: true }))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  listDailyActivity,
  listDailyEditCounts,
  listNotes,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/lib/use-today.ts', () => ({ useToday: () => TODAY }))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      dateFormat: 'iso',
      weekStartDay: 'monday',
      activityHeatmapEnabled: settingsState.activityHeatmapEnabled,
    },
  }),
}))

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

async function renderSection(width = 300) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <div style={{ width }}>
          <ActivitySection />
        </div>
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
  return Object.assign(view, { client })
}

function editedOn(date: string): string {
  return JSON.stringify({ kind: 'allNotes', filter: { kind: 'updated', date } })
}

/** Week columns drawn: seven day cells each. */
function columnCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-date]').length / 7
}

function heatmap() {
  return page.getByRole('grid', { name: 'Daily note activity' })
}

beforeEach(() => {
  window.sessionStorage.clear()
  settingsState.activityHeatmapEnabled = true
  listDailyEditCounts.mockReset().mockResolvedValue([
    { date: '2026-10-02', notes: 3 },
    { date: '2026-09-29', notes: 1 },
  ])
  listDailyActivity.mockReset().mockResolvedValue([
    { date: '2026-09-28', characters: 40 },
    { date: '2026-10-01', characters: 300 },
    { date: '2026-10-02', characters: 1200 },
  ])
})

afterEach(async () => {
  await cleanup()
})

describe('ActivitySection', () => {
  it('draws the heatmap with month and weekday scales', async () => {
    await renderSection()

    await expect.element(page.getByText('Activity')).toBeVisible()
    await expect.element(heatmap()).toBeVisible()
    await expect.element(page.getByText('Sep', { exact: true })).toBeVisible()
    for (const weekday of ['Tue', 'Thu', 'Sat']) {
      await expect.element(page.getByText(weekday, { exact: true })).toBeVisible()
    }
  })

  it('shades days by size, names them with their counts, and leaves the future blank', async () => {
    const view = await renderSection()
    await expect.element(heatmap()).toBeVisible()

    const cell = (date: string) =>
      view.container.querySelector<HTMLElement>(`[data-date="${CSS.escape(date)}"]`)!
    expect(cell('2026-10-02').className).toContain('bg-accent')
    await expect
      .element(page.getByRole('gridcell', { name: '2026-10-02 · 3 notes · 1,200 chars' }))
      .toBeInTheDocument()
    expect(cell('2026-09-30').className).toContain('bg-surface-active')
    await expect
      .element(page.getByRole('gridcell', { name: '2026-09-30 · No notes' }))
      .toBeInTheDocument()
    expect(cell('2026-10-04').className).toContain('invisible')
  })

  it('shows one compact tooltip for the hovered day', async () => {
    await renderSection()

    await userEvent.hover(page.getByRole('gridcell', { name: /^2026-10-02/ }))
    await expect.element(page.getByText('10-02 · 3 notes · 1,200 chars')).toBeVisible()

    await userEvent.hover(page.getByRole('gridcell', { name: /^2026-09-29/ }))
    await expect.element(page.getByText('09-29 · 1 note')).toBeVisible()
    expect(page.getByText(/^10-02 ·/).query()).toBeNull()
  })

  it('previews the hovered day’s most recently edited notes', async () => {
    const entry = (path: string, title: string, mtime: number): NoteListEntry => ({
      isPrivate: false,
      hasConflict: false,
      path,
      title,
      snippet: '',
      tags: [],
      mtime,
      isPinned: false,
      pinnedOrder: null,
    })
    listNotes.mockResolvedValue([
      entry('notes/old.md', 'Oldest', 1),
      entry('daily/2026-10-02.md', '', 4),
      entry('notes/habits.md', 'Atomic Habits', 3),
      entry('notes/goals.md', 'Quarterly Goals', 2),
    ])
    await renderSection()

    await userEvent.hover(page.getByRole('gridcell', { name: /^2026-10-02/ }))

    await expect.element(page.getByText('Atomic Habits')).toBeVisible()
    await expect.element(page.getByText('Quarterly Goals')).toBeVisible()
    await expect.element(page.getByText('+1 more')).toBeVisible()
    expect(page.getByText('Oldest').query()).toBeNull()
    expect(listNotes).toHaveBeenCalledWith({ updatedOn: '2026-10-02' })
  })

  it('shows more weeks in a wider sidebar, with fixed-size square cells', async () => {
    const narrow = await renderSection(200)
    await expect.element(heatmap()).toBeVisible()
    const narrowColumns = columnCount(narrow.container)
    const narrowCell = narrow.container.querySelector('[data-date]')!.getBoundingClientRect()
    await cleanup()

    const wide = await renderSection(400)
    await expect.element(heatmap()).toBeVisible()
    await vi.waitFor(() => expect(columnCount(wide.container)).toBeGreaterThan(narrowColumns))
    const wideCell = wide.container.querySelector('[data-date]')!.getBoundingClientRect()
    expect(wideCell.width).toBe(narrowCell.width)
    expect(wideCell.width).toBe(wideCell.height)
  })

  it('opens All Notes filtered to the notes edited on a clicked day', async () => {
    await renderSection()

    await userEvent.click(page.getByRole('gridcell', { name: /^2026-09-30/ }))

    await expect.element(page.getByTestId('route')).toHaveTextContent(editedOn('2026-09-30'))
  })

  it('moves between days with the arrow keys from a single tab stop', async () => {
    const view = await renderSection()
    await expect.element(heatmap()).toBeVisible()
    const stops = view.container.querySelectorAll<HTMLElement>('[role="gridcell"][tabindex="0"]')
    expect(stops).toHaveLength(1)

    // WebKit's Tab skips buttons by default, so focus the grid's one stop directly.
    stops[0]!.focus()
    await expect.element(page.getByRole('gridcell', { name: /^2026-10-03/ })).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    await userEvent.keyboard('{ArrowLeft}')
    await expect.element(page.getByRole('gridcell', { name: /^2026-09-25/ })).toHaveFocus()
    await expect.element(page.getByText('09-25 · No notes')).toBeVisible()
    await userEvent.keyboard('{Enter}')

    await expect.element(page.getByTestId('route')).toHaveTextContent(editedOn('2026-09-25'))
  })

  it('stays hidden and fetches nothing when turned off in settings', async () => {
    settingsState.activityHeatmapEnabled = false
    const view = await renderSection()

    const queries = view.client.getQueryCache().getAll()
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.every((query) => query.state.fetchStatus === 'idle')).toBe(true)
    expect(listDailyActivity).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain('Activity')
  })

  it('renders nothing before the first daily note', async () => {
    listDailyActivity.mockResolvedValue([])
    const view = await renderSection()

    await vi.waitFor(() => expect(listDailyActivity).toHaveBeenCalled())
    expect(view.container.textContent).not.toContain('Activity')
  })
})
