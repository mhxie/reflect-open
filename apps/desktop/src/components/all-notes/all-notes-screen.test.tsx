import { createTestCoreServices, createTestNoteFileService } from '@reflect/core/testing'
import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi, type MockInstance } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { mouse } from 'vitest-browser-commands/playwright'
import { render } from 'vitest-browser-react'
import type { ReactElement } from 'react'
import {
  buildIndexedNote,
  KNOWLEDGE_LEVELS_PATH,
  parseNote,
  type NoteFileService,
  type Settings,
} from '@reflect/core'
import { deepLinkForRoute } from '@/lib/deep-links/format.ts'
import { queryKeys } from '@/lib/query-client.ts'
import type { AllNotesFilter } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'
import { act } from '@/test-utils/act.ts'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { hover } from '@/test-utils/mouse.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { AllNotesScreen } from './all-notes-screen.tsx'

/**
 * The All Notes screen over the real query layer and a seeded test index:
 * rows from the index, tag tabs from settings, the Custom menu from the facet
 * query, and navigation through the real router.
 */

interface SeedNote {
  path: string
  title: string
  mtime: number
  preview: string
  tags?: readonly string[]
  /** The indexed flags, which the seeded markdown does not carry. */
  isPrivate?: boolean
  hasConflict?: boolean
  /** A numbered pin's shelf position; unpinned when absent. */
  pinnedOrder?: number
  /** The attachments the note references. */
  assets?: readonly string[]
}

// Deterministic regardless of the test run's clock: both timestamps are far in
// the past, so the Updated column always renders the short-date form.
const HEALTH_MTIME = new Date(2020, 0, 15, 12, 0).getTime()
const TOKYO_MTIME = new Date(2020, 0, 10, 12, 0).getTime()

const healthRow: SeedNote = {
  path: 'notes/health.md',
  title: 'Health Stacked',
  mtime: HEALTH_MTIME,
  preview: 'Shop your health goals.',
  tags: ['link'],
}
const tokyoRow: SeedNote = {
  path: 'notes/tokyo.md',
  title: 'Tokyo Gâteau',
  mtime: TOKYO_MTIME,
  preview: 'Dandelion chocolate.',
  tags: ['link'],
  // The only note that references a PDF.
  assets: ['assets/menu.pdf'],
}
const noteRows: SeedNote[] = [healthRow, tokyoRow]
// A daily note: absent from the unfiltered list, present under its tag.
const taggedDailyRow: SeedNote = {
  path: 'daily/2026-06-09.md',
  title: '2026-06-09',
  mtime: TOKYO_MTIME,
  preview: 'Daily travel notes.',
  tags: ['travel'],
}
const facetRows = [
  { tag: 'book', count: 3 },
  { tag: 'travel', count: 2 },
]

const knowledgeLevelContract = {
  version: 1,
  levels: [
    { level: 1, label: 'Capture' },
    { level: 2, label: 'Working' },
    { level: 3, label: 'Sources' },
    { level: 4, label: 'Wiki' },
  ],
  rules: [
    { path: 'daily', match: 'tree', level: 1 },
    { path: 'notes', match: 'tree', level: 2 },
    { path: 'notes/tokyo.md', match: 'file', level: 4, role: 'shadow' },
  ],
}

const manyNoteRows: SeedNote[] = Array.from({ length: 1000 }, (_, index) => ({
  path: `notes/n${index}.md`,
  title: `Note ${index}`,
  mtime: 1_000_000 - index,
  preview: '',
}))

function noteMarkdown(note: SeedNote): string {
  const tags = (note.tags ?? []).map((tag) => `#${tag}`).join(' ')
  const heading = note.path.startsWith('daily/') ? '' : `# ${note.title}\n\n`
  return `${heading}${tags}\n`
}

function RoutedScreen(): ReactElement {
  const { route } = useRouter()
  return <AllNotesScreen filter={route.kind === 'allNotes' ? route.filter : null} />
}

/** Navigates to the already-active route — the sidebar-click-while-here case. */
function ReArrive(): ReactElement {
  const { navigate, back } = useRouter()
  return (
    <>
      <button
        type="button"
        data-testid="re-arrive"
        onClick={() => navigate({ kind: 'allNotes', filter: null })}
      >
        re-arrive
      </button>
      <button type="button" data-testid="history-back" onClick={back}>
        back
      </button>
    </>
  )
}

let deleteNote: MockInstance<NoteFileService['delete']>
/** The screen's settings writes, through either entry point. */
let settingsUpdates: MockInstance<(patch: Partial<Settings>) => void>
let settingsUpdatesWith: MockInstance<(updater: (current: Settings) => Partial<Settings>) => void>
/** The settings' own `update`, for a change made outside the screen. */
let updateSettingsElsewhere: (patch: Partial<Settings>) => void

interface RenderScreenOptions {
  /**
   * The indexed notes; defaults to the two regular notes and the tagged daily.
   */
  notes?: readonly SeedNote[]
  /** The route's filter; none by default. */
  filter?: AllNotesFilter | null
  /** Over the stored settings: `mdy` dates, `#book` and `#person` pinned, PDF and Video tabs. */
  settings?: Partial<Settings>
  /** The graph's knowledge-level contract file, when it has one. */
  knowledgeLevels?: string
  /** The screen container's width (CSS px); the viewport's by default. */
  width?: number
  queryClient?: QueryClient
}

async function renderScreen(options: RenderScreenOptions = {}) {
  const notes = options.notes ?? [...noteRows, taggedDailyRow]
  const files: Record<string, string> = Object.fromEntries(
    notes.map((note) => [note.path, noteMarkdown(note)]),
  )
  if (options.knowledgeLevels !== undefined) {
    files[KNOWLEDGE_LEVELS_PATH] = options.knowledgeLevels
  }
  const app = createTestCoreServices({
    noteFile: createTestNoteFileService({
      files,
      // A delete pinned to another generation rejects.
      generation: 1,
    }),
  })
  for (const note of notes) {
    const source = noteMarkdown(note)
    app.database.applyProjection({
      ...buildIndexedNote(parseNote({ path: note.path, source }), {
        fileHash: `hash-${note.path}`,
        mtime: note.mtime,
        source,
      }),
      preview: note.preview,
      isPrivate: note.isPrivate ?? false,
      hasConflict: note.hasConflict ?? false,
      isPinned: note.pinnedOrder !== undefined,
      pinnedOrder: note.pinnedOrder ?? null,
      assets: [...(note.assets ?? [])],
    })
  }
  // The facet counts are scripted: the fixture pins `book` although no listed
  // note carries it, so the Custom menu has a pinned facet to mark.
  vi.spyOn(app.noteList, 'listNoteTags').mockResolvedValue(facetRows)
  deleteNote = vi.spyOn(app.noteFile, 'delete')
  updateSettingsElsewhere = app.settings.update
  settingsUpdates = vi.spyOn(app.settings, 'update')
  settingsUpdatesWith = vi.spyOn(app.settings, 'updateWith')
  return await renderInApp(
    <>
      {/* The screen fills its container (`h-full`); hand it the viewport
          height so the scroll container gets a real, bounded size. */}
      <div data-testid="screen-container" style={{ height: '100vh', width: options.width }}>
        <RoutedScreen />
      </div>
      <ReArrive />
    </>,
    {
      app,
      graph: { root: '/g', name: 'g', generation: 1 },
      route: { kind: 'allNotes', filter: options.filter ?? null },
      settings: {
        dateFormat: 'mdy',
        allNotesFilterTags: ['book', 'person'],
        allNotesFilterAttachments: ['pdf', 'video'],
        ...options.settings,
      },
      ...(options.queryClient === undefined ? {} : { queryClient: options.queryClient }),
    },
  )
}

