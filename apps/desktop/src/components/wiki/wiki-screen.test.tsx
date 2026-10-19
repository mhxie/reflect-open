import { createTestCoreServices, createTestNoteFileService } from '@reflect/core/testing'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import '@/styles/index.css'
import { Suspense, use, type ReactElement } from 'react'
import {
  AppError,
  buildIndexedNote,
  normalizeWikiLanguages,
  parseNote,
  type Settings,
} from '@reflect/core'
import { wikiRoute, type Route } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { WikiScreen } from './wiki-screen.tsx'

/**
 * The Wiki screen over the real query layer, a seeded test index (entry rows
 * and the notes that cite them), entry files from memory, the real router,
 * and the real settings, so sorting, layout, and folding re-render like the app.
 */

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
/** Settings the next render starts from, over ISO dates. */
let initialSettings: Partial<Settings> = {}
/** Why the next render's listing fails, if it does. */
let listingFailure: Error | null = null

/**
 * `fixture` with fresh hashes for `paths`, the way a changed file reindexes.
 */
function rehashed(paths: readonly string[], files: Record<string, string>): Fixture {
  return {
    notes: WIKI.notes.map((note) => {
      return paths.includes(note.path) ? { ...note, file_hash: `${note.file_hash}-changed` } : note
    }),
    files,
  }
}

/** Paths whose reads fail the way an unreadable file does. */
let unreadable = new Set<string>()

/** Notes outside the wiki that cite Spacing Effect. */
const CITERS = ['notes/a.md', 'notes/b.md', 'notes/c.md']

beforeEach(() => {
  fixture = WIKI
  pendingNoteLoad = undefined
  initialSettings = {}
  listingFailure = null
  unreadable = new Set()
})

/** The route on screen: a navigation whose destination suspends commits once it is ready. */
function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

function RoutedScreen(): ReactElement {
  const { route } = useRouter()
  if (route.kind === 'note' && pendingNoteLoad !== undefined) {
    use(pendingNoteLoad)
  }
  return route.kind === 'wiki' ? (
    <WikiScreen filter={route.filter} language={route.language} />
  ) : (
    <WikiScreen filter={null} language={null} />
  )
}

async function renderScreen(language: string | null = null) {
  const citers = Object.fromEntries(
    CITERS.map((path) => [path, 'See [[wiki/memory/Spacing Effect]].\n']),
  )
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile: createTestNoteFileService({ files: { ...fixture.files, ...citers }, generation: 1 }),
  })
  onTestFinished(() => app.database.close())
  const index = (path: string, title: string | null, fileHash: string, mtime: number) => {
    const source = fixture.files[path] ?? citers[path] ?? ''
    const indexed = buildIndexedNote(parseNote({ path, source }), { fileHash, mtime, source })
    app.database.applyProjection(title === null ? indexed : { ...indexed, title })
  }
  for (const note of fixture.notes) {
    index(note.path, note.title, note.file_hash, note.mtime)
  }
  for (const path of CITERS) {
    index(path, null, `hash-${path}`, 1)
  }
  const readLocal = app.noteFile.readLocal.bind(app.noteFile)
  vi.spyOn(app.noteFile, 'readLocal').mockImplementation(async (path, generation) => {
    if (unreadable.has(path)) {
      throw new AppError('io', 'stream did not contain valid UTF-8')
    }
    if (fixture.files[path] === undefined && citers[path] === undefined) {
      return { kind: 'evicted' }
    }
    return await readLocal(path, generation)
  })
  if (listingFailure !== null) {
    vi.spyOn(app.wiki, 'listEntries').mockRejectedValue(listingFailure)
  }
  // Entries are summarized as of today: reviews and sources dated 2020 count.
  app.clock.setNow(Date.now())
  return await renderInApp(
    <Suspense fallback={null}>
      <div style={{ height: '100vh' }}>
        <RoutedScreen />
      </div>
      <RouteProbe />
    </Suspense>,
    {
      app,
      graph: { root: '/g', name: 'g', generation: 1 },
      route: wikiRoute({ language }),
      settings: { dateFormat: 'iso', ...initialSettings },
    },
  )
}

type ScreenView = Awaited<ReturnType<typeof renderScreen>>

function probedRoute(view: ScreenView): unknown {
  return JSON.parse(view.getByTestId('route').element().textContent ?? 'null')
}

async function expectRoute(view: ScreenView, route: Route): Promise<void> {
  await vi.waitFor(() => expect(probedRoute(view)).toEqual(route))
}

