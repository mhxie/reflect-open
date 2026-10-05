import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { mouse } from 'vitest-browser-commands/playwright'
import { render } from 'vitest-browser-react'
import { act, type ReactElement } from 'react'
import { DEFAULT_SETTINGS, setBridge, type Settings } from '@reflect/core'
import { resetOperations, useOperations } from '@/lib/operations.ts'
import { queryKeys } from '@/lib/query-client.ts'
import type { AllNotesFilter } from '@/routing/route.ts'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { hover } from '@/test-utils/mouse.ts'
import { AllNotesScreen } from './all-notes-screen.tsx'

/**
 * The All Notes screen over the real query layer and a fake IPC bridge: rows
 * from compiled SQL, tag tabs from settings, the Custom menu from the facet
 * query, and navigation through the real router.
 */

const settingsState = vi.hoisted(
  (): {
    dateFormat: 'mdy' | 'dmy' | 'iso'
    allNotesFilterAttachments: ('pdf' | 'image' | 'audio' | 'video')[]
  } => ({
    dateFormat: 'mdy',
    allNotesFilterAttachments: ['pdf', 'video'],
  }),
)
const openRouteInNewWindow = vi.hoisted(() => vi.fn<() => Promise<boolean>>())

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
/** Settings writes re-render the real filter and sort controls. */
const settingsStore = vi.hoisted(() => {
  let settings: Settings
  let writes: Partial<Settings>[] = []
  const listeners = new Set<() => void>()
  return {
    get: (): Settings => settings,
    set: (next: Settings): void => {
      settings = next
      for (const listener of listeners) {
        listener()
      }
    },
    update: (patch: Partial<Settings>): void => {
      writes.push(patch)
      settings = { ...settings, ...patch }
      for (const listener of listeners) {
        listener()
      }
    },
    writes: (): Partial<Settings>[] => writes,
    reset: (initial: Settings): void => {
      settings = initial
      writes = []
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})
vi.mock('@/providers/settings-provider.tsx', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useSettings: () => {
      const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.get)
      return {
        settings: {
          ...settings,
          dateFormat: settingsState.dateFormat,
          allNotesFilterAttachments: settingsState.allNotesFilterAttachments,
        },
        updateSettings: settingsStore.update,
        updateSettingsWith: (updater: (current: Settings) => Partial<Settings>) =>
          settingsStore.update(updater(settingsStore.get())),
      }
    },
  }
})
vi.mock('@/lib/windows/open-in-new-window.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window.ts')>()),
  openRouteInNewWindow,
}))

// Deterministic regardless of the test run's clock: both timestamps are far in
// the past, so the Updated column always renders the short-date form.
const HEALTH_MTIME = new Date(2020, 0, 15, 12, 0).getTime()
const TOKYO_MTIME = new Date(2020, 0, 10, 12, 0).getTime()

const noteRows = [
  {
    path: 'notes/health.md',
    title: 'Health Stacked',
    mtime: HEALTH_MTIME,
    preview: 'Shop your health goals.',
  },
  {
    path: 'notes/tokyo.md',
    title: 'Tokyo Gâteau',
    mtime: TOKYO_MTIME,
    preview: 'Dandelion chocolate.',
  },
]
const taggedDailyRow = {
  path: 'daily/2026-06-09.md',
  title: 'June 9, 2026',
  mtime: TOKYO_MTIME,
  preview: 'Daily travel notes.',
}
const tagRows = [
  { note_path: 'notes/health.md', tag: 'link' },
  { note_path: 'notes/tokyo.md', tag: 'link' },
  { note_path: 'daily/2026-06-09.md', tag: 'travel' },
]
const facetRows = [
  { tag: 'book', count: 3 },
  { tag: 'travel', count: 2 },
]

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()

setBridge({ invoke: mockInvoke, listen: async () => () => {} })

const manyNoteRows = Array.from({ length: 1000 }, (_, index) => ({
  path: `notes/n${index}.md`,
  title: `Note ${index}`,
  mtime: 1_000_000 - index,
  preview: '',
}))

