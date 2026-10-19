import type { MaybePromise } from '@reflect/utils'
import { createTestWindowService } from '@reflect/app/testing'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act } from '@/test-utils/act.ts'
import type {
  DailyActivityService,
  DailyNoteService,
  NoteRow,
  RetrievalService,
} from '@reflect/core'
import {
  createTestCoreServices,
  createTestNoteFileService,
  createTestRetrievalService,
  createTestStorageService,
  type TestNoteFileService,
  type TestStorageService,
} from '@reflect/core/testing'
import { formatDayLabel } from '@/lib/dates.ts'
import { deepLinkForRoute } from '@reflect/app'
import { monthLabel, monthOf } from '@/lib/month-grid.ts'
import { useRouter } from '@/routing/router.tsx'
import { fireEvent } from '@/test-utils/fire-event.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { scrollContainerOf } from '@/test-utils/scroll-container.ts'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { DailyContextSidebar } from './daily-context-sidebar.tsx'

// What the app's fakes answer; each test sets them before `renderSidebar`.
const dailyDatesInRange = vi.fn<DailyNoteService['dailyDatesInRange']>()
const listDailyActivity = vi.fn<DailyActivityService['listDailyActivity']>()
const listDailyEditCounts = vi.fn<DailyActivityService['listDailyEditCounts']>()
const relatedNotes = vi.fn<RetrievalService['relatedNotes']>()
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()
let noteRowAnswer: NoteRow | null
let dailySource: string

// The note files of the rendered app; set by `createApp`.
let noteFile: TestNoteFileService

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

/**
 * The sidebar in a clipping frame like AppShell's context region, `height` px tall if given.
 */
function sidebar(date: string, height?: number): ReactNode {
  return (
    <>
      <div data-testid="context-frame" className="overflow-hidden" style={{ height }}>
        <DailyContextSidebar date={date} />
      </div>
      <RouteProbe />
    </>
  )
}

function createApp(storage: TestStorageService = createTestStorageService()) {
  noteFile = createTestNoteFileService({ files: { 'daily/2026-06-09.md': dailySource } })
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile,
    storage,
    retrieval: createTestRetrievalService({ relatedNotes }),
  })
  vi.spyOn(app.dailyNotes, 'dailyDatesInRange').mockImplementation(dailyDatesInRange)
  vi.spyOn(app.dailyActivity, 'listDailyActivity').mockImplementation(listDailyActivity)
  vi.spyOn(app.dailyActivity, 'listDailyEditCounts').mockImplementation(listDailyEditCounts)
  vi.spyOn(app.tasks, 'getOpenTasks').mockResolvedValue([])
  vi.spyOn(app.indexQuery, 'getNote').mockImplementation(() => {
    return Promise.resolve(noteRowAnswer ?? undefined)
  })
  return app
}

async function renderSidebar(date: string, app = createApp(), height?: number) {
  return await renderInApp(sidebar(date, height), {
    app,
    appServices: { window: createTestWindowService({ openNoteWindow }) },
    graph: { root: '/g', name: 'g' },
    settings: {
      semanticSearchEnabled: true,
      activityHeatmapEnabled: true,
      dateFormat: 'mdy',
      weekStartDay: 'monday',
    },
  })
}

function noteRow(overrides: Partial<NoteRow> = {}): NoteRow {
  return {
    path: 'daily/2026-06-09.md',
    title: '2026-06-09',
    dailyDate: '2026-06-09',
    isPrivate: false,
    gistUrl: null,
    gistStale: false,
    ...overrides,
  }
}

beforeEach(() => {
  dailyDatesInRange.mockReset().mockResolvedValue([])
  listDailyActivity.mockReset().mockResolvedValue([])
  listDailyEditCounts.mockReset().mockResolvedValue([])
  relatedNotes.mockReset().mockResolvedValue([])
  openNoteWindow.mockReset().mockResolvedValue(true)
  noteRowAnswer = null
  dailySource = '- daily entry\n'
})

describe('DailyContextSidebar calendar header', () => {
  it('jumps to today from the calendar-icon button', async () => {
    await renderSidebar('2026-06-09')
    await userEvent.click(page.getByRole('button', { name: 'Jump to today' }))
    await expect.element(page.getByTestId('route')).toMatchTextContent('"kind":"today"')
  })
})