type ScreenView = Awaited<ReturnType<typeof renderScreen>>

function probedRoute(view: ScreenView): unknown {
  return view.appServices.navigation.getState().route
}

function openedNoteWindows(view: ScreenView): readonly string[] {
  return view.appServices.window.openedNoteWindows()
}

function pinnedTags(view: ScreenView): readonly string[] {
  return view.app.settings.get().allNotesFilterTags
}

async function openPinnedFilters(view: ScreenView): Promise<void> {
  await view
    .getByRole('group', { name: 'Filter notes' })
    .getByRole('button', { expanded: false })
    .click()
  await page.getByRole('button', { name: 'Manage pinned filters…' }).click()
  await expect.element(page.getByRole('list', { name: 'Pinned filters' })).toBeInTheDocument()
}

function pinnedTabOrder(view: ScreenView): string[] {
  const pins = pinnedTags(view)
  return [...view.getByRole('group', { name: 'Filter notes' }).element().querySelectorAll('button')]
    .map((button) => button.textContent?.trim() ?? '')
    .filter((label) => pins.some((tag) => label === `#${tag}`))
}

function pinWrites(): unknown[] {
  return [...settingsUpdates.mock.calls, ...settingsUpdatesWith.mock.calls]
}

async function movePinnedTagUpWithKeyboard(view: ScreenView, tag: string): Promise<void> {
  const handle = page.getByRole('button', { name: `Reorder #${tag}` })
  handle.element().focus()
  await userEvent.keyboard('{Space}')
  await expect.element(handle).toHaveAttribute('aria-pressed', 'true')
  await userEvent.keyboard('{ArrowUp}')
  await expect
    .element(
      page.getByText(`#${tag} will move to position 1 of ${pinnedTags(view).length}.`, {
        exact: true,
      }),
    )
    .toBeInTheDocument()
}