function mockManyNotes(): void {
  mockInvoke.mockImplementation(async (command, args) => {
    if (command !== 'db_query') {
      return null
    }
    const sql = String(args['sql'])
    if (sql.includes('"preview"')) {
      return manyNoteRows
    }
    return []
  })
}

beforeEach(() => {
  resetOperations()
  settingsState.dateFormat = 'mdy'
  settingsState.allNotesFilterAttachments = ['pdf', 'video']
  settingsStore.reset({ ...DEFAULT_SETTINGS, allNotesFilterTags: ['book', 'person'] })
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_delete') {
      return { trashed: 'system' }
    }
    if (command !== 'db_query') {
      return null
    }
    const sql = String(args['sql'])
    const params = args['params'] as unknown[]
    if (sql.includes('group by')) {
      return facetRows
    }
    if (sql.includes('"preview"')) {
      // A tag-filtered list starts from the folded tag key — only `travel`
      // has matches in this fixture.
      if (sql.includes('from "tags"')) {
        return params.includes('travel') ? [taggedDailyRow] : []
      }
      // An edit-day list: only Health was last edited on 2020-01-15.
      if (sql.includes('"notes"."mtime" >=')) {
        const start = params.find((value) => typeof value === 'number')
        return start === new Date(2020, 0, 15).getTime() ? [noteRows[0]] : []
      }
      // An attachment-filtered list: only Tokyo references a PDF.
      if (sql.includes('from "assets"')) {
        return params.includes('%.pdf') ? [noteRows[1]] : []
      }
      return noteRows
    }
    if (sql.includes('from "tags"')) {
      // The per-note tags fetch (a join, not an IN list); rows for unlisted
      // paths are ignored by the grouping, so always answer in full.
      return tagRows
    }
    return []
  })
})

function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

/** Surfaces the operations store so tests can assert a failure was reported. */
function OperationsProbe(): ReactElement {
  const operations = useOperations()
  return (
    <output data-testid="operations">
      {operations.map((operation) => `${operation.status}:${operation.message ?? ''}`).join('|')}
    </output>
  )
}

function RoutedScreen(): ReactElement {
  const { route } = useRouter()
  return <AllNotesScreen filter={route.kind === 'allNotes' ? route.filter : null} />
}

/** Navigates to the already-active route — the sidebar-click-while-here case. */
function ReArrive(): ReactElement {
  const { navigate } = useRouter()
  return (
    <button
      type="button"
      data-testid="re-arrive"
      onClick={() => navigate({ kind: 'allNotes', filter: null })}
    >
      re-arrive
    </button>
  )
}

function renderScreen(
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  filter: AllNotesFilter | null = null,
  width?: number,
) {
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'allNotes', filter }}>
        {/* The screen fills its container (`h-full`); hand it the viewport
            height so the scroll container gets a real, bounded size. */}
        <div data-testid="screen-container" style={{ height: '100vh', width }}>
          <RoutedScreen />
        </div>
        <RouteProbe />
        <OperationsProbe />
        <ReArrive />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function probedRoute(view: Awaited<ReturnType<typeof renderScreen>>): unknown {
  return JSON.parse(view.getByTestId('route').element().textContent ?? 'null')
}

async function openPinnedFilters(view: Awaited<ReturnType<typeof renderScreen>>): Promise<void> {
  await view
    .getByRole('group', { name: 'Filter notes' })
    .getByRole('button', { expanded: false })
    .click()
  await page.getByRole('button', { name: 'Manage pinned filters…' }).click()
  await expect.element(page.getByRole('list', { name: 'Pinned filters' })).toBeInTheDocument()
}

function pinnedTabOrder(view: Awaited<ReturnType<typeof renderScreen>>): string[] {
  const pins = settingsStore.get().allNotesFilterTags
  return [...view.getByRole('group', { name: 'Filter notes' }).element().querySelectorAll('button')]
    .map((button) => button.textContent?.trim() ?? '')
    .filter((label) => pins.some((tag) => label === `#${tag}`))
}

