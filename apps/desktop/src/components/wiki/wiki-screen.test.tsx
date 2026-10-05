import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import { Suspense, type ReactElement } from 'react'
import { normalizeWikiLanguages, setBridge, type Settings } from '@reflect/core'
import { wikiRoute, type Route } from '@/routing/route.ts'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { WikiScreen } from './wiki-screen.tsx'

/**
 * The Wiki screen over the real query layer, a fake IPC bridge (index rows
 * from compiled SQL, entry files from memory), the real router, and a small
 * settings store so sorting, layout, and folding re-render like the app.
 */

const settingsStore = vi.hoisted(() => {
  let patch: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  return {
    get: (): Record<string, unknown> => patch,
    set: (next: Record<string, unknown>): void => {
      patch = { ...patch, ...next }
      for (const listener of listeners) {
        listener()
      }
    },
    reset: (): void => {
      patch = {}
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider.tsx', async () => {
  const { useSyncExternalStore } = await import('react')
  const { DEFAULT_SETTINGS: defaults } = await import('@reflect/core')
  const read = (): Settings => ({ ...defaults, dateFormat: 'iso', ...settingsStore.get() })
  return {
    useSettings: () => {
      useSyncExternalStore(settingsStore.subscribe, settingsStore.get)
      return {
        settings: read(),
        updateSettings: (patch: Partial<Settings>) => settingsStore.set(patch),
        updateSettingsWith: (updater: (current: Settings) => Partial<Settings>) =>
          settingsStore.set(updater(read())),
      }
    },
  }
})

const SPACING = [
  '# Spacing Effect',
  '',
  '> Spread practice out.',
  '',
  '## Summary',
  '',
  'Spaced sessions beat cramming.',
  '',
  '## Claims',
  '',
  '### [C1] Spacing improves retention',
  '',
  'Body.',
  '',
  '```anchors',
  '@anchor: doi:10.1037/0033-2909.132.3.354 | valid_at: 2020-01-02',
  '@anchor: url:https://example.org/spacing | valid_at: 2020-01-02',
  '@pass: reviewer | status: verified | at: 2020-01-02',
  '```',
  '',
  '### [C2] It holds across ages',
  '',
  'Body.',
  '',
  '```anchors',
  '@pass: reviewer | status: verified | at: 2020-01-02',
  '```',
  '',
  '## Revision Log',
  '',
  '- 2020-01-03: Initial draft.',
].join('\n')

const RETRIEVAL = [
  '# Retrieval Practice',
  '',
  '## Summary',
  '',
  'Testing yourself beats rereading.',
  '',
  '## Claims',
  '',
  '### [C1] Testing beats rereading',
  '',
  'Body.',
  '',
  '```anchors',
  '@anchor: doi:10.1111/j.1467-9280.2006.01693.x | valid_at: 2020-01-02',
  '@pass: reviewer | status: flagged | at: 2020-01-02',
  '```',
].join('\n')

const ZEIGARNIK = [
  '# Zeigarnik Effect',
  '',
  '## Claims',
  '',
  '### [C1] Unfinished tasks are remembered better',
  '',
  '```anchors',
  '@anchor: doi:10.1007/bf02409636 | valid_at: 2020-01-02',
  '@anchor: doi:10.1037/a0023919 | valid_at: 2020-01-02',
  '@anchor: url:https://example.org/zeigarnik | valid_at: 2020-01-02',
  '```',
].join('\n')

const SPACING_CN = [
  '---',
  'title: "Spacing Effect (中文)"',
  '---',
  '',
  '# Spacing Effect',
  '',
  '> 本文为 [[Spacing Effect]] 的中文版本。',
  '',
  '## Summary',
  '',
  '间隔练习胜过集中练习。',
].join('\n')

interface Fixture {
  notes: { path: string; title: string; mtime: number; file_hash: string }[]
  files: Record<string, string>
}

const WIKI: Fixture = {
  notes: [
    {
      path: 'wiki-cn/memory/Spacing Effect.md',
      title: 'Spacing Effect (中文)',
      mtime: 1,
      file_hash: 'a',
    },
    { path: 'wiki/index.md', title: 'Wiki Index', mtime: 1, file_hash: 'b' },
    {
      path: 'wiki/memory/Retrieval Practice.md',
      title: 'Retrieval Practice',
      mtime: 1,
      file_hash: 'c',
    },
    { path: 'wiki/memory/Spacing Effect.md', title: 'Spacing Effect', mtime: 1, file_hash: 'd' },
    {
      path: 'wiki/motivation/Zeigarnik Effect.md',
      title: 'Zeigarnik Effect',
      mtime: 1,
      file_hash: 'e',
    },
  ],
  files: {
    'wiki/index.md': '# Wiki Index\n\n## Entries\n\n- [[Spacing Effect]]\n',
    'wiki/memory/Retrieval Practice.md': RETRIEVAL,
    'wiki/memory/Spacing Effect.md': SPACING,
    'wiki/motivation/Zeigarnik Effect.md': ZEIGARNIK,
    'wiki-cn/memory/Spacing Effect.md': SPACING_CN,
  },
}

let fixture: Fixture = WIKI
let pendingNoteLoad: Promise<void> | undefined

const mockInvoke = vi.fn<(command: string, args: Record<string, unknown>) => Promise<unknown>>()
setBridge({ invoke: mockInvoke, listen: async () => () => {} })

/**
 * `fixture` with fresh hashes for `paths`: listing caches summaries by path
 * and hash across renders, the way the app keeps them across visits.
 */
function rehashed(paths: readonly string[], files: Record<string, string>): Fixture {
  return {
    notes: WIKI.notes.map((note) =>
      paths.includes(note.path) ? { ...note, file_hash: `${note.file_hash}-changed` } : note,
    ),
    files,
  }
}

/** Paths whose reads fail the way an unreadable file does. */
let unreadable = new Set<string>()

beforeEach(() => {
  fixture = WIKI
  pendingNoteLoad = undefined
  unreadable = new Set()
  settingsStore.reset()
  mockInvoke.mockReset()
  mockInvoke.mockImplementation(async (command, args) => {
    if (command === 'note_read_local') {
      if (unreadable.has(String(args['path']))) {
        throw { kind: 'io', message: 'stream did not contain valid UTF-8' }
      }
      const content = fixture.files[String(args['path'])]
      return content === undefined ? { kind: 'evicted' } : { kind: 'content', content }
    }
    if (command !== 'db_query') {
      return null
    }
    const query = String(args['sql'])
    if (query.includes('count(distinct')) {
      return [{ target_path: 'wiki/memory/Spacing Effect.md', cited_by: 3 }]
    }
    if (query.includes('from "tags"')) {
      return []
    }
    if (query.includes('"file_hash"')) {
      return fixture.notes.map((note) => ({ is_private: 0, has_conflict: 0, ...note }))
    }
    return []
  })
})

function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function RoutedScreen(): ReactElement {
  const { route } = useRouter()
  if (route.kind === 'note' && pendingNoteLoad !== undefined) {
    throw pendingNoteLoad
  }
  return route.kind === 'wiki' ? (
    <WikiScreen filter={route.filter} language={route.language} />
  ) : (
    <WikiScreen filter={null} language={null} />
  )
}

function renderScreen(language: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={wikiRoute({ language })}>
        <Suspense fallback={null}>
          <div style={{ height: '100vh' }}>
            <RoutedScreen />
          </div>
          <RouteProbe />
        </Suspense>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function probedRoute(view: Awaited<ReturnType<typeof renderScreen>>): unknown {
  return JSON.parse(view.getByTestId('route').element().textContent ?? 'null')
}

async function expectRoute(
  view: Awaited<ReturnType<typeof renderScreen>>,
  route: Route,
): Promise<void> {
  await vi.waitFor(() => expect(probedRoute(view)).toEqual(route))
}

/** Entry subjects in render order (the gutter toggle is the row's pressed button). */
function rowTitles(view: Awaited<ReturnType<typeof renderScreen>>): string[] {
  return [...view.container.querySelectorAll('[data-row-index]')].map(
    (row) => row.querySelector('button:not([aria-pressed])')?.textContent ?? '',
  )
}

describe('WikiScreen', () => {
  it('lists entries flat, like All Notes, with review, claims, sources, and citations', async () => {
    const view = await renderScreen()

    await expect.element(view.getByText('3 entries · 4 claims')).toBeInTheDocument()
    expect(view.getByRole('region', { name: 'memory' }).query()).toBeNull()
    for (const name of [
      'Subject, sorted A to Z',
      'Sort by updated',
      'Sort by review',
      'Sort by claims',
      'Sort by sources',
      'Sort by cited by',
    ]) {
      await expect.element(view.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(rowTitles(view)).toEqual([
      'Retrieval Practice',
      'Spacing Effect',
      'Wiki Index',
      'Zeigarnik Effect',
    ])

    // The snippet is the entry's first paragraph, past its primer quote.
    await expect.element(view.getByText('Spaced sessions beat cramming.')).toBeInTheDocument()
    await expect.element(view.getByText('2020-01-03')).toBeInTheDocument()
    await expect
      .element(view.getByRole('img', { name: 'All 2 claims verified' }))
      .toBeInTheDocument()
    await expect
      .element(view.getByRole('img', { name: '1 flagged · 0 of 1 claims verified' }))
      .toBeInTheDocument()
    await expect
      .element(view.getByRole('img', { name: 'No claims verified yet' }))
      .toBeInTheDocument()
    await expect
      .element(view.getByRole('img', { name: '2 claims, 1 without a source' }))
      .toBeInTheDocument()
    await expect.element(view.getByRole('img', { name: '3 sources' })).toBeInTheDocument()
    await expect.element(view.getByRole('img', { name: 'Cited by 3 notes' })).toBeInTheDocument()
    expect(view.getByText('Verified').query()).toBeNull()
    await view.unmount()
  })

  it('reads the list in a translation, showing the source where an entry has none', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Spaced sessions beat cramming.')).toBeInTheDocument()

    await view.getByRole('button', { name: '简体中文', exact: true }).click()

    await expectRoute(view, { kind: 'wiki', filter: null, language: 'wiki-cn' })
    await expect.element(view.getByText('间隔练习胜过集中练习。')).toBeInTheDocument()
    expect(view.getByText('Spaced sessions beat cramming.').query()).toBeNull()
    expect(rowTitles(view)).toEqual([
      'Retrieval Practice',
      'Spacing Effect (中文)',
      'Wiki Index',
      'Zeigarnik Effect',
    ])
    await expectLocatorToHaveCount(view.getByRole('img', { name: 'Not in 简体中文 yet' }), 3)

    await view.getByRole('button', { name: 'Spacing Effect (中文)' }).click()
    await expectRoute(view, { kind: 'note', path: 'wiki-cn/memory/Spacing Effect.md' })
    await view.unmount()
  })

  it('opens an entry without a translation in its source language', async () => {
    const view = await renderScreen('wiki-cn')

    await view.getByRole('button', { name: 'Retrieval Practice' }).click()

    await expectRoute(view, { kind: 'note', path: 'wiki/memory/Retrieval Practice.md' })
    await view.unmount()
  })

  it('commits note navigation after a suspended destination becomes ready', async () => {
    let release: (() => void) | undefined
    pendingNoteLoad = new Promise<void>((resolve) => {
      release = resolve
    })
    const view = await renderScreen('wiki-cn')
    try {
      await view.getByRole('button', { name: 'Retrieval Practice' }).click()

      expect(probedRoute(view)).toEqual(wikiRoute({ language: 'wiki-cn' }))
      pendingNoteLoad = undefined
      release?.()
      await expectRoute(view, { kind: 'note', path: 'wiki/memory/Retrieval Practice.md' })
    } finally {
      pendingNoteLoad = undefined
      release?.()
      await view.unmount()
    }
  })

  it('sorts from the column headers and remembers the order', async () => {
    const view = await renderScreen()
    await expect.element(view.getByText('Spaced sessions beat cramming.')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Sort by claims' }).click()

    await expect
      .element(view.getByRole('button', { name: 'Claims, sorted most first' }))
      .toBeInTheDocument()
    // Guides make no claims, so they follow the rest.
    expect(rowTitles(view)).toEqual([
      'Spacing Effect',
      'Retrieval Practice',
      'Zeigarnik Effect',
      'Wiki Index',
    ])
    expect(settingsStore.get()['wikiSort']).toEqual({ key: 'claims', direction: 'desc' })
    await view.unmount()
  })

  it('groups entries by topic, sorted inside each topic', async () => {
    settingsStore.set({ wikiSort: { key: 'sources', direction: 'desc' } })
    const view = await renderScreen()
    await expect.element(view.getByText('Spaced sessions beat cramming.')).toBeInTheDocument()

    await view.getByRole('button', { name: 'Topics' }).click()

    await expect.element(view.getByRole('region', { name: 'memory' })).toBeInTheDocument()
    await expect.element(view.getByRole('region', { name: 'Overview' })).toBeInTheDocument()
    expect(rowTitles(view)).toEqual([
      'Wiki Index',
      'Spacing Effect',
      'Retrieval Practice',
      'Zeigarnik Effect',
    ])
    expect(settingsStore.get()['wikiGroupByTopic']).toBe(true)
    await view.unmount()
  })

  it('folds a topic, skips its rows from the keyboard, and ⌥-click folds every topic', async () => {
    settingsStore.set({ wikiGroupByTopic: true })
    const view = await renderScreen()
    await expect.element(view.getByText('Spaced sessions beat cramming.')).toBeInTheDocument()

    await view.getByRole('button', { name: /^memory/ }).click()

    await expect
      .element(view.getByRole('button', { name: /^memory/ }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(rowTitles(view)).toEqual(['Wiki Index', 'Zeigarnik Effect'])
    expect(settingsStore.get()['wikiFoldedTopics']).toEqual(['memory'])

    view.container.querySelector<HTMLElement>('[aria-label="Wiki"]')?.focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    await expectRoute(view, { kind: 'note', path: 'wiki/motivation/Zeigarnik Effect.md' })

    await view.getByRole('button', { name: /^motivation/ }).click({ modifiers: ['Alt'] })
    expect(rowTitles(view)).toEqual([])
    await view.unmount()
  })

  it('filters from the header by review state and missing translations, on the route', async () => {
    const view = await renderScreen()

    const header = view.getByRole('banner')
    await header.getByRole('button', { name: 'Flagged 1' }).click()

    await expectRoute(view, { kind: 'wiki', filter: { kind: 'flagged' }, language: null })
    expect(rowTitles(view)).toEqual(['Retrieval Practice'])

    await header.getByRole('button', { name: 'Missing 简体中文 2' }).click()
    await expectRoute(view, {
      kind: 'wiki',
      filter: { kind: 'untranslated', folder: 'wiki-cn' },
      language: null,
    })
    expect(rowTitles(view)).toEqual(['Retrieval Practice', 'Zeigarnik Effect'])

    await header.getByRole('button', { name: 'Unreviewed 1' }).click()
    await expectRoute(view, { kind: 'wiki', filter: { kind: 'unreviewed' }, language: null })
    expect(rowTitles(view)).toEqual(['Zeigarnik Effect'])
    // No entry carries a tag, so there is no Tag menu to offer.
    expect(view.getByRole('button', { name: 'Tag' }).query()).toBeNull()
    await view.unmount()
  })

  it('keeps missing-translation filters distinct for languages with the same label', async () => {
    settingsStore.set({
      wikiLanguages: normalizeWikiLanguages([
        { label: 'English', folder: 'wiki' },
        { label: '中文', folder: 'wiki-cn' },
        { label: '中文', folder: 'wiki-tw' },
      ]),
    })
    const view = await renderScreen()
    const header = view.getByRole('banner')

    await header.getByRole('button', { name: 'Missing 中文 2' }).click()

    await expectRoute(view, {
      kind: 'wiki',
      filter: { kind: 'untranslated', folder: 'wiki-cn' },
      language: null,
    })
    expect(rowTitles(view)).toEqual(['Retrieval Practice', 'Zeigarnik Effect'])

    await header.getByRole('button', { name: 'Missing 中文 3' }).click()

    await expectRoute(view, {
      kind: 'wiki',
      filter: { kind: 'untranslated', folder: 'wiki-tw' },
      language: null,
    })
    expect(rowTitles(view)).toEqual(['Retrieval Practice', 'Spacing Effect', 'Zeigarnik Effect'])
    await view.unmount()
  })

  it('says on its own row when a copy is not on this device or cannot be read', async () => {
    const { 'wiki/memory/Retrieval Practice.md': _evicted, ...files } = WIKI.files
    fixture = rehashed(
      ['wiki/memory/Retrieval Practice.md', 'wiki/motivation/Zeigarnik Effect.md'],
      files,
    )
    unreadable = new Set(['wiki/motivation/Zeigarnik Effect.md'])
    const view = await renderScreen()

    await expect.element(view.getByText('Not on this device')).toBeInTheDocument()
    await expect.element(view.getByText('Couldn’t read this file')).toBeInTheDocument()
    await expect.element(view.getByText('Spaced sessions beat cramming.')).toBeInTheDocument()
    await view.unmount()
  })

  it('reports a translation copy’s own availability', async () => {
    const { 'wiki/memory/Spacing Effect.md': _evicted, ...files } = WIKI.files
    fixture = rehashed(['wiki/memory/Spacing Effect.md'], files)
    const view = await renderScreen('wiki-cn')

    // The source is evicted, but the Chinese copy the row shows is here.
    await expect.element(view.getByText('间隔练习胜过集中练习。')).toBeInTheDocument()
    expect(view.getByText('Not on this device').query()).toBeNull()
    await view.unmount()
  })

  it('explains a listing that fails', async () => {
    const serve = mockInvoke.getMockImplementation()
    mockInvoke.mockImplementation(async (command, args) => {
      if (command === 'db_query' && String(args['sql']).includes('"file_hash"')) {
        throw { kind: 'io', message: 'database is locked' }
      }
      return await serve?.(command, args)
    })
    const view = await renderScreen()

    await expect
      .element(view.getByRole('alert'))
      .toHaveTextContent('Couldn’t list the wiki: database is locked')
    await view.unmount()
  })

  it('explains an empty wiki', async () => {
    fixture = { notes: [], files: {} }
    const view = await renderScreen()

    await expect
      .element(view.getByText('No wiki entries yet. Notes in wiki/ appear here.'))
      .toBeInTheDocument()
    await view.unmount()
  })
})
