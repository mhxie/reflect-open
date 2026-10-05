import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  untitledNotePath,
  type GraphInfo,
  type PinnedNote,
  type Settings,
} from '@reflect/core'
import type { CommandContext } from '@/lib/commands/types.ts'
import type { NoteRoute, Route } from '@/routing/route.ts'
import { PeekProvider, usePeek } from '@/components/peek/peek-provider.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { UpdateProvider } from '@/providers/update-provider.tsx'
import { RouterProvider } from '@/routing/router.tsx'
import { expectLocatorToHaveCount } from '@/test-utils/expect.ts'

const getPinnedNotes = vi.hoisted(() => vi.fn<() => Promise<PinnedNote[]>>(async () => []))
const hasWikiEntries = vi.hoisted(() => vi.fn<() => Promise<boolean>>(async () => false))
const revealItemInDir = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>(async () => {}))
const openUrl = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>(async () => {}))
const openRouteInNewWindow = vi.hoisted(() => vi.fn<(route: NoteRoute) => Promise<boolean>>())
const openRecent = vi.hoisted(() => vi.fn())
const pickAndOpen = vi.hoisted(() => vi.fn())
const chooseGraph = vi.hoisted(() => vi.fn())
type NativeContextMenuItemForTest = { text: string; action: () => void } | { separator: true }

interface NativeContextMenuOptionsForTest {
  items: NativeContextMenuItemForTest[]
}

/** The native menu row the mocked menu "selects" when it opens. */
const menuChoice = vi.hoisted(() => ({ text: 'Unpin Note' }))
const openNativeContextMenu = vi.hoisted(() =>
  vi.fn(async (options: NativeContextMenuOptionsForTest) => {
    for (const item of options.items) {
      if ('text' in item && item.text === menuChoice.text) {
        item.action()
      }
    }
  }),
)

/** The menu's rows as labels, with separators as `null`. */
function menuLabels(): (string | null)[] {
  const items = openNativeContextMenu.mock.calls[0]?.[0].items ?? []
  return items.map((item) => ('text' in item ? item.text : null))
}
const operationFail = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() => vi.fn(() => ({ fail: operationFail })))
vi.mock('@/lib/operations.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/operations.ts')>()),
  startOperation,
}))
const commitNoteFrontmatter = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/note-frontmatter.ts', () => ({
  commitNoteFrontmatter,
  readNoteSource: async () => '# Rust\n',
}))
const updateSettingsWith = vi.hoisted(() =>
  vi.fn<(updater: (current: Settings) => Partial<Settings>) => void>(),
)

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getPinnedNotes,
  hasWikiEntries,
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir, openUrl }))
vi.mock('@tauri-apps/api/path', () => ({
  join: async (...parts: string[]) => parts.join('/'),
}))
const runCopyDeepLink = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/note-deep-link.ts', () => ({ runCopyDeepLink }))
vi.mock('@/lib/windows/open-in-new-window.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/windows/open-in-new-window.ts')>()),
  openRouteInNewWindow,
}))
vi.mock('@/lib/native-menu/context-menu.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/native-menu/context-menu.ts')>()),
  openNativeContextMenu,
}))

vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({
    graph: GRAPH,
    recents: [
      { root: '/notes', name: 'Notes', openedMs: 2 },
      { root: '/work', name: 'Work', openedMs: 1 },
    ],
    indexing: false,
    openRecent,
    pickAndOpen,
    chooseGraph,
  }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      dateFormat: 'mdy',
      graphColors: {},
      wikiLanguages: [
        { label: 'English', folder: 'wiki' },
        { label: '简体中文', folder: 'wiki-cn' },
      ],
    },
    updateSettings: () => {},
    updateSettingsWith,
  }),
}))
vi.mock('@/providers/sync-provider.tsx', () => ({
  useSyncContext: () => null,
  useSync: () => ({
    backup: { phase: 'disconnected' },
    connectNewRepo: async () => {},
    connectExistingRepo: async () => 'connected',
    disconnectGraph: async () => {},
    signOut: async () => {},
    backUpNow: async () => {},
  }),
}))