function pinWrites(): Partial<Settings>[] {
  return settingsStore.writes()
}

async function movePinnedTagUpWithKeyboard(tag: string): Promise<void> {
  const handle = page.getByRole('button', { name: `Reorder #${tag}` })
  handle.element().focus()
  await userEvent.keyboard('{Space}')
  await expect.element(handle).toHaveAttribute('aria-pressed', 'true')
  await userEvent.keyboard('{ArrowUp}')
  await expect
    .element(
      page.getByText(
        `#${tag} will move to position 1 of ${settingsStore.get().allNotesFilterTags.length}.`,
        { exact: true },
      ),
    )
    .toBeInTheDocument()
}

describe('AllNotesScreen', () => {
  it('lists non-daily notes with subject, snippet, tags, and updated columns', async () => {
    const view = await renderScreen()

    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByText('Shop your health goals.')).toBeInTheDocument()
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await expectLocatorToHaveCount(view.getByText('#link'), 2)
    await expect.element(view.getByText('1/15/2020')).toBeInTheDocument()
    await expect.element(view.getByText('1/10/2020')).toBeInTheDocument()
    await view.unmount()
  })

  it('keeps ISO updated dates on one line', async () => {
    settingsState.dateFormat = 'iso'
    const view = await renderScreen()

    const updated = view.getByText('2020-01-15')
    await expect.element(updated).toHaveClass('whitespace-nowrap')
    expect(updated.element().parentElement?.className ?? '').toContain(
      'grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,8rem)_6rem]',
    )
    await view.unmount()
  })

  it('renders a dash, not an epoch date, for a row missing its mtime', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return [{ path: 'notes/legacy.md', title: 'Legacy Note', mtime: 0, preview: '' }]
      }
      return []
    })
    const view = await renderScreen()

    await expect.element(view.getByText('Legacy Note')).toBeInTheDocument()
    await expect.element(view.getByText('—')).toBeInTheDocument()
    await view.unmount()
  })

  it('shows a `//` subject by its first segment', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return [
          { path: 'notes/tim-maccaw-dad.md', title: 'Tim MacCaw // Dad', mtime: 0, preview: '' },
        ]
      }
      return []
    })
    const view = await renderScreen()

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
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/health.md',
      }),
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
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/health.md',
      }),
    )
    expect(openRouteInNewWindow).toHaveBeenCalledTimes(1)
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

  it('lists the notes edited on a day set by the heatmap, and All clears it', async () => {
    const view = await renderScreen(undefined, { kind: 'updated', date: '2020-01-15' })

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
    const view = await renderScreen(undefined, { kind: 'updated', date: '2020-01-01' })

    await expect.element(view.getByText('No notes edited on 1/1/2020.')).toBeInTheDocument()
    await view.unmount()
  })

  it('keeps the active type tab when settings switched that type off', async () => {
    settingsState.allNotesFilterAttachments = []
    const view = await renderScreen(undefined, { kind: 'attachment', type: 'image' })

    await expect
      .element(view.getByRole('button', { name: 'Images' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(view.getByRole('button', { name: 'PDF' }).query()).toBeNull()
    await view.unmount()
  })

  it('re-anchors to the top when re-arriving on the same route', async () => {
    mockManyNotes()
    const view = await renderScreen()
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
    client.setQueryData(queryKeys.index.allNotesWithTag('/g', null), [
      {
        path: 'notes/health.md',
        title: 'Health Stacked',
        snippet: 'Shop your health goals.',
        tags: ['link'],
        mtime: HEALTH_MTIME,
      },
      {
        path: 'notes/tokyo.md',
        title: 'Tokyo Gâteau',
        snippet: 'Dandelion chocolate.',
        tags: ['link'],
        mtime: TOKYO_MTIME,
      },
    ])
    client.setQueryData(queryKeys.index.allNotesTags('/g'), facetRows)

    const view = await renderScreen(client)

    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByText('Tokyo Gâteau')).toBeInTheDocument()
    await view.unmount()
  })

  it('virtualizes long lists instead of rendering every row', async () => {
    mockManyNotes()

    const view = await renderScreen()

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

    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'travel' } })
    await expect.element(view.getByText('June 9, 2026')).toBeInTheDocument()
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()
    expect(view.getByText('Health Stacked').query()).toBeNull()
    // The trigger adopts the active custom tag.
    await expect
      .element(view.getByRole('button', { name: /#travel/, expanded: false }))
      .toBeInTheDocument()
    await view.getByRole('button', { name: 'June 9, 2026' }).click()
    expect(probedRoute(view)).toEqual({ kind: 'daily', date: '2026-06-09' })
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

    // A leading `#` is accepted, and the tag need not exist in the index.
    await input.fill('#zettel')
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
    const view = await renderScreen(undefined, { kind: 'tag', tag: 'travel' })
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()

    await view.getByRole('button', { name: /#travel/, expanded: false }).click()
    await page.getByRole('button', { name: 'Pin #travel', exact: true }).click()

    expect(settingsStore.get().allNotesFilterTags).toEqual(['book', 'person', 'travel'])
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

    expect(settingsStore.get().allNotesFilterTags).toEqual(['book', 'person', '研究/project'])
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
    settingsStore.update({ allNotesFilterTags: ['book', 'person', 'travel'] })
    const view = await renderScreen(undefined, { kind: 'tag', tag: 'travel' })
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()
    await openPinnedFilters(view)

    await page.getByRole('button', { name: 'Actions for #travel' }).click()
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    await expect.element(page.getByRole('button', { name: 'Actions for #person' })).toHaveFocus()
    expect(settingsStore.get().allNotesFilterTags).toEqual(['book', 'person'])
    expect(probedRoute(view)).toEqual({ kind: 'allNotes', filter: { kind: 'tag', tag: 'travel' } })
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()

    for (const tag of ['book', 'person']) {
      await page.getByRole('button', { name: `Actions for #${tag}` }).click()
      await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click()
    }
    expect(settingsStore.get().allNotesFilterTags).toEqual([])
    await expect.element(page.getByPlaceholder('Find a tag to pin…')).toHaveFocus()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    expect(pinnedTabOrder(view)).toEqual([])
    await expect
      .element(view.getByRole('button', { name: /#travel/, expanded: false }))
      .toHaveFocus()
    await expect.element(view.getByRole('button', { name: 'All', exact: true })).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: 'PDF', exact: true })).toBeInTheDocument()
    await expect.element(view.getByText('Daily travel notes.')).toBeInTheDocument()
    await view.unmount()

    const reopened = await renderScreen()
    expect(pinnedTabOrder(reopened)).toEqual([])
    await reopened.unmount()
  })

  it('moves a tag through its menu, disables boundaries, and returns focus to that tag', async () => {
    settingsStore.update({ allNotesFilterTags: ['book', 'person', 'travel'] })
    const view = await renderScreen(undefined, { kind: 'tag', tag: 'travel' })
    await openPinnedFilters(view)
    await page.getByRole('button', { name: 'Actions for #book' }).click()
    await expect
      .element(page.getByRole('menuitem', { name: 'Move to top', exact: true }))
      .toHaveAttribute('aria-disabled', 'true')
    await expect
      .element(page.getByRole('menuitem', { name: 'Move up', exact: true }))
      .toHaveAttribute('aria-disabled', 'true')
    await page.getByRole('menuitem', { name: 'Move to bottom', exact: true }).click()

    expect(settingsStore.get().allNotesFilterTags).toEqual(['person', 'travel', 'book'])
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
      expect(settingsStore.get().allNotesFilterTags).toEqual(['book', 'person'])
      expect(pinWrites()).toHaveLength(0)
    } finally {
      await mouse.up()
    }

    await vi.waitFor(() =>
      expect(settingsStore.get().allNotesFilterTags).toEqual(['person', 'book']),
    )
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
    const view = await renderScreen(undefined, { kind: 'tag', tag: 'book' })
    await openPinnedFilters(view)
    const handle = page.getByRole('button', { name: 'Reorder #person' })
    await movePinnedTagUpWithKeyboard('person')

    expect(settingsStore.get().allNotesFilterTags).toEqual(['book', 'person'])
    expect(pinWrites()).toHaveLength(0)
    await userEvent.keyboard('{Enter}')

    await vi.waitFor(() =>
      expect(settingsStore.get().allNotesFilterTags).toEqual(['person', 'book']),
    )
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
    await movePinnedTagUpWithKeyboard('person')
    await userEvent.keyboard('{Escape}')
    await expect.element(handle).not.toHaveAttribute('aria-pressed', 'true')

    expect(settingsStore.get().allNotesFilterTags).toEqual(['book', 'person'])
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
      await movePinnedTagUpWithKeyboard('person')

      if (exit === 'Done') {
        await page.getByRole('button', { name: 'Done', exact: true }).click()
      } else {
        await view.getByRole('heading', { name: 'Notes', exact: true }).click()
      }
      await expect
        .element(page.getByRole('list', { name: 'Pinned filters' }))
        .not.toBeInTheDocument()
      expect(settingsStore.get().allNotesFilterTags).toEqual(['book', 'person'])
      expect(pinWrites()).toHaveLength(0)
      await openPinnedFilters(view)
      await expect
        .element(page.getByRole('button', { name: 'Actions for #book' }))
        .toBeInTheDocument()
      expect(pinnedTabOrder(view)).toEqual(['#book', '#person'])
      await movePinnedTagUpWithKeyboard('person')
      await userEvent.keyboard('{Enter}')
      await vi.waitFor(() =>
        expect(settingsStore.get().allNotesFilterTags).toEqual(['person', 'book']),
      )
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
    await movePinnedTagUpWithKeyboard('person')
    await act(async () => {
      settingsStore.set({
        ...settingsStore.get(),
        allNotesFilterTags: ['book', 'person', 'external'],
      })
    })
    await expect
      .element(page.getByRole('button', { name: 'Actions for #external' }))
      .toBeInTheDocument()
    page.getByPlaceholder('Find a tag to pin…').element().focus()
    await userEvent.keyboard('{ArrowUp}{Enter}')

    expect(settingsStore.get().allNotesFilterTags).toEqual(['book', 'person', 'external'])
    expect(pinnedTabOrder(view)).toEqual(['#book', '#person', '#external'])
    expect(pinWrites()).toHaveLength(0)
    await expect.element(page.getByRole('list', { name: 'Pinned filters' })).toBeInTheDocument()
    await movePinnedTagUpWithKeyboard('person')
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(settingsStore.get().allNotesFilterTags).toEqual(['person', 'book', 'external']),
    )
    expect(pinWrites()).toHaveLength(1)
    await view.unmount()
  })

  it('keeps All and Custom reachable in a narrow header with long tags and the edit-day filter', async () => {
    const longTags = Array.from({ length: 12 }, (_, index) => `非常长的项目标签/project-${index}`)
    settingsStore.update({ allNotesFilterTags: longTags })
    const view = await renderScreen(undefined, { kind: 'updated', date: '2020-01-15' }, 320)
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
    expect(strip?.scrollWidth).toBeGreaterThan(strip?.clientWidth ?? 0)
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
    expect(openRouteInNewWindow).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('range-selects rows with Shift-click', async () => {
    const rows = [
      { path: 'notes/a.md', title: 'Note A', mtime: 3, preview: 'alpha' },
      { path: 'notes/b.md', title: 'Note B', mtime: 2, preview: 'bravo' },
      { path: 'notes/c.md', title: 'Note C', mtime: 1, preview: 'charlie' },
    ]
    mockInvoke.mockImplementation(async (command, args) => {
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return sql.includes('from "tags"') ? [] : rows
      }
      return []
    })
    const view = await renderScreen()
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
    expect(settingsStore.get().allNotesSort).toEqual({ key: 'title', direction: 'asc' })
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
    expect(settingsStore.get().allNotesSort).toEqual({ key: 'updated', direction: 'desc' })
    await view.getByRole('button', { name: 'Updated, sorted newest first' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Updated, sorted oldest first' }))
      .toBeInTheDocument()
    expect(order()).toBe(-1)
    await view.unmount()
  })

  it('moves the keyboard selection through the sorted order', async () => {
    settingsStore.update({ allNotesSort: { key: 'updated', direction: 'asc' } })
    const view = await renderScreen()
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

    expect(settingsStore.get().allNotesSort).toEqual({ key: 'title', direction: 'asc' })
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
    expect(openRouteInNewWindow).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('opens the selected note in a new window with Mod+Return', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await userEvent.keyboard('{ArrowDown}')
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()

    await userEvent.keyboard('{ControlOrMeta>}{Enter}{/ControlOrMeta}')

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/health.md',
      }),
    )
    expect(openRouteInNewWindow).toHaveBeenCalledTimes(1)
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
      expect(mockInvoke).toHaveBeenCalledWith('note_delete', {
        path: 'notes/health.md',
        generation: 1,
      })
      expect(mockInvoke).toHaveBeenCalledWith('note_delete', {
        path: 'notes/tokyo.md',
        generation: 1,
      })
    })
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
    await expect.element(view.getByText('June 9, 2026')).toBeInTheDocument()

    await view.getByText('Daily travel notes.').click()
    expect(view.getByRole('button', { name: /Trash \(/ }).query()).toBeNull()

    await userEvent.keyboard('{ControlOrMeta>}{Backspace}{/ControlOrMeta}')
    expect(page.getByText('Trash 1 note?').query()).toBeNull()
    expect(mockInvoke.mock.calls.some(([command]) => command === 'note_delete')).toBe(false)
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
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'note_delete') {
        throw new Error('disk on fire')
      }
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return sql.includes('from "tags"') ? [] : noteRows
      }
      if (sql.includes('from "tags"')) {
        return tagRows
      }
      return []
    })
    const view = await renderScreen()
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()

    await view.getByText('Shop your health goals.').click()
    await view.getByRole('button', { name: /Trash \(1\)/ }).click()
    await expect.element(page.getByText('Trash 1 note?')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Trash', exact: true }).click()

    // The confirm closes either way; the reason lands in the operations toast.
    await expectLocatorToHaveCount(page.getByText('Trash 1 note?'), 0)
    await expect.element(view.getByTestId('operations')).toMatchTextContent('failed:disk on fire')
    // The note that failed to trash is left in the list and stays selected, so
    // the bulk action is still available for an immediate retry (no re-select).
    await expect.element(view.getByText('Health Stacked')).toBeInTheDocument()
    await expect.element(view.getByRole('button', { name: /Trash \(1\)/ })).toBeInTheDocument()
    await view.unmount()
  })

  it('keeps trashed rows gone on a partial failure (no index resurrection)', async () => {
    // health trashes; tokyo fails. The index still lists health until the
    // watcher reindexes, so a refetch here would wrongly bring it back.
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'note_delete') {
        if (args['path'] === 'notes/tokyo.md') {
          throw new Error('locked')
        }
        return { trashed: 'system' }
      }
      if (command !== 'db_query') {
        return null
      }
      const sql = String(args['sql'])
      if (sql.includes('group by')) {
        return facetRows
      }
      if (sql.includes('"preview"')) {
        return sql.includes('from "tags"') ? [] : noteRows
      }
      if (sql.includes('from "tags"')) {
        return tagRows
      }
      return []
    })
    const view = await renderScreen()
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
    const healthDeletes = mockInvoke.mock.calls.filter(
      ([command, args]) => command === 'note_delete' && args['path'] === 'notes/health.md',
    )
    expect(healthDeletes).toHaveLength(1)
    await view.unmount()
  })
})
