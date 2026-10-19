import { createTestWindowService } from '@reflect/app/testing'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { actAsync } from '@/test-utils/act.ts'
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
import { deepLinkForRoute } from '@/lib/deep-links/format.ts'
import { monthLabel, monthOf } from '@/lib/month-grid.ts'
import { useRouter } from '@/routing/router.tsx'
import { fireEvent } from '@/test-utils/fire-event.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { scrollContainerOf } from '@/test-utils/scroll-container.ts'
import { DailyContextSidebar } from './daily-context-sidebar.tsx'

// What the app's fakes answer; each test sets them before `renderSidebar`.
const dailyDatesInRange = vi.fn<DailyNoteService['dailyDatesInRange']>()
const listDailyActivity = vi.fn<DailyActivityService['listDailyActivity']>()
const listDailyEditCounts = vi.fn<DailyActivityService['listDailyEditCounts']>()
const relatedNotes = vi.fn<RetrievalService['relatedNotes']>()
const openNoteWindow = vi.fn<(deepLink: string) => boolean | Promise<boolean>>()
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
    noteFile,
    storage,
    retrieval: createTestRetrievalService({ relatedNotes }),
  })
  vi.spyOn(app.dailyNotes, 'dailyDatesInRange').mockImplementation(dailyDatesInRange)
  vi.spyOn(app.dailyActivity, 'listDailyActivity').mockImplementation(listDailyActivity)
  vi.spyOn(app.dailyActivity, 'listDailyEditCounts').mockImplementation(listDailyEditCounts)
  vi.spyOn(app.tasks, 'getOpenTasks').mockResolvedValue([])
  vi.spyOn(app.indexQuery, 'getNote').mockImplementation(async () => noteRowAnswer ?? undefined)
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
    hasConflict: false,
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

    await vi.waitFor(() =>
      expect(openNoteWindow).toHaveBeenCalledWith(
        deepLinkForRoute({
          kind: 'daily',
          date: '2026-06-18',
        }),
      ),
    )
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

    await actAsync(async () => {
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
    await vi.waitFor(() =>
      expect(noteFile.getReads().map((read) => read.path)).toContain('daily/2026-06-09.md'),
    )
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
        hasConflict: false,
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

  it("keeps the day's tasks directly under the calendar, above the graph-wide activity", async () => {
    listDailyActivity.mockResolvedValue([{ date: '2026-06-08', characters: 120 }])
    const view = await renderSidebar('2026-06-09')
    await expect.element(page.getByText('No tasks for this day')).toBeVisible()
    await expect.element(page.getByRole('button', { name: /Activity/ })).toBeVisible()

    const headers = [
      ...view.getByTestId('context-frame').element().querySelectorAll('button[aria-expanded]'),
    ].map((header) => header.textContent)
    expect(headers).toEqual(['Tasks', 'Note actions', 'Activity'])
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
    expect(frame.bottom - grid.bottom).toBeLessThan(20)
  })

  it('scrolls the calendar and sections while the activity heatmap stays put', async () => {
    listDailyActivity.mockResolvedValue([{ date: '2026-06-08', characters: 120 }])
    await renderSidebar('2026-06-09', createApp(), 320)
    const tasks = page.getByText('No tasks for this day')
    await expect.element(tasks).toBeVisible()
    const activity = page.getByRole('button', { name: /Activity/ })
    await expect.element(activity).toBeVisible()

    const scroller = scrollContainerOf(tasks.element())
    expect(scroller.contains(activity.element())).toBe(false)
    const tasksTop = tasks.element().getBoundingClientRect().top
    const activityTop = activity.element().getBoundingClientRect().top
    scroller.scrollTop = scroller.scrollHeight
    expect(scroller.scrollTop).toBeGreaterThan(0)
    expect(tasks.element().getBoundingClientRect().top).toBeLessThan(tasksTop)
    expect(activity.element().getBoundingClientRect().top).toBe(activityTop)
  })

  it('keeps half of a minimum-height sidebar for the sections, and the heatmap scrolls in the rest', async () => {
    listDailyActivity.mockResolvedValue([{ date: '2026-06-08', characters: 120 }])
    // Tauri's minimum window height.
    const view = await renderSidebar('2026-06-09', createApp(), 200)
    const tasks = page.getByText('No tasks for this day')
    await expect.element(tasks).toBeInTheDocument()
    const heatmap = page.getByRole('grid', { name: 'Daily note activity' })
    await expect.element(heatmap).toBeInTheDocument()

    const frame = view.getByTestId('context-frame').element()
    const sections = scrollContainerOf(tasks.element())
    expect(sections.clientHeight).toBeGreaterThanOrEqual(frame.clientHeight / 2)
    const footer = scrollContainerOf(heatmap.element())
    expect(frame.contains(footer)).toBe(true)
    expect(footer.contains(tasks.element())).toBe(false)
    footer.scrollTop = footer.scrollHeight
    expect(footer.scrollTop).toBeGreaterThan(0)
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