const audioMemo = vi.hoisted(() => ({
  phase: 'idle' as const,
  elapsedMs: 0,
  stream: null,
  available: true,
  unavailableReason: null as string | null,
  error: null,
  canRetry: false,
  toggle: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  discard: vi.fn(),
}))
vi.mock('@/providers/audio-memo-provider.tsx', () => ({
  useAudioMemo: () => audioMemo,
}))
const createNoteFromFiles = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/create-note-from-files.ts', () => ({ createNoteFromFiles }))

const GRAPH: GraphInfo = {
  root: '/notes',
  name: 'Notes',
  generation: 1,
  localOnlyFolders: [],
  localOnlyEditableFolders: [],
}

const RUST_PIN: PinnedNote = {
  isPrivate: false,
  hasConflict: false,
  path: 'notes/rust.md',
  title: 'Rust',
  dailyDate: null,
}

// Import after the core mock so the command registry sees the mocked module.
const { Sidebar } = await import('./sidebar.tsx')
const { registerAppCommands } = await import('@/lib/commands/app-commands.ts')
registerAppCommands()

beforeEach(() => {
  // The hoisted mock is shared module state — restore it so mic-related cases
  // can't inherit mutations from earlier tests.
  getPinnedNotes.mockReset().mockResolvedValue([])
  hasWikiEntries.mockReset().mockResolvedValue(false)
  audioMemo.available = true
  audioMemo.unavailableReason = null
  audioMemo.toggle.mockReset()
  revealItemInDir.mockClear()
  openUrl.mockClear()
  openRouteInNewWindow.mockReset().mockResolvedValue(true)
  openRecent.mockClear()
  pickAndOpen.mockClear()
  chooseGraph.mockClear()
  updateSettingsWith.mockClear()
  openNativeContextMenu.mockClear()
  menuChoice.text = 'Unpin Note'
  runCopyDeepLink.mockClear()
  operationFail.mockClear()
  startOperation.mockClear()
  commitNoteFrontmatter.mockClear()
})

/** Shows the peeked note's path, standing in for the peek panel. */
function PeekProbe() {
  const target = usePeek()?.target
  return <output aria-label="Peeked note">{target?.path ?? ''}</output>
}