describe('DailyContextSidebar calendar', () => {
  it('marks days that have a daily note and navigates on day click', async () => {
    dailyDatesInRange.mockResolvedValue(['2026-06-05'])
    await renderSidebar('2026-06-09')

    await expect.element(page.getByTestId('note-dot-2026-06-05')).toBeVisible()
    expect(dailyDatesInRange).toHaveBeenCalledWith('2026-06-01', '2026-07-05')
    await expect.element(page.getByTestId('note-dot-2026-06-04')).not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') }))
    await expect.element(page.getByTestId('route')).toMatchTextContent('2026-06-18')
  })

  it('modifier-click opens a day in a new window without moving the current window', async () => {
    await renderSidebar('2026-06-09')
    const day = page.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') })

    fireEvent.click(day, { metaKey: true, ctrlKey: true })

    await vi.waitFor(() => {
      expect(openNoteWindow).toHaveBeenCalledWith(
        deepLinkForRoute({
          kind: 'daily',
          date: '2026-06-18',
        }),
      )
    })
    expect(openNoteWindow).toHaveBeenCalledTimes(1)
    await expect
      .element(page.getByTestId('route'))
      .toMatchTextContent(JSON.stringify({ kind: 'today' }))
  })

  it('does not fall back after the calendar scope moves to another selected day', async () => {
    const pendingOpen = Promise.withResolvers<boolean>()
    openNoteWindow.mockReturnValue(pendingOpen.promise)
    const view = await renderSidebar('2026-06-09')
    const day = page.getByRole('button', { name: formatDayLabel('2026-06-18', 'mdy') })

    fireEvent.click(day, { metaKey: true, ctrlKey: true })
    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalledTimes(1))
    await view.rerender(sidebar('2026-06-10'))

    await act(() => {
      pendingOpen.resolve(false)
    })

    await expect
      .element(page.getByTestId('route'))
      .toMatchTextContent(JSON.stringify({ kind: 'today' }))
  })

  it('pages between months across year boundaries', async () => {
    await renderSidebar('2026-01-15')
    await expect.element(page.getByText(monthLabel('2026-01'))).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Previous month' }))
    await expect.element(page.getByText(monthLabel('2025-12'))).toBeVisible()
    await userEvent.click(page.getByRole('button', { name: 'Next month' }))
    await userEvent.click(page.getByRole('button', { name: 'Next month' }))
    await expect.element(page.getByText(monthLabel('2026-02'))).toBeVisible()
  })

  it('re-anchors the visible month when the selected day changes', async () => {
    const view = await renderSidebar('2026-06-09')
    await expect.element(page.getByText(monthLabel('2026-06'))).toBeVisible()
    await view.rerender(sidebar('2026-09-01'))
    await expect.element(page.getByText(monthLabel('2026-09'))).toBeVisible()
  })
})

