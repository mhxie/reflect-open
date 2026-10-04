import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { OpenTask } from '@reflect/core'
import { makeOpenTask } from '@/lib/tasks/open-task-fixture.ts'
import { resetRecentlyCompleted } from '@/lib/tasks/recently-completed.ts'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { DayTasksSection } from './day-tasks-section.tsx'

const TODAY = '2026-10-03'

const getOpenTasks = vi.hoisted(() => vi.fn<() => Promise<OpenTask[]>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getOpenTasks,
  // `secure` is an editable local-only folder, `archive` a read-only one.
  isLocalOnlyPath: (path: string) => path.startsWith('secure/') || path.startsWith('archive/'),
  isLocalOnlyReadOnlyPath: (path: string) => path.startsWith('archive/'),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/lib/use-today.ts', () => ({ useToday: () => TODAY }))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({ settings: { dateFormat: 'iso' } }),
}))
const toggleTask = vi.hoisted(() => vi.fn())
vi.mock('@/lib/note-task.ts', () => ({ toggleTask }))

/** The result of a write that changed nothing the cache needs to re-address. */
const WRITTEN = { source: '', moved: [], inserted: [], tasks: [] }

function dailyTask(date: string, markdown: string, astPath: number[] = [0]): OpenTask {
  return makeOpenTask({ notePath: `daily/${date}.md`, dailyDate: date, markdown, astPath })
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function renderSection(date: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider>
        <DayTasksSection date={date} />
        <RouteProbe />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  getOpenTasks.mockReset().mockResolvedValue([])
  toggleTask.mockReset().mockResolvedValue(WRITTEN)
  resetRecentlyCompleted()
})

afterEach(async () => {
  await cleanup()
})

describe('DayTasksSection', () => {
  it('lists overdue tasks, then current ones with today first, on today', async () => {
    getOpenTasks.mockResolvedValue([
      dailyTask('2026-09-28', 'stale task'),
      dailyTask(TODAY, 'write the review'),
      makeOpenTask({
        notePath: 'notes/plan.md',
        noteTitle: 'Plan',
        markdown: 'send invoice',
        dueDate: '2026-09-30',
      }),
      dailyTask('2026-10-05', 'future task'),
      makeOpenTask({ notePath: 'notes/someday.md', markdown: 'undated task' }),
    ])
    const view = await renderSection(TODAY)

    await expect.element(page.getByText('Tasks', { exact: true })).toBeVisible()
    await expect.element(page.getByText('Overdue')).toBeVisible()
    await expect.element(page.getByText('Current')).toBeVisible()
    const text = view.container.textContent ?? ''
    expect(text.indexOf('send invoice')).toBeLessThan(text.indexOf('write the review'))
    expect(text.indexOf('write the review')).toBeLessThan(text.indexOf('stale task'))
    expect(text).toContain('2026-09-28')
    expect(text).not.toContain('future task')
    expect(text).not.toContain('undated task')
  })

  it("lists only another day's own tasks", async () => {
    getOpenTasks.mockResolvedValue([
      dailyTask(TODAY, 'write the review'),
      dailyTask('2026-10-05', 'future task'),
    ])
    const view = await renderSection('2026-10-05')

    await expect.element(page.getByText('future task')).toBeVisible()
    expect(view.container.textContent).not.toContain('write the review')
    expect(view.container.textContent).not.toContain('Current')
  })

  it('completes a task and keeps it struck so it can be reopened', async () => {
    getOpenTasks.mockResolvedValue([dailyTask(TODAY, 'write the review')])
    await renderSection(TODAY)

    await userEvent.click(page.getByRole('button', { name: 'Complete: write the review' }))

    expect(toggleTask).toHaveBeenCalledTimes(1)
    await expect
      .element(page.getByRole('button', { name: 'Reopen: write the review' }))
      .toBeVisible()
  })

  it("opens a task's source note", async () => {
    getOpenTasks.mockResolvedValue([dailyTask('2026-10-01', 'call back')])
    await renderSection(TODAY)

    await userEvent.click(page.getByText('call back'))

    await expect
      .element(page.getByTestId('route'))
      .toHaveTextContent(JSON.stringify({ kind: 'daily', date: '2026-10-01' }))
  })

  it('keeps the checkbox inert for a task in a read-only local-only note', async () => {
    getOpenTasks.mockResolvedValue([
      makeOpenTask({ notePath: 'archive/vault.md', markdown: 'rotate keys', dueDate: TODAY }),
    ])
    await renderSection(TODAY)

    await expect.element(page.getByRole('button', { name: 'Complete: rotate keys' })).toBeDisabled()
  })

  it('toggles a task in an editable local-only note', async () => {
    getOpenTasks.mockResolvedValue([
      makeOpenTask({ notePath: 'secure/vault.md', markdown: 'rotate keys', dueDate: TODAY }),
    ])
    await renderSection(TODAY)

    await userEvent.click(page.getByRole('button', { name: 'Complete: rotate keys' }))
    await vi.waitFor(() => expect(toggleTask).toHaveBeenCalledTimes(1))
  })

  it('caps the list and links to the Tasks view', async () => {
    getOpenTasks.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) => dailyTask(TODAY, `task ${index}`, [index])),
    )
    const view = await renderSection(TODAY)

    await expect.element(page.getByText('task 9')).toBeVisible()
    expect(view.container.textContent).not.toContain('task 10')
    await userEvent.click(page.getByRole('button', { name: 'View all 12 in Tasks' }))
    await expect
      .element(page.getByTestId('route'))
      .toHaveTextContent(JSON.stringify({ kind: 'tasks' }))
  })

  it('renders nothing when the day has no open tasks', async () => {
    const view = await renderSection(TODAY)

    await vi.waitFor(() => expect(getOpenTasks).toHaveBeenCalled())
    expect(view.container.textContent).not.toContain('Tasks')
  })
})