describe('AllNotesScreen', () => {
  it('shows indexed Private and conflict flags and keeps keyboard subject navigation', async () => {
    const view = await renderScreen({
      notes: [
        { ...healthRow, isPrivate: true },
        { ...tokyoRow, hasConflict: true },
      ],
    })
    const privateNote = view.getByRole('button', { name: 'Health Stacked Private', exact: true })
    await expect.element(view.getByText('Wiki', { exact: true })).toBeVisible()
    const protectedNote = view.getByRole('button', { name: 'Tokyo Gâteau Protected', exact: true })
    await expect
      .element(privateNote.getByRole('img', { name: 'Private', exact: true }))
      .toBeVisible()
    await expect
      .element(protectedNote.getByRole('img', { name: 'Protected', exact: true }))
      .toBeVisible()
    expect(privateNote.element().querySelector('button')).toBeNull()
    privateNote.element().focus()
    await userEvent.keyboard('{Enter}')
    await expect.poll(() => probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    await view.unmount()
  })

  it.each([
    { privacy: [false, false], label: 'Mark private (2)', makePrivate: true },
    { privacy: [true, false], label: 'Mark private (2)', makePrivate: true },
    { privacy: [true, true], label: 'Unmark private (2)', makePrivate: false },
  ])('offers $label for the selection', async ({ privacy, label, makePrivate }) => {
    const view = await renderScreen({
      notes: noteRows.map((row, index) => ({ ...row, isPrivate: privacy[index] ?? false })),
    })
    const setNotesPrivate = vi
      .spyOn(view.app.noteActions, 'setNotesPrivate')
      .mockResolvedValue({ changed: [], skipped: 0 })
    await expect.element(view.getByText('Tokyo Gâteau')).toBeVisible()
    expect(view.getByRole('button', { name: /private \(/ }).query()).toBeNull()

    await view.getByRole('button', { name: 'Select note', exact: true }).first().click()
    await expect.element(view.getByRole('button', { name: 'Deselect note' })).toBeInTheDocument()
    await view.getByRole('button', { name: 'Select note', exact: true }).click()
    await view.getByRole('button', { name: label }).click()

    expect(setNotesPrivate).toHaveBeenCalledWith(
      expect.arrayContaining(['notes/health.md', 'notes/tokyo.md']),
      makePrivate,
    )
    await view.unmount()
  })

  it('lists non-daily notes with subject, snippet and tags, and updated columns', async () => {
    const view = await renderScreen()

    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByText('Shop your health goals.')).toBeInTheDocument()
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await expectLocatorToHaveCount(view.getByText('#link'), 2)
    await expect.element(view.getByText('1/15/2020')).toBeInTheDocument()
    await expect.element(view.getByText('1/10/2020')).toBeInTheDocument()
    // Tags share the snippet's column instead of reserving one of their own.
    await expect.element(view.getByText('Tags', { exact: true })).not.toBeInTheDocument()
    const snippetCell = view.getByText('Shop your health goals.').element().parentElement
    expect(snippetCell?.textContent).toBe('Shop your health goals.#link')
    await view.unmount()
  })

  it('keeps ISO updated dates on one line', async () => {
    const view = await renderScreen({ settings: { dateFormat: 'iso' } })

    const updated = view.getByText('2020-01-15')
    await expect.element(updated).toHaveClass('whitespace-nowrap')
    expect(updated.element().parentElement?.className ?? '').toContain(
      'grid-cols-[minmax(0,15rem)_3rem_minmax(0,1fr)_6rem]',
    )
    await view.unmount()
  })

  it('renders a dash, not an epoch date, for a row missing its mtime', async () => {
    const view = await renderScreen({
      notes: [{ path: 'notes/legacy.md', title: 'Legacy Note', mtime: 0, preview: '' }],
    })

    await expect.element(view.getByText('Legacy Note')).toBeInTheDocument()
    await expect.element(view.getByText('—')).toBeInTheDocument()
    await view.unmount()
  })

  it('shows a `//` subject by its first segment', async () => {
    const view = await renderScreen({
      notes: [
        { path: 'notes/tim-maccaw-dad.md', title: 'Tim MacCaw // Dad', mtime: 0, preview: '' },
      ],
    })

    await expect.element(view.getByText('Tim MacCaw', { exact: true })).toBeInTheDocument()
    expect(view.getByText('Tim MacCaw // Dad').query()).toBeNull()
    await view.unmount()
  })

  it('opens a note when its row is clicked', async () => {
    const view = await renderScreen()

    await view.getByRole('button', { name: /Health Stacked/ }).click()

    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    await view.unmount()
  })

  it('opens a modifier-clicked note subject in a new window without selecting its row', async () => {
    const view = await renderScreen()

    await view
      .getByRole('button', { name: 'Health Stacked' })
      .click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() =>
      expect(openedNoteWindows(view)).toContain(
        deepLinkForRoute({ kind: 'note', path: 'notes/health.md' }),
      ),
    )
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    expect(view.getByRole('button', { name: /Trash \(/ }).query()).toBeNull()
    await view.unmount()
  })

  it('keeps a modifier-double-click from navigating the current window', async () => {
    const view = await renderScreen()
    const subject = view.getByRole('button', { name: 'Health Stacked' })

    await subject.dblClick({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() =>
      expect(openedNoteWindows(view)).toContain(
        deepLinkForRoute({ kind: 'note', path: 'notes/health.md' }),
      ),
    )
    expect(openedNoteWindows(view)).toHaveLength(1)
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    await view.unmount()
  })

  it('renders pinned tags from settings as tabs and filters through the route', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await expect.element(view.getByRole('button', { name: '#person' })).toBeInTheDocument()
    await view.getByRole('button', { name: '#book' }).click()

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'book' } })
    await expect.element(view.getByText('No notes tagged #book.')).toBeInTheDocument()
    expect(view.getByText('Health Stacked').query()).toBeNull()
    await view.unmount()
  })

  it('renders enabled attachment types as tabs and filters through the route', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await expect.element(view.getByRole('button', { name: 'Video' })).toBeInTheDocument()
    expect(view.getByRole('button', { name: 'Images' }).query()).toBeNull()
    expect(view.getByRole('button', { name: 'Audio' }).query()).toBeNull()
    await view.getByRole('button', { name: 'PDF' }).click()

    expect(probedRoute(view)).toEqual({
      kind: 'allNotes',
      filter: { kind: 'attachment', type: 'pdf' },
    })
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    expect(view.getByText('Health Stacked').query()).toBeNull()
    await expect
      .element(view.getByRole('button', { name: 'PDF' }))
      .toHaveAttribute('aria-pressed', 'true')
    await view.unmount()
  })

  it('says when no notes reference the chosen attachment type', async () => {
    const view = await renderScreen()
    await view.getByRole('button', { name: 'Video' }).click()

    await expect.element(view.getByText('No notes with video.')).toBeInTheDocument()
    await view.unmount()
  })

  it('filters by level after Video, keeps translations compact, and restores the filter on Back', async () => {
    const view = await renderScreen({ knowledgeLevels: JSON.stringify(knowledgeLevelContract) })
    const level = view.getByRole('button', { name: 'Wiki', exact: true })
    await expect.element(level).toBeVisible()
    const video = view.getByRole('button', { name: 'Video', exact: true }).element()
    expect(video.nextElementSibling).toBe(level.element())

    level.element().focus()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(page.getByRole('menuitemradio', { name: 'All levels' })).toHaveFocus()
    await userEvent.keyboard('{End}')
    await expect.element(page.getByRole('menuitemradio', { name: 'L4', exact: true })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await expect
      .element(view.getByRole('button', { name: 'Wiki: L4' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'level', level: 4 } })
    await expect.element(view.getByText('Tokyo Gâteau')).toBeVisible()
    expect(view.getByText('Health Stacked').query()).toBeNull()
    expect(view.container.querySelector('[data-knowledge-level="4"]')?.textContent).toBe('L4')

    await view.getByRole('button', { name: 'Tokyo Gâteau', exact: true }).click()
    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/tokyo.md' })
    await view.getByTestId('history-back').click()
    await expect.element(view.getByRole('button', { name: 'Wiki: L4' })).toBeVisible()
    expect(view.getByText('Health Stacked').query()).toBeNull()

    await view.getByRole('button', { name: 'Wiki: L4' }).click()
    await page.getByRole('menuitemradio', { name: 'L1', exact: true }).click()
    await expect.element(view.getByText('Tue, June 9th, 2026')).toBeVisible()
    expect(view.getByText('Tokyo Gâteau').query()).toBeNull()

    await view.getByRole('button', { name: 'Wiki: L1' }).click()
    await page.getByRole('menuitemradio', { name: 'All levels' }).click()
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    await expect.element(view.getByText('Health Stacked')).toBeVisible()
    await expect.element(view.getByText('Tokyo Gâteau')).toBeVisible()
    expect(view.getByText('Tue, June 9th, 2026').query()).toBeNull()
    await view.unmount()
  })

  it('updates the active level filter when path rules change on focus', async () => {
    const view = await renderScreen({
      filter: { kind: 'level', level: 3 },
      knowledgeLevels: JSON.stringify(knowledgeLevelContract),
    })
    await expect.element(view.getByText('No L3 notes.')).toBeVisible()
    view.app.noteFile.set(
      KNOWLEDGE_LEVELS_PATH,
      JSON.stringify({
        ...knowledgeLevelContract,
        rules: [
          ...knowledgeLevelContract.rules,
          { path: 'notes/health.md', match: 'file', level: 3 },
        ],
      }),
    )
    window.dispatchEvent(new Event('focus'))
    await expect.element(view.getByText('Health Stacked')).toBeVisible()
    expect(view.getByText('Tokyo Gâteau').query()).toBeNull()
    await view.unmount()
  })

  it('explains unavailable levels and lets the reader clear the filter', async () => {
    const view = await renderScreen({
      filter: { kind: 'level', level: 4 },
      knowledgeLevels: '{"version":2}',
    })
    await expect
      .element(view.getByText('Knowledge levels are unavailable. Choose All levels to show notes.'))
      .toBeVisible()
    expect(view.getByText('No L4 notes.').query()).toBeNull()
    expect(view.getByText('Health Stacked').query()).toBeNull()
    await view.getByRole('button', { name: 'Wiki: L4' }).click()
    await page.getByRole('menuitemradio', { name: 'All levels' }).click()
    await expect.element(view.getByText('Health Stacked')).toBeVisible()
    await view.unmount()
  })

  it('lists the notes edited on a day set by the heatmap, and All clears it', async () => {
    const view = await renderScreen({ filter: { kind: 'updated', date: '2020-01-15' } })

    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    expect(view.getByText('Tokyo Gâteau').query()).toBeNull()
    await expect
      .element(view.getByRole('button', { name: 'Edited 1/15/2020' }))
      .toHaveAttribute('aria-pressed', 'true')

    await view.getByRole('button', { name: 'All', exact: true }).click()
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    expect(view.getByRole('button', { name: /^Edited/ }).query()).toBeNull()
    await view.unmount()
  })

  it('says when no notes were edited on the chosen day', async () => {
    const view = await renderScreen({ filter: { kind: 'updated', date: '2020-01-01' } })

    await expect.element(view.getByText('No notes edited on 1/1/2020.')).toBeInTheDocument()
    await view.unmount()
  })

  it('keeps the active type tab when settings switched that type off', async () => {
    const view = await renderScreen({
      filter: { kind: 'attachment', type: 'image' },
      settings: { allNotesFilterAttachments: [] },
    })

    await expect
      .element(view.getByRole('button', { name: 'Images' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(view.getByRole('button', { name: 'PDF' }).query()).toBeNull()
    await view.unmount()
  })

  it('re-anchors to the top when re-arriving on the same route', async () => {
    const view = await renderScreen({ notes: manyNoteRows })
    await expect.element(view.getByText('Note 0', { exact: true })).toBeInTheDocument()

    const scroller = view.getByTestId('all-notes-scroll').element()
    scroller.scrollTop = 400
    expect(scroller.scrollTop).toBe(400)

    // Same-route navigation pushes no entry, but the router clears the saved
    // offset and bumps arrivalSeq — the list must re-anchor, not stay put.
    await view.getByTestId('re-arrive').click()

    await vi.waitFor(() => expect(scroller.scrollTop).toBe(0))
    await view.unmount()
  })

  it('renders rows from a warm cache without a refetch', async () => {
    // The app client uses staleTime: Infinity, so returning to All Notes with
    // fresh cached data commits exactly one render — no fetch, no follow-up.
    // virtua windows against its parent (the scroll container) and measures it a
    // microtask later, so the rows arrive a tick after that lone render. The
    // regression guarded here is a permanently blank list, not the tick.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    const listed = { isPinned: false, pinnedOrder: null, isPrivate: false, hasConflict: false }
    client.setQueryData(queryKeys.index.allNotesWithTag('/g', null), [
      {
        ...listed,
        path: 'notes/health.md',
        title: 'Health Stacked',
        snippet: 'Shop your health goals.',
        tags: ['link'],
        mtime: HEALTH_MTIME,
      },
      {
        ...listed,
        path: 'notes/tokyo.md',
        title: 'Tokyo Gâteau',
        snippet: 'Dandelion chocolate.',
        tags: ['link'],
        mtime: TOKYO_MTIME,
      },
    ])
    client.setQueryData(queryKeys.index.allNotesTags('/g'), facetRows)

    const view = await renderScreen({ notes: [], queryClient: client })

    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await view.unmount()
  })

  it('virtualizes long lists instead of rendering every row', async () => {
    const view = await renderScreen({ notes: manyNoteRows })

    await expect.element(view.getByText('Note 0', { exact: true })).toBeInTheDocument()
    const rendered = view.getByTestId('all-notes-scroll').element().querySelectorAll('li')
    expect(rendered.length).toBeGreaterThan(0)
    // The list is uncapped, but only the scroll window (plus buffer) mounts.
    expect(rendered.length).toBeLessThan(100)
    await view.unmount()
  })

  it('offers pinned and unpinned tags in Custom and shows the chosen filter', async () => {
    const view = await renderScreen()

    await view.getByRole('button', { name: 'Custom' }).click()
    const listbox = page.getByRole('listbox')
    await expect.element(listbox).toMatchTextContent('#travel')
    await expect.element(listbox).toMatchTextContent('2')
    await expect.element(page.getByRole('option', { name: /#book/ })).toMatchTextContent('Pinned')
    await expect.element(page.getByRole('option', { name: /#book/ })).toMatchTextContent('3')
    await expect.element(page.getByRole('option', { name: /#person/ })).toMatchTextContent('Pinned')

    await page.getByRole('option', { name: /#travel/ }).click()

    await expect
      .poll(() => probedRoute(view))
      .toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'travel' } })
    await expect.element(view.getByText('Tue, June 9th, 2026')).toBeInTheDocument()
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()
    expect(view.getByText('Health Stacked').query()).toBeNull()
    // The trigger adopts the active custom tag.
    await expect
      .element(view.getByRole('button', { name: /#travel/, expanded: false }))
      .toBeInTheDocument()
    await view.getByRole('button', { name: 'Tue, June 9th, 2026' }).click()
    await expect.poll(() => probedRoute(view)).toEqual({ kind: 'daily', date: '2026-06-09' })
    await view.unmount()
  })

  it('filters by an arbitrary typed tag from the Custom combobox', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Custom' }).click()
    const input = page.getByPlaceholder('Filter by any tag…')

    // An exact existing tag isn't duplicated as a "Filter by" item.
    await input.fill('travel')
    expect(page.getByRole('option', { name: /Filter by/ }).query()).toBeNull()

    // Leading `#`s are accepted as in the pinned-filter editor, and the tag
    // need not exist in the index.
    await input.fill('## zettel')
    await page.getByRole('option', { name: 'Filter by #zettel' }).click()

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'zettel' } })
    await expect.element(view.getByText('No notes tagged #zettel.')).toBeInTheDocument()
    await view.unmount()
  })

  it('matches facets case-insensitively in the Custom combobox', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Custom' }).click()
    const input = page.getByPlaceholder('Filter by any tag…')
    await input.fill('TRAVEL')

    // cmdk's default filter (command-score) folds case like `foldTag` does,
    // so a differently-cased query keeps the existing facet reachable instead
    // of dead-ending with a hidden list and a suppressed "Filter by" offer.
    await expect.element(page.getByRole('option', { name: /#travel/ })).toBeInTheDocument()
    expect(page.getByRole('option', { name: /Filter by/ }).query()).toBeNull()

    await page.getByRole('option', { name: /#travel/ }).click()
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'travel' } })
    await view.unmount()
  })
})

describe('AllNotesScreen — pinned tag management', () => {
  it('pins the active Custom filter without changing its route or results', async () => {
    const view = await renderScreen({ filter: { kind: 'tag', tag: 'travel' } })
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()

    await view.getByRole('button', { name: /#travel/, expanded: false }).click()
    await page.getByRole('button', { name: 'Pin #travel', exact: true }).click()

    expect(pinnedTags(view)).toEqual(['book', 'person', 'travel'])
    expect(pinnedTabOrder(view)).toEqual(['#book', '#person', '#travel'])
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'travel' } })
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Custom' })).toBeInTheDocument()
    await view.unmount()
  })

  it('searches configured pins even when a pin has no graph facet', async () => {
    const view = await renderScreen()
    await view.getByRole('button', { name: 'Custom' }).click()
    await page.getByPlaceholder('Filter by any tag…').fill('#PERSON')

    await expect.element(page.getByRole('option', { name: /#person/ })).toMatchTextContent('Pinned')
    expect(page.getByRole('option', { name: /Filter by/ }).query()).toBeNull()
    await page.getByRole('option', { name: /#person/ }).click()

    await vi.waitFor(() =>
      expect(probedRoute(view)).toEqual({
        kind: 'allNotes',
        filter: { kind: 'tag', tag: 'person' },
      }),
    )
    await expect.element(view.getByText('No notes tagged #person.')).toBeInTheDocument()
    await view.unmount()
  })

  it('adds a normalized zero-result tag while keeping every ordered row visible', async () => {
    const view = await renderScreen()
    await openPinnedFilters(view)
    const input = page.getByPlaceholder('Find a tag to pin…')
    await input.fill(' #研究/PROJECT ')

    await expect
      .element(page.getByRole('button', { name: 'Actions for #book' }))
      .toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Actions for #person' }))
      .toBeInTheDocument()
    await page.getByRole('button', { name: 'Pin #研究/project', exact: true }).click()

    expect(pinnedTags(view)).toEqual(['book', 'person', '研究/project'])
    expect(pinnedTabOrder(view)).toEqual(['#book', '#person', '#研究/project'])
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    await expect.element(input).toHaveValue('')

    await input.fill('#BOOK')
    const duplicatePin = page.getByRole('button', { name: 'Pin #book', exact: true })
    if (duplicatePin.query() !== null) {
      await expect.element(duplicatePin).toBeDisabled()
    }
    await input.fill('not a tag')
    const invalidPin = page.getByRole('button', { name: /^Pin #/ })
    if (invalidPin.query() !== null) {
      await expect.element(invalidPin).toBeDisabled()
    }
    expect(pinWrites()).toHaveLength(1)
    await view.unmount()
  })

  it('keeps an unpinned active filter and supports removing every shortcut', async () => {
    const view = await renderScreen({
      filter: { kind: 'tag', tag: 'travel' },
      settings: { allNotesFilterTags: ['book', 'person', 'travel'] },
    })
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()
    await openPinnedFilters(view)

    await page.getByRole('button', { name: 'Actions for #travel' }).click()
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    await expect.element(page.getByRole('button', { name: 'Actions for #person' })).toHaveFocus()
    expect(pinnedTags(view)).toEqual(['book', 'person'])
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'travel' } })
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()

    for (const tag of ['book', 'person']) {
      await page.getByRole('button', { name: `Actions for #${tag}` }).click()
      await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    }
    expect(pinnedTags(view)).toEqual([])
    await expect.element(page.getByPlaceholder('Find a tag to pin…')).toHaveFocus()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    expect(pinnedTabOrder(view)).toEqual([])
    await expect
      .element(view.getByRole('button', { name: /#travel/, expanded: false }))
      .toHaveFocus()
    await expect.element(view.getByRole('button', { name: 'All', exact: true })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'PDF', exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()
    await view.app.settings.flush()
    const saved = view.app.settings.saves().at(-1)
    expect(saved?.allNotesFilterTags).toEqual([])
    await view.unmount()

    // The emptied list persists: reopening over the saved document shows no
    // shortcuts rather than falling back to the defaults.
    const reopened = await renderScreen({ settings: { ...saved } })
    expect(pinnedTabOrder(reopened)).toEqual([])
    await reopened.unmount()
  })

  it('moves a tag through its menu, disables boundaries, and returns focus to that tag', async () => {
    const view = await renderScreen({
      filter: { kind: 'tag', tag: 'travel' },
      settings: { allNotesFilterTags: ['book', 'person', 'travel'] },
    })
    await openPinnedFilters(view)
    await page.getByRole('button', { name: 'Actions for #book' }).click()
    await expect
      .element(page.getByRole('menuitem', { name: 'Move to top', exact: true }))
      .toHaveAttribute('aria-disabled', 'true')
    await expect
      .element(page.getByRole('menuitem', { name: 'Move up', exact: true }))
      .toHaveAttribute('aria-disabled', 'true')
    await page.getByRole('menuitem', { name: 'Move to bottom', exact: true }).click()

    expect(pinnedTags(view)).toEqual(['person', 'travel', 'book'])
    expect(pinnedTabOrder(view)).toEqual(['#person', '#travel', '#book'])
    await expect.element(page.getByRole('button', { name: 'Actions for #book' })).toHaveFocus()
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'travel' } })
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()

    await page.getByRole('button', { name: 'Actions for #book' }).click()
    await expect
      .element(page.getByRole('menuitem', { name: 'Move down', exact: true }))
      .toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('list', { name: 'Pinned filters' })).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Actions for #book' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('list', { name: 'Pinned filters' })).not.toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Custom' })).toHaveFocus()
    await view.unmount()
  })

  it('closes management with Escape when the focused action hint is visible', async () => {
    const view = await renderScreen()
    try {
      await openPinnedFilters(view)
      const actions = page.getByRole('button', { name: 'Actions for #book' })
      await actions.click()
      const menuItem = page.getByRole('menuitem', { name: 'Move to bottom', exact: true })
      await expect.element(menuItem).toBeVisible()
      const menu = menuItem.element().closest('[data-slot="dropdown-menu-content"]')
      expect(menu).toBeInTheDocument()
      await userEvent.keyboard('{Escape}')
      await expect.element(actions).toHaveFocus()
      await vi.waitFor(() => expect(menu?.isConnected).toBe(false))
      await hover(page.getByRole('button', { name: 'Done', exact: true }))
      await hover(actions)
      await expect
        .element(page.getByText('Move or unpin this filter', { exact: true }))
        .toBeVisible()

      await userEvent.keyboard('{Escape}')
      await expect
        .element(page.getByRole('list', { name: 'Pinned filters' }))
        .not.toBeInTheDocument()
      await expect.element(view.getByRole('button', { name: 'Custom' })).toHaveFocus()
    } finally {
      await view.unmount()
    }
  })

  it('reorders from the drag handle with the pointer and saves only on drop', async () => {
    const view = await renderScreen()
    await openPinnedFilters(view)
    const origin = await hover(page.getByRole('button', { name: 'Reorder #person' }))
    const target = page
      .getByRole('button', { name: 'Reorder #book' })
      .element()
      .getBoundingClientRect()
    await mouse.down()
    try {
      await mouse.move(origin.x + 10, origin.y, { steps: 3 })
      await expect
        .element(page.getByRole('button', { name: 'Reorder #person' }))
        .toHaveAttribute('aria-pressed', 'true')
      await mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 })
      await expect
        .element(page.getByText('#person will move to position 1 of 2.', { exact: true }))
        .toBeInTheDocument()
      expect(pinnedTags(view)).toEqual(['book', 'person'])
      expect(pinWrites()).toHaveLength(0)
    } finally {
      await mouse.up()
    }

    await vi.waitFor(() => expect(pinnedTags(view)).toEqual(['person', 'book']))
    expect(pinWrites()).toHaveLength(1)
    expect(pinnedTabOrder(view)).toEqual(['#person', '#book'])
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    await expect
      .element(page.getByRole('button', { name: 'Reorder #person' }))
      .not.toHaveAttribute('aria-pressed', 'true')
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('list', { name: 'Pinned filters' })).not.toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Custom' })).toHaveFocus()
    await view.unmount()
  })

  it('saves a keyboard reorder once on drop and retains the active filter', async () => {
    const view = await renderScreen({ filter: { kind: 'tag', tag: 'book' } })
    await openPinnedFilters(view)
    const handle = page.getByRole('button', { name: 'Reorder #person' })
    await movePinnedTagUpWithKeyboard(view, 'person')

    expect(pinnedTags(view)).toEqual(['book', 'person'])
    expect(pinWrites()).toHaveLength(0)
    await userEvent.keyboard('{Enter}')

    await vi.waitFor(() => expect(pinnedTags(view)).toEqual(['person', 'book']))
    expect(pinWrites()).toHaveLength(1)
    expect(pinnedTabOrder(view)).toEqual(['#person', '#book'])
    await expect.element(handle).not.toHaveAttribute('aria-pressed', 'true')
    await expect.element(handle).toHaveFocus()
    await expect.element(page.getByRole('list', { name: 'Pinned filters' })).toBeInTheDocument()
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'book' } })
    await view.unmount()
  })

  it('cancels a keyboard reorder with Escape while leaving management open', async () => {
    const view = await renderScreen()
    await openPinnedFilters(view)
    const handle = page.getByRole('button', { name: 'Reorder #person' })
    await movePinnedTagUpWithKeyboard(view, 'person')
    await userEvent.keyboard('{Escape}')
    await expect.element(handle).not.toHaveAttribute('aria-pressed', 'true')

    expect(pinnedTags(view)).toEqual(['book', 'person'])
    expect(pinWrites()).toHaveLength(0)
    expect(pinnedTabOrder(view)).toEqual(['#book', '#person'])
    await expect.element(page.getByRole('list', { name: 'Pinned filters' })).toBeInTheDocument()
    await expect.element(handle).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(page.getByRole('list', { name: 'Pinned filters' })).not.toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'Custom' })).toHaveFocus()
    await view.unmount()
  })

  it.each(['Done', 'outside click'])(
    'discards a drag when management closes through %s',
    async (exit) => {
      const view = await renderScreen()
      await openPinnedFilters(view)
      await movePinnedTagUpWithKeyboard(view, 'person')

      if (exit === 'Done') {
        await page.getByRole('button', { name: 'Done', exact: true }).click()
      } else {
        await view.getByRole('heading', { name: 'Notes', exact: true }).click()
      }
      await expect
        .element(page.getByRole('list', { name: 'Pinned filters' }))
        .not.toBeInTheDocument()
      expect(pinnedTags(view)).toEqual(['book', 'person'])
      expect(pinWrites()).toHaveLength(0)
      await openPinnedFilters(view)
      await expect
        .element(page.getByRole('button', { name: 'Actions for #book' }))
        .toBeInTheDocument()
      expect(pinnedTabOrder(view)).toEqual(['#book', '#person'])
      await movePinnedTagUpWithKeyboard(view, 'person')
      await userEvent.keyboard('{Enter}')
      await vi.waitFor(() => expect(pinnedTags(view)).toEqual(['person', 'book']))
      expect(pinWrites()).toHaveLength(1)
      await view.unmount()
    },
  )

  it('cancels an unactivated pointer gesture before navigation removes the editor', async () => {
    for (const dismissal of ['unmount', 'Escape']) {
      const view = await renderScreen()
      await openPinnedFilters(view)
      const handle = page.getByRole('button', { name: 'Reorder #person' })
      const origin = await hover(handle)
      await mouse.down()
      await expect.element(handle).not.toHaveAttribute('aria-pressed', 'true')
      if (dismissal === 'Escape') {
        await userEvent.keyboard('{Escape}')
        await expect
          .element(page.getByRole('list', { name: 'Pinned filters' }))
          .not.toBeInTheDocument()
      }
      await view.unmount()
      const clicked = vi.fn()
      const receiver = await render(
        <button type="button" onClick={clicked}>
          Continue after navigation
        </button>,
      )
      try {
        const button = receiver.getByRole('button', { name: 'Continue after navigation' })
        button.element().focus()
        await expect.element(button).toHaveFocus()
        await userEvent.keyboard('{Enter}')
        expect(
          clicked,
          `${dismissal} permits a click before later pointer movement`,
        ).toHaveBeenCalledOnce()
        await mouse.move(origin.x + 12, origin.y, { steps: 3 })
        button.element().focus()
        await expect.element(button).toHaveFocus()
        await userEvent.keyboard('{Enter}')
        expect(
          clicked,
          `${dismissal} leaves subsequent native keyboard clicks working`,
        ).toHaveBeenCalledTimes(2)
        expect(pinWrites()).toHaveLength(0)
      } finally {
        await mouse.up()
        await receiver.unmount()
      }
    }
  })

  it('cancels a draft after an external pin update and keeps the external order', async () => {
    const view = await renderScreen()
    await openPinnedFilters(view)
    await movePinnedTagUpWithKeyboard(view, 'person')
    act(() => {
      updateSettingsElsewhere({ allNotesFilterTags: ['book', 'person', 'external'] })
    })
    await expect
      .element(page.getByRole('button', { name: 'Actions for #external' }))
      .toBeInTheDocument()
    page.getByPlaceholder('Find a tag to pin…').element().focus()
    await userEvent.keyboard('{ArrowUp}{Enter}')

    expect(pinnedTags(view)).toEqual(['book', 'person', 'external'])
    expect(pinnedTabOrder(view)).toEqual(['#book', '#person', '#external'])
    expect(pinWrites()).toHaveLength(0)
    await expect.element(page.getByRole('list', { name: 'Pinned filters' })).toBeInTheDocument()
    await movePinnedTagUpWithKeyboard(view, 'person')
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(pinnedTags(view)).toEqual(['person', 'book', 'external']))
    expect(pinWrites()).toHaveLength(1)
    await view.unmount()
  })

  it('keeps All and Custom reachable in a narrow header with long tags and the edit-day filter', async () => {
    const longTags = Array.from({ length: 12 }, (_, index) => `非常长的项目标签/project-${index}`)
    const view = await renderScreen({
      filter: { kind: 'updated', date: '2020-01-15' },
      settings: { allNotesFilterTags: longTags },
      width: 320,
    })
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    const group = view.getByRole('group', { name: 'Filter notes' })
    const all = group
      .getByRole('button', { name: 'All', exact: true })
      .element()
      .getBoundingClientRect()
    const custom = group.getByRole('button', { name: 'Custom' }).element().getBoundingClientRect()
    const container = view.getByTestId('screen-container').element().getBoundingClientRect()

    expect(all.left).toBeGreaterThanOrEqual(container.left)
    expect(all.right).toBeLessThan(custom.left)
    expect(custom.right).toBeLessThanOrEqual(container.right)
    await expect.element(group.getByRole('button', { name: /^Edited / })).toBeInTheDocument()
    await expect
      .element(group.getByRole('button', { name: `#${longTags[11]}`, exact: true }))
      .toBeInTheDocument()
    await expect
      .element(group.getByRole('button', { name: 'PDF', exact: true }))
      .toBeInTheDocument()
    const strip = [...group.element().querySelectorAll('div')].find((element) =>
      ['auto', 'scroll'].includes(getComputedStyle(element).overflowX),
    )
    expect(strip).toBeDefined()
    expect(strip?.clientWidth).toBeGreaterThan(0)
    expect(strip?.scrollWidth).toBeGreaterThan(strip?.clientWidth ?? 0)
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeVisible()
    expect(strip?.clientWidth).toBeGreaterThan(0)
    const selectedCustom = group
      .getByRole('button', { name: 'Custom' })
      .element()
      .getBoundingClientRect()
    const newNote = view
      .getByRole('button', { name: 'New note', exact: true })
      .element()
      .getBoundingClientRect()
    expect(selectedCustom.right).toBeLessThanOrEqual(newNote.left)
    await group.getByRole('button', { name: 'Custom' }).click()
    await page.getByRole('option', { name: /#travel/ }).click()
    await vi.waitFor(() =>
      expect(probedRoute(view)).toEqual({
        kind: 'allNotes',
        filter: { kind: 'tag', tag: 'travel' },
      }),
    )
    await view.unmount()
  })
})

describe('AllNotesScreen — selection and bulk trash', () => {
  it('selects a row on click and reveals the bulk Trash action', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    // Clicking the row body (the snippet, not a button) selects without opening.
    await view.getByText('Shop your health goals.').click()
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    const trashButton = view.getByRole('button', { name: /Trash \(1\)/ })
    await expect.element(trashButton).toBeInTheDocument()
    expect(
      trashButton
        .element()
        .closest('header')
        ?.contains(view.getByRole('group', { name: 'Filter notes' }).element()),
    ).toBe(true)

    // ⌘-click a second row extends the selection.
    await view.getByText('Dandelion chocolate.').click({ modifiers: ['ControlOrMeta'] })
    await expect.element(view.getByRole('button', { name: /Trash \(2\)/ })).toBeInTheDocument()
    expect(openedNoteWindows(view)).toEqual([])
    await view.unmount()
  })

  it('range-selects rows with Shift-click', async () => {
    const rows = [
      { path: 'notes/a.md', title: 'Note A', mtime: 3, preview: 'alpha' },
      { path: 'notes/b.md', title: 'Note B', mtime: 2, preview: 'bravo' },
      { path: 'notes/c.md', title: 'Note C', mtime: 1, preview: 'charlie' },
    ]
    const view = await renderScreen({ notes: rows })
    await expect.element(view.getByText('Note A')).toBeInTheDocument()

    // Click the first row's body (the snippet), then Shift-click the third →
    // the whole range is selected (the row passes the modifier through).
    await view.getByText('alpha').click()
    await view.getByText('charlie').click({ modifiers: ['Shift'] })

    await expect.element(view.getByRole('button', { name: /Trash \(3\)/ })).toBeInTheDocument()
    await view.unmount()
  })

  it('opens a note on double-click', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').dblClick()
    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    await view.unmount()
  })

  it('sorts by subject from the header, flipping direction on a second click', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    const order = (): number =>
      Math.sign(
        (view.container.textContent ?? '').indexOf('Tokyo Gâteau') -
          (view.container.textContent ?? '').indexOf('Health Stacked'),
      )
    expect(order()).toBe(1) // newest first: Health (Jan 15) above Tokyo (Jan 10)

    await view.getByRole('button', { name: 'Sort by subject' }).click()
    expect(view.app.settings.get().allNotesSort).toEqual({ key: 'title', direction: 'asc' })
    await expect
      .element(view.getByRole('button', { name: 'Subject, sorted A to Z' }))
      .toBeInTheDocument()
    expect(order()).toBe(1)

    await view.getByRole('button', { name: 'Subject, sorted A to Z' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Subject, sorted Z to A' }))
      .toBeInTheDocument()
    expect(order()).toBe(-1)

    await view.getByRole('button', { name: 'Sort by updated' }).click()
    expect(view.app.settings.get().allNotesSort).toEqual({ key: 'updated', direction: 'desc' })
    await view.getByRole('button', { name: 'Updated, sorted newest first' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Updated, sorted oldest first' }))
      .toBeInTheDocument()
    expect(order()).toBe(-1)
    await view.unmount()
  })

  it('marks pinned notes, which lead the list whatever their age', async () => {
    const view = await renderScreen({ notes: [healthRow, { ...tokyoRow, pinnedOrder: 1024 }] })
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()

    const text = view.container.textContent ?? ''
    // Tokyo is older, yet its pin puts it first.
    expect(text.indexOf('Tokyo Gâteau')).toBeLessThan(text.indexOf('Health Stacked'))
    await expectLocatorToHaveCount(view.getByRole('img', { name: 'Pinned' }), 1)
    // The marker sits beside the subject it marks.
    const subjectCell = view.getByRole('img', { name: 'Pinned' }).element().parentElement
    expect(subjectCell?.textContent).toContain('Tokyo Gâteau')
    // The subject keeps its plain name.
    await expect.element(view.getByRole('button', { name: 'Tokyo Gâteau' })).toBeInTheDocument()
    await view.unmount()
  })

  it('moves the keyboard selection through the sorted order', async () => {
    const view = await renderScreen({
      settings: { allNotesSort: { key: 'updated', direction: 'asc' } },
    })
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()

    await userEvent.keyboard('{ArrowDown}') // the first row in the oldest-first order
    await userEvent.keyboard('{Enter}')

    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/tokyo.md' })
    await view.unmount()
  })

  it('lets Return on a focused header sort without opening the selection', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()

    view.getByRole('button', { name: 'Sort by subject' }).element().focus()
    await userEvent.keyboard('{Enter}')

    expect(view.app.settings.get().allNotesSort).toEqual({ key: 'title', direction: 'asc' })
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    await view.unmount()
  })

  it('drives selection from the keyboard and opens with Return', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await userEvent.keyboard('{ArrowDown}') // selects the first row
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()

    await userEvent.keyboard('{Enter}')
    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'notes/health.md' })
    expect(openedNoteWindows(view)).toEqual([])
    await view.unmount()
  })

  it('opens the selected note in a new window with Mod+Return', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await userEvent.keyboard('{ArrowDown}')
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()

    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')

    await vi.waitFor(() =>
      expect(openedNoteWindows(view)).toContain(
        deepLinkForRoute({ kind: 'note', path: 'notes/health.md' }),
      ),
    )
    expect(openedNoteWindows(view)).toHaveLength(1)
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    await view.unmount()
  })

  it('clears the selection on Escape', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    expect(view.getByRole('button', { name: /Trash \(/ }).query()).toBeNull()
    await view.unmount()
  })

  it('bulk-trashes the selection to the OS trash and drops the rows', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByText('Dandelion chocolate.').click({ modifiers: ['ControlOrMeta'] })
    await view.getByRole('button', { name: /Trash \(2\)/ }).click()

    // Confirm, then the two notes go to the trash via `note_delete`.
    await expect.element(page.getByText('Trash 2 notes?')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Trash', exact: true }).click()

    await vi.waitFor(() => {
      expect(deleteNote).toHaveBeenCalledWith('notes/health.md', 1)
      expect(deleteNote).toHaveBeenCalledWith('notes/tokyo.md', 1)
    })
    expect(view.app.noteFile.trashed()).toEqual(['notes/health.md', 'notes/tokyo.md'])
    // Optimistic removal: the rows leave at once — the test harness has no file
    // watcher to drive the reindex that would otherwise refresh the list.
    await expectLocatorToHaveCount(view.getByText('Health Stacked'), 0)
    expect(view.getByText('Tokyo Gâteau').query()).toBeNull()
    await view.unmount()
  })

  it('opens the confirm dialog from the ⌘⌫ shortcut', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await userEvent.keyboard('{ControlOrMeta>}{Backspace}{/ControlOrMeta}')

    await expect.element(page.getByText('Trash 1 note?')).toBeInTheDocument()
    await view.unmount()
  })

  it('does not offer bulk trash for a tagged daily note', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByRole('button', { name: /Custom/ }).click()
    await page.getByRole('option', { name: /#travel/ }).click()
    await expect.element(view.getByText('Tue, June 9th, 2026')).toBeInTheDocument()

    await view.getByText('Daily travel notes.').click()
    expect(view.getByRole('button', { name: /Trash \(/ }).query()).toBeNull()

    await userEvent.keyboard('{ControlOrMeta>}{Backspace}{/ControlOrMeta}')
    expect(page.getByText('Trash 1 note?').query()).toBeNull()
    expect(deleteNote).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('does not open a note when Return activates a focused header button', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    // Select a note, then send Return to the New note button: a focused control
    // owns Return, so the document-level shortcut must back off and not open.
    await view.getByText('Shop your health goals.').click()
    view
      .getByRole('button', { name: /New note/ })
      .element()
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: null })
    await view.unmount()
  })

  it('closes the confirm and reports the failure via the operations toast', async () => {
    const view = await renderScreen()
    deleteNote.mockRejectedValue(new Error('disk on fire'))
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByRole('button', { name: /Trash \(1\)/ }).click()
    await expect.element(page.getByText('Trash 1 note?')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Trash', exact: true }).click()

    // The confirm closes either way; the reason lands in the operations toast.
    await expectLocatorToHaveCount(page.getByText('Trash 1 note?'), 0)
    await vi.waitFor(() =>
      expect(
        view.app.progress
          .getAll()
          .map((operation) => `${operation.status}:${operation.message ?? ''}`),
      ).toContain('failed:disk on fire'),
    )
    // The note that failed to trash is left in the list and stays selected, so
    // the bulk action is still available for an immediate retry (no re-select).
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()
    await view.unmount()
  })

  it('keeps trashed rows gone on a partial failure (no index resurrection)', async () => {
    // health trashes; tokyo fails. The index still lists health until the
    // watcher reindexes, so a refetch here would wrongly bring it back.
    const view = await renderScreen()
    deleteNote.mockImplementation(async (path) => {
      if (path === 'notes/tokyo.md') {
        throw new Error('locked')
      }
      return { trashed: 'system' }
    })
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByText('Dandelion chocolate.').click({ modifiers: ['ControlOrMeta'] })
    await view.getByRole('button', { name: /Trash \(2\)/ }).click()
    await expect.element(page.getByText('Trash 2 notes?')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Trash', exact: true }).click()

    // The successfully-trashed note stays gone; the failed one stays selected.
    await expectLocatorToHaveCount(view.getByText('Health Stacked'), 0)
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()
    await view.unmount()
  })

  it('ignores a second confirm click while a trash is in flight', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByRole('button', { name: /Trash \(1\)/ }).click()
    await expect.element(page.getByText('Trash 1 note?')).toBeInTheDocument()

    const confirm = page
      .getByRole('button', { name: 'Trash', exact: true })
      .element() as HTMLElement
    confirm.click()
    confirm.click() // a rapid second click must not double-delete

    await expectLocatorToHaveCount(page.getByText('Trash 1 note?'), 0)
    const healthDeletes = deleteNote.mock.calls.filter(([path]) => path === 'notes/health.md')
    expect(healthDeletes).toHaveLength(1)
    await view.unmount()
  })
})