describe('DailyContextSidebar related notes', () => {
  it('renders no Similar notes section without results', async () => {
    await renderSidebar('2026-06-09')
    await vi.waitFor(() => expect(relatedNotes).toHaveBeenCalledWith('daily/2026-06-09.md', 6))
    await expect.element(page.getByText('Similar notes')).not.toBeInTheDocument()
  })

  it('does not calculate Similar notes for an empty-bullet daily note', async () => {
    dailySource = '- \n'
    await renderSidebar('2026-06-09')
    await vi.waitFor(() => {
      expect(noteFile.getReads().map((read) => read.path)).toContain('daily/2026-06-09.md')
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relatedNotes).not.toHaveBeenCalled()
    await expect.element(page.getByText('Similar notes')).not.toBeInTheDocument()
  })

  it('lists semantic neighbors when they exist', async () => {
    relatedNotes.mockResolvedValue([
      {
        path: 'notes/rust.md',
        title: 'Rust',
        score: 0.9,
        snippet: 'borrow checker notes',
        heading: null,
        isPrivate: false,
      },
    ])
    await renderSidebar('2026-06-09')
    await expect.element(page.getByText('Rust')).toBeVisible()
    // The daily sidebar wires SimilarNotesSection (note-context-sidebar's
    // tests pin the same title).
    await expect.element(page.getByText('Similar notes')).toBeVisible()
    await userEvent.click(page.getByText('Rust'))
    await expect.element(page.getByTestId('route')).toMatchTextContent('notes/rust.md')
  })
})

describe('DailyContextSidebar sections', () => {
  it('collapses a section and persists the state for the session', async () => {
    // One session: both mounts read the same storage.
    const storage = createTestStorageService()
    const view = await renderSidebar('2026-06-09', createApp(storage))
    const header = page.getByRole('button', { name: /Note actions/ })
    await expect.element(header).toHaveAttribute('aria-expanded', 'true')
    await expect.element(page.getByText('Pin this note')).toBeVisible()

    await userEvent.click(header)
    await expect.element(header).toHaveAttribute('aria-expanded', 'false')
    await expect.element(page.getByText('Pin this note')).not.toBeInTheDocument()
    await view.unmount()

    await renderSidebar('2026-06-09', createApp(storage))
    await expect
      .element(page.getByRole('button', { name: /Note actions/ }))
      .toHaveAttribute('aria-expanded', 'false')
  })

  it("stacks the calendar, the note actions, the day's tasks, then the graph-wide activity", async () => {
    listDailyActivity.mockResolvedValue([{ date: '2026-06-08', characters: 120 }])
    const view = await renderSidebar('2026-06-09')
    await expect.element(page.getByText('No tasks for this day')).toBeVisible()
    await expect.element(page.getByRole('button', { name: /Activity/ })).toBeVisible()

    const order = [
      ...view
        .getByTestId('context-frame')
        .element()
        .querySelectorAll('[aria-label="Calendar"], button[aria-expanded]'),
    ].map((element) => element.getAttribute('aria-label') ?? element.textContent)
    expect(order).toEqual(['Calendar', 'Note actions', 'Tasks', 'Activity'])
  })

  it('keeps the activity heatmap at the bottom of a sidebar taller than its sections', async () => {
    listDailyActivity.mockResolvedValue([{ date: '2026-06-08', characters: 120 }])
    const view = await renderSidebar('2026-06-09', createApp(), 1000)
    const tasks = page.getByText('No tasks for this day')
    await expect.element(tasks).toBeVisible()
    const heatmap = page.getByRole('grid', { name: 'Daily note activity' })
    await expect.element(heatmap).toBeVisible()

    const scroller = scrollContainerOf(tasks.element())
    expect(scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight)
    const frame = view.getByTestId('context-frame').element().getBoundingClientRect()
    const grid = heatmap.element().getBoundingClientRect()
    expect(grid.top).toBeGreaterThanOrEqual(scroller.getBoundingClientRect().bottom)
    // Only the footer's own padding lies between the heatmap and the bottom edge.
    expect(frame.bottom - grid.bottom).toBeLessThan(24)
  })

  it('scrolls only the sections between the pinned calendar, note actions and heatmap', async () => {
    listDailyActivity.mockResolvedValue([{ date: '2026-06-08', characters: 120 }])
    noteRowAnswer = noteRow({ gistUrl: 'https://gist.github.com/me/abc123' })
    relatedNotes.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        path: `notes/neighbor-${index}.md`,
        title: `Neighbor ${index}`,
        score: 0.9,
        snippet: 'a semantic neighbor of the day',
        heading: null,
        isPrivate: false,
      })),
    )
    // Room for the pinned parts and a few lines of sections.
    await renderSidebar('2026-06-09', createApp(), 720)
    const tasks = page.getByText('No tasks for this day')
    await expect.element(tasks).toBeVisible()
    await expect.element(page.getByText('Neighbor 5')).toBeInTheDocument()
    const heatmap = page.getByRole('grid', { name: 'Daily note activity' })
    await expect.element(heatmap).toBeVisible()
    await expect.element(page.getByText('Published URL')).toBeVisible()
    const pinned = [
      page.getByText(monthLabel(monthOf('2026-06-09'))).element(),
      page.getByText('Pin this note').element(),
      page.getByText('Published URL').element(),
      heatmap.element(),
    ]

    const sections = scrollContainerOf(tasks.element())
    const panel = scrollContainerOf(sections)
    expect(panel.scrollHeight).toBeLessThanOrEqual(panel.clientHeight)
    expect(sections.scrollHeight).toBeGreaterThan(sections.clientHeight)
    const pinnedTops = pinned.map((element) => element.getBoundingClientRect().top)
    const tasksTop = tasks.element().getBoundingClientRect().top
    sections.scrollTop = sections.scrollHeight
    expect(sections.scrollTop).toBeGreaterThan(0)
    expect(tasks.element().getBoundingClientRect().top).toBeLessThan(tasksTop)
    expect(pinned.map((element) => element.getBoundingClientRect().top)).toEqual(pinnedTops)
  })

  it('keeps the parts pinned in a default-size window, even for a six-row month', async () => {
    listDailyActivity.mockResolvedValue([{ date: '2026-08-08', characters: 120 }])
    // The app's default window is 650px tall; August 2026 takes six calendar rows.
    await renderSidebar('2026-08-09', createApp(), 650)
    const tasks = page.getByText('No tasks for this day')
    await expect.element(tasks).toBeVisible()
    await expect.element(page.getByRole('grid', { name: 'Daily note activity' })).toBeVisible()

    const panel = scrollContainerOf(scrollContainerOf(tasks.element()))
    expect(panel.scrollHeight).toBeLessThanOrEqual(panel.clientHeight)
  })

  it("starts another day's sections at the top, even a day already loaded", async () => {
    listDailyActivity.mockResolvedValue([{ date: '2026-06-08', characters: 120 }])
    relatedNotes.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        path: `notes/neighbor-${index}.md`,
        title: `Neighbor ${index}`,
        score: 0.9,
        snippet: 'a semantic neighbor of the day',
        heading: null,
        isPrivate: false,
      })),
    )
    const app = createApp()
    noteFile.set('daily/2026-06-10.md', '- another entry\n')
    const view = await renderSidebar('2026-06-10', app, 720)
    await expect.element(page.getByText('Neighbor 5')).toBeInTheDocument()
    await view.rerender(sidebar('2026-06-09', 720))
    await expect.element(page.getByText('Neighbor 5')).toBeInTheDocument()
    await expect.element(page.getByRole('grid', { name: 'Daily note activity' })).toBeVisible()
    const sections = () => scrollContainerOf(page.getByText('No tasks for this day').element())
    sections().scrollTop = sections().scrollHeight
    expect(sections().scrollTop).toBeGreaterThan(0)

    // Back to a day whose sections are cached, so they render at full height at once.
    await view.rerender(sidebar('2026-06-10', 720))
    await expect.element(page.getByText('Neighbor 5')).toBeInTheDocument()
    expect(sections().scrollTop).toBe(0)
  })

  it('scrolls the whole sidebar when the window is too short for the pinned parts', async () => {
    listDailyActivity.mockResolvedValue([{ date: '2026-06-08', characters: 120 }])
    // Tauri's minimum window height.
    const view = await renderSidebar('2026-06-09', createApp(), 200)
    const tasks = page.getByText('No tasks for this day')
    await expect.element(tasks).toBeInTheDocument()
    const heatmap = page.getByRole('grid', { name: 'Daily note activity' })
    await expect.element(heatmap).toBeInTheDocument()

    const frame = view.getByTestId('context-frame').element()
    const sections = scrollContainerOf(tasks.element())
    const panel = scrollContainerOf(sections)
    expect(frame.contains(panel)).toBe(true)
    // The sections keep room for their first lines instead of collapsing...
    expect(tasks.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      sections.getBoundingClientRect().bottom,
    )
    // ...and the heatmap is a scroll away.
    panel.scrollTop = panel.scrollHeight
    expect(panel.scrollTop).toBeGreaterThan(0)
    expect(heatmap.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(
      frame.getBoundingClientRect().bottom,
    )
  })

  it('the calendar is not collapsible', async () => {
    await renderSidebar('2026-06-09')
    await expect.element(page.getByText(monthLabel(monthOf('2026-06-09')))).toBeVisible()
    await expect.element(page.getByRole('button', { name: /^Calendar$/ })).not.toBeInTheDocument()
  })
})

describe('DailyContextSidebar published link', () => {
  it('shows the Published URL section once the daily note is published', async () => {
    const url = 'https://gist.github.com/alex/daily1'
    noteRowAnswer = noteRow({ gistUrl: url })
    await renderSidebar('2026-06-09')
    await expect.element(page.getByText('Published URL')).toBeVisible()
    await expect.element(page.getByRole('link', { name: url })).toHaveAttribute('href', url)
  })

  it('omits the Published URL section for an unpublished daily note', async () => {
    await renderSidebar('2026-06-09')
    await expect.element(page.getByText('Published URL')).not.toBeInTheDocument()
  })
})
