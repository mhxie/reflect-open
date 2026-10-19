import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, onTestFinished, vi, type MockInstance } from 'vitest'
import type { ReactNode } from 'react'
import type { OpenTask, TaskService, TaskWriteResult } from '@reflect/core'
import { createTestCoreServices, makeOpenTask, type TestCoreServices } from '@reflect/core/testing'
import { useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { DayTasksSection } from './day-tasks-section.tsx'

const TODAY = '2026-10-03'

/**
 * The result of a write that changed nothing the rows need to re-address.
 */
const WRITTEN: TaskWriteResult = { source: '', moved: [], inserted: [], tasks: [], updatedAt: 0 }

// The section runs on the real `TaskService` of the test app services; each
// test steers its reads and writes through these spies.
let app: TestCoreServices
let getOpenTasks: MockInstance<TaskService['getOpenTasks']>
let writeTask: MockInstance<TaskService['writeTask']>

function dailyTask(date: string, markdown: string, astPath: number[] = [0]): OpenTask {
  return makeOpenTask({ notePath: `daily/${date}.md`, dailyDate: date, markdown, astPath })
}

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

/**
 * The section for `date` in a graph where `secure` is an editable local-only
 * folder and `archive` a read-only one.
 */
function renderSection(date: string) {
  return renderInApp(
    <>
      <DayTasksSection date={date} />
      <RouteProbe />
    </>,
    {
      app,
      graph: {
        root: '/g',
        name: 'g',
        generation: 1,
        localOnlyFolders: ['secure', 'archive'],
        localOnlyEditableFolders: ['secure'],
      },
      settings: { dateFormat: 'iso' },
    },
  )
}

beforeEach(() => {
  // A fresh app per test, so its task service's recently-completed set starts empty.
  app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  app.clock.setToday(TODAY)
  getOpenTasks = vi.spyOn(app.tasks, 'getOpenTasks').mockResolvedValue([])
  writeTask = vi.spyOn(app.tasks, 'writeTask').mockResolvedValue(WRITTEN)
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

    expect(writeTask).toHaveBeenCalledTimes(1)
    expect(writeTask).toHaveBeenCalledWith(
      expect.objectContaining({ markdown: 'write the review' }),
      [{ kind: 'toggle' }],
    )
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
    await vi.waitFor(() => expect(writeTask).toHaveBeenCalledTimes(1))
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

  it('keeps its place with an empty state when the day has no open tasks', async () => {
    getOpenTasks.mockResolvedValue([dailyTask(TODAY, 'write the review')])
    await renderSection('2026-10-05')

    await expect.element(page.getByText('Tasks', { exact: true })).toBeVisible()
    await expect.element(page.getByText('No tasks for this day')).toBeVisible()
  })

  it('shows only the header while the open tasks load', async () => {
    getOpenTasks.mockReturnValue(new Promise(() => {}))
    const view = await renderSection(TODAY)

    await expect.element(page.getByText('Tasks', { exact: true })).toBeVisible()
    await vi.waitFor(() => expect(getOpenTasks).toHaveBeenCalled())
    expect(view.container.textContent).not.toContain('No tasks for this day')
  })
})