/**
 * Entry subjects in render order (the gutter toggle is the row's pressed
 * button; an index tree row's expander is its expanded one).
 */
function rowTitles(view: ScreenView): string[] {
  return [...view.container.querySelectorAll('[data-row-index]')].map((row) => {
    return row.querySelector('button:not([aria-pressed]):not([aria-expanded])')?.textContent ?? ''
  })
}

describe('WikiScreen', () => {
  it('keeps filters reachable in a narrow window with several languages', async () => {
    const previousViewport = { width: window.innerWidth, height: window.innerHeight }
    initialSettings = {
      wikiLanguages: normalizeWikiLanguages([
        { label: 'English', folder: 'wiki' },
        { label: '简体中文', folder: 'wiki-cn' },
        { label: '日本語', folder: 'wiki-jp' },
        { label: 'Français', folder: 'wiki-fr' },
      ]),
    }
    await page.viewport(760, 650)
    const view = await renderScreen()
    try {
      await expect.element(view.getByText('Index', { exact: true })).toBeInTheDocument()
      const filter = view.getByRole('group', { name: 'Filter entries' }).element()
      expect(filter.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
      expect(filter.scrollWidth).toBeGreaterThan(filter.clientWidth)

      await view.getByRole('button', { name: 'Missing Français 4' }).click()
      await expectRoute(view, wikiRoute({ filter: { kind: 'untranslated', folder: 'wiki-fr' } }))
      expect(rowTitles(view)).toEqual([
        'Retrieval Practice',
        'Spacing Effect',
        'Wiki Index',
        'Zeigarnik Effect',
      ])
    } finally {
      await view.unmount()
      await page.viewport(previousViewport.width, previousViewport.height)
    }
  })

  it('lists entries flat, like All Notes, with review, claims, sources, and citations', async () => {
    const view = await renderScreen()

    await expect.element(view.getByText('3 entries · 4 claims')).toBeInTheDocument()
    await expect
      .element(view.getByTestId('wiki-scroll').getByText('Wiki', { exact: true }))
      .toBeVisible()
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

  it('labels indexes in both layouts and filters by role across languages', async () => {
    fixture = {
      notes: [
        ...WIKI.notes,
        {
          path: 'wiki-cn/index.md',
          title: 'Wiki Index (中文)',
          mtime: 1,
          file_hash: 'index-cn',
        },
      ],
      files: { ...WIKI.files, 'wiki-cn/index.md': '# Wiki Index (中文)\n\n- [[Spacing Effect]]\n' },
    }
    const view = await renderScreen()
    const header = view.getByRole('banner')

    await expect.element(view.getByText('Index', { exact: true })).toBeInTheDocument()
    await expect
      .element(header.getByRole('button', { name: 'All 4' }))
      .toHaveAttribute('aria-pressed', 'true')
    await header.getByRole('button', { name: 'Knowledge 3' }).click()
    await expectRoute(view, wikiRoute({ filter: { kind: 'knowledge' } }))
    expect(rowTitles(view)).toEqual(['Retrieval Practice', 'Spacing Effect', 'Zeigarnik Effect'])
    expect(view.getByText('Index', { exact: true }).query()).toBeNull()

    await header.getByRole('button', { name: 'Indexes 1' }).click()
    await expectRoute(view, wikiRoute({ filter: { kind: 'index' } }))
    expect(rowTitles(view)).toEqual(['Wiki Index'])
    await expect
      .element(header.getByRole('button', { name: 'Indexes 1' }))
      .toHaveAttribute('aria-pressed', 'true')

    await header.getByRole('button', { name: '简体中文', exact: true }).click()
    await expectRoute(view, wikiRoute({ filter: { kind: 'index' }, language: 'wiki-cn' }))
    expect(rowTitles(view)).toEqual(['Wiki Index (中文)'])
    await expect.element(view.getByText('Index', { exact: true })).toBeInTheDocument()
    // The index tree is the Indexes layout; flat and topic views would contradict it.
    expect(header.getByRole('group', { name: 'Layout' }).query()).toBeNull()

    await header.getByRole('button', { name: 'All 4' }).click()
    await expectRoute(view, wikiRoute({ language: 'wiki-cn' }))
    await header.getByRole('button', { name: 'Topics' }).click()
    await expect.element(view.getByRole('region', { name: 'Overview' })).toBeInTheDocument()
    await expect.element(view.getByText('Index', { exact: true })).toBeInTheDocument()
    expect(rowTitles(view)).toEqual([
      'Wiki Index (中文)',
      'Retrieval Practice',
      'Spacing Effect (中文)',
      'Zeigarnik Effect',
    ])

    await header.getByRole('button', { name: 'Indexes 1' }).click()
    view.container.querySelector<HTMLElement>('[aria-label="Wiki"]')?.focus()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    await expectRoute(view, { kind: 'note', path: 'wiki-cn/index.md' })
    await view.unmount()
  })

  it('lays indexes out as a tree that collapses, sorts siblings, and skips hidden rows', async () => {
    const indexes = [
      ['wiki/memory/index.md', 'Memory Index'],
      ['wiki/memory/sleep/index.md', 'Sleep Index'],
      ['wiki/motivation/index.md', 'Motivation Index'],
    ] as const
    fixture = {
      notes: [
        ...WIKI.notes,
        ...indexes.map(([path, title]) => ({ path, title, mtime: 1, file_hash: path })),
      ],
      files: {
        ...WIKI.files,
        ...Object.fromEntries(indexes.map(([path, title]) => [path, `# ${title}\n`])),
      },
    }
    const view = await renderScreen()
    const header = view.getByRole('banner')

    await header.getByRole('button', { name: 'Indexes 4' }).click()
    await expectRoute(view, wikiRoute({ filter: { kind: 'index' } }))
    expect(rowTitles(view)).toEqual([
      'Wiki Index',
      'Memory Index',
      'Sleep Index',
      'Motivation Index',
    ])
    await expect
      .element(view.getByRole('button', { name: 'Indexes under Wiki Index' }))
      .toHaveAttribute('aria-expanded', 'true')
    // A leaf has nothing to expand.
    expect(view.getByRole('button', { name: 'Indexes under Sleep Index' }).query()).toBeNull()
    // Each level nests in its parent's list item, so assistive tech hears the depth.
    const itemOf = (title: string): Element | null | undefined => {
      return [...view.container.querySelectorAll('[data-row-index]')]
        .find((row) => {
          return (
            row.querySelector('button:not([aria-pressed]):not([aria-expanded])')?.textContent ===
            title
          )
        })
        ?.closest('li')
    }
    expect(itemOf('Memory Index')?.contains(itemOf('Sleep Index') ?? null)).toBe(true)
    expect(itemOf('Wiki Index')?.contains(itemOf('Motivation Index') ?? null)).toBe(true)
    expect(itemOf('Motivation Index')?.contains(itemOf('Sleep Index') ?? null)).toBe(false)

    // Sorting reorders siblings; parents still lead their children.
    await view.getByRole('button', { name: 'Subject, sorted A to Z' }).click()
    expect(rowTitles(view)).toEqual([
      'Wiki Index',
      'Motivation Index',
      'Memory Index',
      'Sleep Index',
    ])
    await view.getByRole('button', { name: 'Subject, sorted Z to A' }).click()

    await view.getByRole('button', { name: 'Indexes under Memory Index' }).click()
    await expect
      .element(view.getByRole('button', { name: 'Indexes under Memory Index' }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(rowTitles(view)).toEqual(['Wiki Index', 'Memory Index', 'Motivation Index'])
    expect(probedRoute(view)).toEqual(wikiRoute({ filter: { kind: 'index' } }))

    // What is collapsed survives reading the list in another language.
    await header.getByRole('button', { name: '简体中文', exact: true }).click()
    await expectRoute(view, wikiRoute({ filter: { kind: 'index' }, language: 'wiki-cn' }))
    expect(rowTitles(view)).toEqual(['Wiki Index', 'Memory Index', 'Motivation Index'])

    // Return on the focused toggle expands it rather than opening a note.
    view.getByRole('button', { name: 'Indexes under Memory Index' }).element().focus()
    await userEvent.keyboard('{Enter}')
    await expect
      .element(view.getByRole('button', { name: 'Indexes under Memory Index' }))
      .toHaveAttribute('aria-expanded', 'true')
    expect(probedRoute(view)).toEqual(wikiRoute({ filter: { kind: 'index' }, language: 'wiki-cn' }))

    // The keyboard walks only the visible rows.
    await view.getByRole('button', { name: 'Indexes under Memory Index' }).click()
    view.container.querySelector<HTMLElement>('[aria-label="Wiki"]')?.focus()
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}')
    await expectRoute(view, { kind: 'note', path: 'wiki/motivation/index.md' })
    await view.unmount()
  })

  it('restores the layout switch after leaving the Indexes filter', async () => {
    const view = await renderScreen()
    const header = view.getByRole('banner')

    await header.getByRole('button', { name: 'Indexes 1' }).click()
    expect(header.getByRole('group', { name: 'Layout' }).query()).toBeNull()
    await header.getByRole('button', { name: 'All 4' }).click()

    await expect.element(header.getByRole('group', { name: 'Layout' })).toBeInTheDocument()
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
    // The Missing filter lists exactly the rows marked, the index among them.
    await expect
      .element(view.getByRole('button', { name: 'Missing 简体中文 3' }))
      .toBeInTheDocument()

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
    // Entries without claims follow the rest.
    expect(rowTitles(view)).toEqual([
      'Spacing Effect',
      'Retrieval Practice',
      'Zeigarnik Effect',
      'Wiki Index',
    ])
    expect(view.app.settings.get().wikiSort).toEqual({ key: 'claims', direction: 'desc' })
    await view.unmount()
  })

  it('groups entries by topic, sorted inside each topic', async () => {
    initialSettings = { wikiSort: { key: 'sources', direction: 'desc' } }
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
    expect(view.app.settings.get().wikiGroupByTopic).toBe(true)
    await view.unmount()
  })

  it('folds a topic, skips its rows from the keyboard, and ⌥-click folds every topic', async () => {
    initialSettings = { wikiGroupByTopic: true }
    const view = await renderScreen()
    await expect.element(view.getByText('Spaced sessions beat cramming.')).toBeInTheDocument()

    await view.getByRole('button', { name: /^memory/ }).click()

    await expect
      .element(view.getByRole('button', { name: /^memory/ }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(rowTitles(view)).toEqual(['Wiki Index', 'Zeigarnik Effect'])
    expect(view.app.settings.get().wikiFoldedTopics).toEqual(['memory'])

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

    await header.getByRole('button', { name: 'Missing 简体中文 3' }).click()
    await expectRoute(view, {
      kind: 'wiki',
      filter: { kind: 'untranslated', folder: 'wiki-cn' },
      language: null,
    })
    expect(rowTitles(view)).toEqual(['Retrieval Practice', 'Wiki Index', 'Zeigarnik Effect'])

    await header.getByRole('button', { name: 'Unreviewed 1' }).click()
    await expectRoute(view, { kind: 'wiki', filter: { kind: 'unreviewed' }, language: null })
    expect(rowTitles(view)).toEqual(['Zeigarnik Effect'])
    // No entry carries a tag, so there is no Tag menu to offer.
    expect(view.getByRole('button', { name: 'Tag' }).query()).toBeNull()
    await view.unmount()
  })

  it('reads a missing-translation filter for a removed language as no filter', async () => {
    const view = await renderScreen()
    const header = view.getByRole('banner')
    await header.getByRole('button', { name: 'Missing 简体中文 3' }).click()
    await vi.waitFor(() => {
      expect(rowTitles(view)).toEqual(['Retrieval Practice', 'Wiki Index', 'Zeigarnik Effect'])
    })

    view.app.settings.update({
      wikiLanguages: normalizeWikiLanguages([{ label: 'English', folder: 'wiki' }]),
    })

    await vi.waitFor(() => {
      expect(rowTitles(view)).toEqual([
        'Retrieval Practice',
        'Spacing Effect',
        'Wiki Index',
        'Zeigarnik Effect',
      ])
    })
    await view.unmount()
  })

  it('keeps missing-translation filters distinct for languages with the same label', async () => {
    initialSettings = {
      wikiLanguages: normalizeWikiLanguages([
        { label: 'English', folder: 'wiki' },
        { label: '中文', folder: 'wiki-cn' },
        { label: '中文', folder: 'wiki-tw' },
      ]),
    }
    const view = await renderScreen()
    const header = view.getByRole('banner')

    await header.getByRole('button', { name: 'Missing 中文 3' }).click()

    await expectRoute(view, {
      kind: 'wiki',
      filter: { kind: 'untranslated', folder: 'wiki-cn' },
      language: null,
    })
    expect(rowTitles(view)).toEqual(['Retrieval Practice', 'Wiki Index', 'Zeigarnik Effect'])

    await header.getByRole('button', { name: 'Missing 中文 4' }).click()

    await expectRoute(view, {
      kind: 'wiki',
      filter: { kind: 'untranslated', folder: 'wiki-tw' },
      language: null,
    })
    expect(rowTitles(view)).toEqual([
      'Retrieval Practice',
      'Spacing Effect',
      'Wiki Index',
      'Zeigarnik Effect',
    ])
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
    listingFailure = new AppError('io', 'database is locked')
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