async function renderSidebar(
  overrides?: Partial<CommandContext>,
  initialRoute?: Route,
  { peek = false }: { peek?: boolean } = {},
) {
  const navigate = vi.fn()
  const openPalette = vi.fn()
  const context: CommandContext = {
    navigate,
    route: () => ({ kind: 'today' }),
    notePath: () => null,
    back: vi.fn(),
    forward: vi.fn(),
    clearScrollState: vi.fn(),
    togglePin: vi.fn(async () => {}),
    togglePrivate: vi.fn(async () => {}),
    toggleTheme: vi.fn(),
    toggleSidebar: vi.fn(),
    newChat: vi.fn(),
    openNoteFind: vi.fn(),
    findNextInNote: vi.fn(),
    findPreviousInNote: vi.fn(),
    switchGraph: vi.fn(),
    openPinnedNote: vi.fn(),
    toggleAudioMemo: vi.fn(),
    generation: () => 1,
    graphRoot: () => '/notes',
    openPalette,
    openShortcuts: vi.fn(),
    openTemplatePicker: vi.fn(),
    openHeadingPicker: vi.fn(),
    openTemplateCreate: vi.fn(),
    enableSemanticSearch: vi.fn(),
    sortAllNotes: vi.fn(),
    wikiLanguages: () => [],
    ...overrides,
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The app constrains the sidebar to its rail width; without it the graph
  // menu's anchor spans the viewport and popper pushes the submenu off-screen.
  const view = await render(
    <div style={{ width: 260, height: 560 }}>
      <TooltipProvider>
        <QueryClientProvider client={client}>
          <UpdateProvider autoCheck={false}>
            <RouterProvider initialRoute={initialRoute}>
              <PeekProvider enabled={peek}>
                <Sidebar graph={GRAPH} context={context} />
                <PeekProbe />
              </PeekProvider>
            </RouterProvider>
          </UpdateProvider>
        </QueryClientProvider>
      </TooltipProvider>
    </div>,
  )
  return { view, navigate, openPalette, context }
}

describe('Sidebar', () => {
  it('nav rows navigate, with Daily notes always re-anchoring to today', async () => {
    const { view, navigate } = await renderSidebar(undefined, { kind: 'settings' })

    // The Daily row shares the ⌘D capture command: omitting
    // `restoreSurfaceScroll` makes even an off-surface return discard the
    // stream's saved position and re-anchor on today.
    await view.getByRole('button', { name: /daily notes/i }).click()
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'today' }, { focusEditor: true }),
    )

    await view.getByRole('button', { name: /settings/i }).click()
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'settings' }))

    await view.getByRole('button', { name: /chat/i }).click()
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'chat' }))
  })

  it('New note runs its command and shows active while the placeholder note is open', async () => {
    // The route a ⌘N/new-note click lands on: a fresh ULID placeholder path.
    const { view, navigate } = await renderSidebar(undefined, {
      kind: 'note',
      path: untitledNotePath(),
    })
    const newNote = view.getByRole('button', { name: /new note/i })

    // Active like every other row whose route is current — until the birth
    // rename moves the note onto a title slug.
    await expect.element(newNote).toHaveAttribute('aria-current', 'page')

    await newNote.click()
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'note', path: expect.stringMatching(/^notes\/.+\.md$/) }),
      ),
    )
  })

  it('New note is inactive on slug-named note routes', async () => {
    const { view } = await renderSidebar(undefined, { kind: 'note', path: 'notes/meeting.md' })
    await expect
      .element(view.getByRole('button', { name: /new note/i }))
      .not.toHaveAttribute('aria-current')
  })

  it('All notes stays active while editing a slug-named note', async () => {
    const { view } = await renderSidebar(undefined, { kind: 'note', path: 'notes/meeting.md' })
    await expect
      .element(view.getByRole('button', { name: /all notes/i }))
      .toHaveAttribute('aria-current', 'page')
  })

  it('Attachments opens the library and lights alone while it is open', async () => {
    const { view, navigate } = await renderSidebar(undefined, {
      kind: 'attachments',
      type: null,
      tag: null,
    })
    const attachments = view.getByRole('button', { name: /attachments/i })

    await expect.element(attachments).toHaveAttribute('aria-current', 'page')
    await expect
      .element(view.getByRole('button', { name: /all notes/i }))
      .not.toHaveAttribute('aria-current')

    await attachments.click()
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'attachments', type: null, tag: null }),
    )
  })

  it('only "New note" — not "All notes" — lights for the untitled placeholder', async () => {
    // A brand-new note is still an untitled placeholder, so the two rows must
    // never light at once.
    const { view } = await renderSidebar(undefined, { kind: 'note', path: untitledNotePath() })
    await expect
      .element(view.getByRole('button', { name: /new note/i }))
      .toHaveAttribute('aria-current', 'page')
    await expect
      .element(view.getByRole('button', { name: /all notes/i }))
      .not.toHaveAttribute('aria-current')
  })

  it('shows Wiki below All notes only for a graph with a wiki, opening the Wiki screen', async () => {
    const without = await renderSidebar(undefined, { kind: 'settings' })
    await vi.waitFor(() => expect(hasWikiEntries).toHaveBeenCalled())
    expect(without.view.getByRole('button', { name: 'Wiki', exact: true }).query()).toBeNull()
    await without.view.unmount()

    hasWikiEntries.mockResolvedValue(true)
    const { view, navigate } = await renderSidebar(undefined, { kind: 'settings' })
    const wiki = view.getByRole('button', { name: 'Wiki', exact: true })
    await expect.element(wiki).toBeInTheDocument()

    const rows = view.getByRole('navigation', { name: 'Primary' }).getByRole('button').elements()
    const allNotes = rows.indexOf(
      view.getByRole('button', { name: 'All notes', exact: true }).element(),
    )
    expect(rows[allNotes + 1]).toBe(wiki.element())

    await wiki.click()
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ kind: 'wiki', filter: null, language: null }),
    )
  })

  it('lights Wiki, not All notes, while a wiki entry or its translation is open', async () => {
    hasWikiEntries.mockResolvedValue(true)
    const { view } = await renderSidebar(undefined, {
      kind: 'note',
      path: 'wiki-cn/memory/Spacing Effect.md',
    })

    await expect
      .element(view.getByRole('button', { name: 'Wiki', exact: true }))
      .toHaveAttribute('aria-current', 'page')
    await expect
      .element(view.getByRole('button', { name: /all notes/i }))
      .not.toHaveAttribute('aria-current')
  })

  it('the search affordance opens the palette', async () => {
    const { view, openPalette } = await renderSidebar()
    await view.getByRole('button', { name: /search anything/i }).click()
    expect(openPalette).toHaveBeenCalled()
  })

  it('the mic button starts an audio memo', async () => {
    const { view } = await renderSidebar()
    await view.getByRole('button', { name: /record audio memo/i }).click()
    expect(audioMemo.toggle).toHaveBeenCalled()
  })

  it('the mic button disables (without vanishing) when no provider can transcribe', async () => {
    audioMemo.available = false
    audioMemo.unavailableReason = 'Add an OpenAI or Gemini model in Settings to record audio memos'
    const { view } = await renderSidebar()
    const micButton = view.getByRole('button', { name: /record audio memo/i })
    await expect.element(micButton).toHaveAttribute('aria-disabled', 'true')
    // `aria-disabled` fails Playwright's enabled actionability check, but the
    // element still receives real clicks — force past the check.
    await micButton.click({ force: true })
    expect(audioMemo.toggle).not.toHaveBeenCalled()
  })

  it('pinned notes render their own section', async () => {
    getPinnedNotes.mockResolvedValue([
      {
        isPrivate: false,
        hasConflict: false,
        path: 'notes/roadmap.md',
        title: 'Roadmap',
        dailyDate: null,
      },
    ])
    const { view } = await renderSidebar()

    const pinnedSection = view.getByRole('region', { name: /pinned notes/i })
    await expect.element(pinnedSection).toMatchTextContent('Roadmap')
    await expectLocatorToHaveCount(view.getByRole('button', { name: 'Roadmap' }), 1)

    const roadmap = pinnedSection.getByRole('button', { name: 'Roadmap' })
    await expect.element(roadmap).toBeInTheDocument()
    const roadmapPreview = roadmap.element().firstElementChild
    expect(roadmapPreview?.getAttribute('class')).toContain('hover:bg-surface-hover')
    expect(roadmapPreview?.getAttribute('class')).toContain('hover:text-text')
    await roadmap.click()
    await expect.element(roadmap).toHaveAttribute('aria-current', 'page')
    expect(roadmapPreview?.getAttribute('class')).toContain('dark:text-accent')
  })

  it.each([
    { isPrivate: true, hasConflict: false, label: 'Private' },
    { isPrivate: false, hasConflict: true, label: 'Protected' },
  ])('keeps $label pinned notes title-only', async ({ isPrivate, hasConflict }) => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/roadmap.md', title: 'Roadmap', dailyDate: null, isPrivate, hasConflict },
    ])
    const { view } = await renderSidebar()
    const roadmap = view.getByRole('button', { name: 'Roadmap', exact: true })
    await expect.element(roadmap).toBeVisible()
    expect(roadmap.element().querySelector('[role="img"]')).toBeNull()
    expect(roadmap.element().querySelector('button')).toBeNull()
    await roadmap.click()
    await expect.element(roadmap).toHaveAttribute('aria-current', 'page')
  })

  it('assigns floating number hints to only the first ten pinned notes', async () => {
    getPinnedNotes.mockResolvedValue(
      Array.from({ length: 11 }, (_, index) => ({
        path: `notes/pin-${index + 1}.md`,
        title: `Pin ${index + 1}`,
        dailyDate: null,
        isPrivate: false,
        hasConflict: false,
      })),
    )
    const { view } = await renderSidebar()
    const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']

    for (const [index, digit] of digits.entries()) {
      const row = view.getByRole('button', { name: `Pin ${index + 1}`, exact: true })
      await expect.element(row).toBeInTheDocument()
      const hint = row.element().querySelector('span[aria-hidden="true"]')
      expect(hint).not.toBeNull()
      expect(hint?.textContent).toMatch(new RegExp(`${digit}$`))
    }
    const last = view.getByRole('button', { name: 'Pin 11', exact: true })
    await expect.element(last).toBeInTheDocument()
    expect(last.element().querySelector('span[aria-hidden="true"]')).toBeNull()
  })

  it('modifier-click opens a pinned note in a new window without changing routes', async () => {
    getPinnedNotes.mockResolvedValue([
      {
        isPrivate: false,
        hasConflict: false,
        path: 'notes/roadmap.md',
        title: 'Roadmap',
        dailyDate: null,
      },
    ])
    const { view } = await renderSidebar()
    const roadmap = view.getByRole('button', { name: 'Roadmap' })

    await roadmap.click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({
        kind: 'note',
        path: 'notes/roadmap.md',
      }),
    )
    expect(openRouteInNewWindow).toHaveBeenCalledTimes(1)
    await expect.element(roadmap).not.toHaveAttribute('aria-current')
  })

  it('renders wiki links in pinned note titles as display text', async () => {
    getPinnedNotes.mockResolvedValue([
      {
        isPrivate: false,
        hasConflict: false,
        path: 'notes/meeting.md',
        title: 'Meeting with [[Ada Lovelace|Ada]]',
        dailyDate: null,
      },
    ])
    const { view } = await renderSidebar()

    const pinnedSection = view.getByRole('region', { name: /pinned notes/i })
    await expect.element(pinnedSection).toMatchTextContent('Meeting with Ada')
    expect(pinnedSection.element().textContent).not.toContain('[[Ada Lovelace|Ada]]')
    await expect.element(view.getByRole('button', { name: 'Meeting with Ada' })).toBeInTheDocument()
  })

  it('All notes is inactive while the active note is pinned', async () => {
    getPinnedNotes.mockResolvedValue([
      {
        isPrivate: false,
        hasConflict: false,
        path: 'notes/roadmap.md',
        title: 'Roadmap',
        dailyDate: null,
      },
    ])
    const { view } = await renderSidebar(undefined, { kind: 'note', path: 'notes/roadmap.md' })

    const roadmap = view.getByRole('button', { name: 'Roadmap' })
    await expect.element(roadmap).toHaveAttribute('aria-current', 'page')
    await expect
      .element(view.getByRole('button', { name: /all notes/i }))
      .not.toHaveAttribute('aria-current')
  })

  it('the pinned section is hidden while nothing is pinned', async () => {
    getPinnedNotes.mockResolvedValue([])
    const { view } = await renderSidebar()
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalled())
    expect(view.getByRole('region', { name: /pinned notes/i }).query()).toBeNull()
  })

  it('right-click unpins a pinned row through the native context menu', async () => {
    getPinnedNotes.mockResolvedValue([
      {
        isPrivate: false,
        hasConflict: false,
        path: 'notes/rust.md',
        title: 'Rust',
        dailyDate: null,
      },
    ])
    const { view } = await renderSidebar()
    const rust = view.getByRole('button', { name: 'Rust' })

    await rust.click({ button: 'right' })

    await vi.waitFor(() => expect(openNativeContextMenu).toHaveBeenCalledOnce())
    expect(menuLabels().at(-1)).toBe('Unpin Note')
    await expectLocatorToHaveCount(view.getByRole('button', { name: 'Rust' }), 0)
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/rust.md', { pinned: false }, 1)
  })

  it('the pinned row menu groups opening, outward links, and Unpin', async () => {
    getPinnedNotes.mockResolvedValue([RUST_PIN])
    const { view } = await renderSidebar(undefined, undefined, { peek: true })
    menuChoice.text = ''

    await view.getByRole('button', { name: 'Rust' }).click({ button: 'right' })

    await vi.waitFor(() => expect(openNativeContextMenu).toHaveBeenCalledOnce())
    expect(menuLabels()).toEqual([
      'Open in Peek',
      'Open in New Window',
      null,
      'Copy Deep Link',
      'Reveal in Finder',
      null,
      'Unpin Note',
    ])
  })

  it('leaves Open in Peek out of the menu where the window has no peek panel', async () => {
    getPinnedNotes.mockResolvedValue([RUST_PIN])
    const { view } = await renderSidebar()
    menuChoice.text = ''

    await view.getByRole('button', { name: 'Rust' }).click({ button: 'right' })

    await vi.waitFor(() => expect(openNativeContextMenu).toHaveBeenCalledOnce())
    expect(menuLabels()).not.toContain('Open in Peek')
  })

  it('Open in Peek floats the pinned note over the editor without navigating', async () => {
    getPinnedNotes.mockResolvedValue([RUST_PIN])
    const { view } = await renderSidebar(undefined, undefined, { peek: true })
    menuChoice.text = 'Open in Peek'

    await view.getByRole('button', { name: 'Rust' }).click({ button: 'right' })

    await expect
      .element(view.getByRole('status', { name: 'Peeked note' }))
      .toHaveTextContent('notes/rust.md')
    await expect
      .element(view.getByRole('button', { name: 'Rust' }))
      .not.toHaveAttribute('aria-current')
  })

  it('shift-click peeks a pinned note, matching the palette', async () => {
    getPinnedNotes.mockResolvedValue([RUST_PIN])
    const { view } = await renderSidebar(undefined, undefined, { peek: true })

    await view.getByRole('button', { name: 'Rust' }).click({ modifiers: ['Shift'] })

    await expect
      .element(view.getByRole('status', { name: 'Peeked note' }))
      .toHaveTextContent('notes/rust.md')
    await expect
      .element(view.getByRole('button', { name: 'Rust' }))
      .not.toHaveAttribute('aria-current')
  })

  it('Open in New Window opens the pinned note in its own window', async () => {
    getPinnedNotes.mockResolvedValue([RUST_PIN])
    const { view } = await renderSidebar()
    menuChoice.text = 'Open in New Window'

    await view.getByRole('button', { name: 'Rust' }).click({ button: 'right' })

    await vi.waitFor(() =>
      expect(openRouteInNewWindow).toHaveBeenCalledWith({ kind: 'note', path: 'notes/rust.md' }),
    )
  })

  it('Copy Deep Link copies the pinned note address', async () => {
    getPinnedNotes.mockResolvedValue([RUST_PIN])
    const { view } = await renderSidebar()
    menuChoice.text = 'Copy Deep Link'

    await view.getByRole('button', { name: 'Rust' }).click({ button: 'right' })

    await vi.waitFor(() => expect(runCopyDeepLink).toHaveBeenCalledWith('notes/rust.md', 1))
  })

  it('Reveal in Finder shows the pinned note file in the system file manager', async () => {
    getPinnedNotes.mockResolvedValue([RUST_PIN])
    const { view } = await renderSidebar()
    menuChoice.text = 'Reveal in Finder'

    await view.getByRole('button', { name: 'Rust' }).click({ button: 'right' })

    await vi.waitFor(() =>
      expect(revealItemInDir).toHaveBeenCalledExactlyOnceWith('/notes/notes/rust.md'),
    )
  })

  it('restores an optimistically removed pinned row when unpin fails', async () => {
    commitNoteFrontmatter.mockRejectedValueOnce(new Error('disk failed'))
    getPinnedNotes.mockResolvedValue([
      {
        isPrivate: false,
        hasConflict: false,
        path: 'notes/rust.md',
        title: 'Rust',
        dailyDate: null,
      },
    ])
    const { view } = await renderSidebar()
    const rust = view.getByRole('button', { name: 'Rust' })

    await rust.click({ button: 'right' })

    await vi.waitFor(() =>
      expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/rust.md', { pinned: false }, 1),
    )
    await expect.element(view.getByRole('button', { name: 'Rust' })).toBeInTheDocument()
    expect(startOperation).toHaveBeenCalledExactlyOnceWith('Updating pin')
    expect(operationFail).toHaveBeenCalledExactlyOnceWith('disk failed')
  })

  it('history arrows walk the router stack and disable at its edges', async () => {
    getPinnedNotes.mockResolvedValue([
      {
        isPrivate: false,
        hasConflict: false,
        path: 'notes/rust.md',
        title: 'Rust',
        dailyDate: null,
      },
    ])
    const { view } = await renderSidebar()
    const backButton = view.getByRole('button', { name: 'Go back' })
    const forwardButton = view.getByRole('button', { name: 'Go forward' })
    await expect.element(backButton).toBeDisabled()
    await expect.element(forwardButton).toBeDisabled()

    // Pinned rows push onto the real router, enabling history navigation.
    const rust = view.getByRole('button', { name: 'Rust' })
    await rust.click()
    await expect.element(backButton).toBeEnabled()

    await backButton.click()
    await expect.element(rust).not.toHaveAttribute('aria-current')
    await expect.element(forwardButton).toBeEnabled()

    await forwardButton.click()
    await expect.element(rust).toHaveAttribute('aria-current', 'page')
  })

  it('the graph footer switches to another recent graph', async () => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    const work = page.getByRole('menuitem', { name: 'Work', exact: true })
    await expect.element(work).toBeVisible()
    expect(work.element().querySelector('kbd')).toBeNull()
    await work.click()
    expect(openRecent).toHaveBeenCalledWith('/work')

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: /open another graph/i }).click()
    expect(chooseGraph).toHaveBeenCalled()
    expect(pickAndOpen).not.toHaveBeenCalled()
  })

  it('the graph footer opens preferences from the graph menu', async () => {
    const { view, navigate } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: 'Preferences' }).click()

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith({ kind: 'settings' }))
  })

  it('the graph menu offers the iOS app and browser extension in their stores', async () => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: 'Get Reflect apps…' }).click()

    const dialog = page.getByRole('dialog', { name: 'Take Reflect with you' })
    await expect.element(dialog).toBeVisible()
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument()

    await dialog.getByRole('button', { name: 'Get iOS app' }).click()
    expect(openUrl).toHaveBeenNthCalledWith(
      1,
      'https://apps.apple.com/us/app/reflect-open/id6787385615',
    )
    await dialog.getByRole('button', { name: 'Get Chrome extension' }).click()
    expect(openUrl).toHaveBeenNthCalledWith(
      2,
      'https://chromewebstore.google.com/detail/reflect-capture/ccabifmooehighoonjeiololjfofkhkd',
    )

    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect.element(dialog).not.toBeInTheDocument()
  })

  it('opens the apps dialog from the keyboard and restores graph focus on Escape', async () => {
    const { view } = await renderSidebar()
    const graphTrigger = view.getByRole('button', { name: /Notes/ })
    graphTrigger.element().focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard('Get Reflect apps')
    await expect.element(page.getByRole('menuitem', { name: 'Get Reflect apps…' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    const dialog = page.getByRole('dialog', { name: 'Take Reflect with you' })
    await expect.element(dialog).toBeVisible()
    await vi.waitFor(() => expect(dialog.element().contains(document.activeElement)).toBe(true))

    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    await expect.element(graphTrigger).toHaveFocus()

    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByRole('menuitem', { name: 'Get Reflect apps…' })).toBeVisible()
  })

  it('the graph footer opens the current graph in the system file manager', async () => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await page.getByRole('menuitem', { name: /reveal graph in finder/i }).click()

    expect(revealItemInDir).toHaveBeenCalledWith('/notes')
  })

  it.each([
    { name: 'Notes', root: '/notes' },
    { name: 'Work', root: '/work' },
  ])('recolors $name from its swatch without switching graphs', async ({ name, root }) => {
    const { view } = await renderSidebar()

    await view.getByRole('button', { name: /Notes/ }).click()
    await expect
      .element(page.getByRole('menuitem', { name: 'Graph color', exact: true }))
      .not.toBeInTheDocument()
    await page.getByRole('menuitem', { name: `Change color for ${name}` }).click()
    await expect
      .element(page.getByRole('menuitemradio', { name: 'Indigo' }))
      .toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemradio', { name: 'Teal' }).click()
    await expect.element(page.getByRole('menuitemradio', { name: 'Teal' })).not.toBeInTheDocument()
    expect(updateSettingsWith).toHaveBeenCalledTimes(1)
    expect(openRecent).not.toHaveBeenCalled()

    const updater = updateSettingsWith.mock.lastCall?.[0]
    expect(updater?.({ ...DEFAULT_SETTINGS, graphColors: { '/other': 'red' } })).toEqual({
      graphColors: { '/other': 'red', [root]: 'teal' },
    })
  })

  it('opens and dismisses a graph color menu from the keyboard', async () => {
    const { view } = await renderSidebar()
    view.getByRole('button', { name: /Notes/ }).element().focus()
    await userEvent.keyboard('{ArrowDown}')
    const swatch = page.getByRole('menuitem', { name: 'Change color for Notes' })
    await expect.element(swatch).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByRole('menuitemradio', { name: 'Indigo' })).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(swatch).toHaveFocus()
    await expect.element(swatch).toBeVisible()
    expect(updateSettingsWith).not.toHaveBeenCalled()

    await userEvent.keyboard('{ArrowRight}')
    await expect.element(page.getByRole('menuitemradio', { name: 'Indigo' })).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(page.getByRole('menuitemradio', { name: 'Blue' })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() => expect(updateSettingsWith).toHaveBeenCalledTimes(1))
    expect(updateSettingsWith.mock.lastCall?.[0](DEFAULT_SETTINGS)).toEqual({
      graphColors: { '/notes': 'blue' },
    })
    expect(openRecent).not.toHaveBeenCalled()
  })

  it('turns files dropped on it into a new note', async () => {
    const { view, navigate } = await renderSidebar()
    const nav = view.getByRole('navigation', { name: 'Primary' }).element()
    const transfer = new DataTransfer()
    transfer.items.add(new File(['x'], 'Report.pdf', { type: 'application/pdf' }))

    nav.dispatchEvent(
      new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    )
    await expect.element(view.getByText('Drop to create a note')).toBeInTheDocument()

    nav.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    )
    await vi.waitFor(() =>
      expect(createNoteFromFiles).toHaveBeenCalledWith([expect.any(File)], 1, navigate),
    )
    expect(view.getByText('Drop to create a note').query()).toBeNull()
  })
})
