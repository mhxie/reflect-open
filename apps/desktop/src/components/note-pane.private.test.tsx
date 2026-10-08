import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge, type NoteRow } from '@reflect/core'
import type { resolveArchivedPost } from '@reflect/core/x-archive'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { toggleNotePrivate } from '@/lib/note-private.ts'
import { queryClient } from '@/lib/query-client.ts'
import type { Route } from '@/routing/route.ts'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { RouteContent } from './route-content.tsx'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
const getNote = vi.hoisted(() => vi.fn<(path: string) => Promise<NoteRow | undefined>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: async () => ({ contexts: [], nextCursor: null, indexedLinkCount: 0 }),
  relatedNotes: async () => [],
  // The graph's local-only folders are `secure`, read-only.
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
  isLocalOnlyReadOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
  getNote,
}))
const requestNoteMenu = vi.hoisted(() => vi.fn<(path: string) => void>())
vi.mock('@/editor/status/note-menu-request.ts', () => ({ requestNoteMenu }))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 }, indexing: false }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
      statusBarEnabled: true,
      editorMarkdownSyntax: 'hide',
      allNotesFilterTags: [],
      wikiLanguages: [{ label: 'English', folder: 'wiki' }],
      aiProviders: [],
      defaultAiProviderId: null,
      chatSystemPrompt: '',
      aiPrompts: [],
    },
    updateSettings: async () => {},
    updateSettingsWith: () => {},
  }),
}))

type ResolvedArchive = Awaited<ReturnType<typeof resolveArchivedPost>>

const X_URL = 'https://x.com/jack/status/101'
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
// A saved card whose poster would load from the network if it rendered.
const SAVED_YOUTUBE = `![](${YOUTUBE_URL})<!-- ${JSON.stringify({
  snapshot: {
    kind: 'youtube-video',
    data: {
      url: YOUTUBE_URL,
      title: 'Big Buck Bunny',
      author_name: 'Blender',
      author_url: 'https://www.youtube.com/@Blender',
      thumbnail_url: 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
      thumbnail_width: 480,
      thumbnail_height: 360,
      width: 200,
      height: 113,
    },
  },
})} -->`
const REMOTE_BODY = `Body\n\n![](${X_URL})\n\n${SAVED_YOUTUBE}\n\n![chart](https://example.com/chart.png)\n`
/** What reaches the network, or writes the X archive, on a note's behalf. */
const REMOTE_COMMANDS = [
  'x_archive_resolve',
  'x_syndication_fetch',
  'x_archive_write',
  'capture_oembed_fetch',
]

let files: Record<string, string>
let commands: string[]
let client: QueryClient
let navigate: ((route: Route) => void) | null = null
const resolveArchive = vi.fn<(postId: string) => Promise<ResolvedArchive>>()

function noteRow(path: string, isPrivate: boolean): NoteRow {
  return {
    path,
    title: '',
    dailyDate: null,
    isPrivate,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
  }
}

function archivedPost(id: string, text: string): NonNullable<ResolvedArchive> {
  return {
    archive: {
      kind: 'x-post',
      capturedAt: '2026-09-14T00:00:00Z',
      data: {
        id,
        createdAt: '2026-09-14T00:00:00Z',
        author: { name: 'Jack', handle: 'jack' },
        body: [{ type: 'text', text }],
      },
    },
    resources: [],
  }
}

beforeEach(() => {
  files = {}
  commands = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  getNote.mockImplementation(async (path) => noteRow(path, false))
  resolveArchive.mockImplementation(async (postId) => archivedPost(postId, 'Archived post'))
  setBridge({
    invoke: async (command, args) => {
      commands.push(command)
      if (command === 'note_read') return files[String(args.path)]
      if (command === 'note_write') {
        files[String(args.path)] = String(args.contents)
        return null
      }
      if (command === 'x_archive_resolve') return await resolveArchive(String(args.postId))
      if (command === 'db_query') return []
      return null
    },
    listen: async () => () => {},
  })
})

afterEach(async () => {
  await cleanup()
  setBridge(null)
  queryClient.clear()
  vi.resetAllMocks()
  navigate = null
})

/** Exposes the router's navigate, so a test can move one pane between notes. */
function Navigator(): null {
  navigate = useRouter().navigate
  return null
}

function renderNote(path: string) {
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'note', path }}>
        <PaletteProvider>
          <Navigator />
          <RouteContent />
        </PaletteProvider>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function openNote(path: string): void {
  if (navigate === null) {
    throw new Error('the router has not rendered')
  }
  navigate({ kind: 'note', path })
}

/**
 * Record each remote image and each editable surface showing `text` that
 * enters the page until the returned stop runs, including any that lives for
 * a single frame only.
 */
function watchInsertions(text: string): () => string[] {
  const seen: string[] = []
  const record = (element: Element): void => {
    for (const image of [element, ...element.querySelectorAll('img')]) {
      const source = image instanceof HTMLImageElement ? (image.getAttribute('src') ?? '') : ''
      if (/^https?:/i.test(source)) {
        seen.push(`img ${source}`)
      }
    }
    const editable =
      element.closest('[contenteditable="true"]') ??
      element.querySelector('[contenteditable="true"]')
    if (editable?.textContent?.includes(text)) {
      seen.push(`editable showing "${text}"`)
    }
  }
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.target instanceof Element && mutation.type === 'attributes') {
        record(mutation.target)
      }
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          record(node)
        }
      }
    }
  })
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  })
  return () => {
    observer.disconnect()
    return seen
  }
}

function editable(): Element | null {
  return document.querySelector('[contenteditable="true"]')
}

function remoteElements(): Element | null {
  return document.querySelector(
    'img[src^="https:"], img[src^="http:"], iframe, meowdown-embed-x, meowdown-embed-youtube',
  )
}

it('opens a locked note in the editor with nothing remote', async () => {
  files['notes/locked.md'] = `---\nprivate: true\n---\n# Locked\n\n${REMOTE_BODY}`
  getNote.mockImplementation(async (path) => noteRow(path, true))
  const view = await renderNote('notes/locked.md')

  const links = page.getByTestId('embed-link')
  await expect.element(links.first()).toHaveTextContent(X_URL)
  await expect.element(links.last()).toHaveTextContent(YOUTUBE_URL)
  // The source URL is what the reader sees in place of the card.
  await expect.element(links.first()).toBeVisible()
  await expect.element(links.last()).toBeVisible()
  expect(editable()).not.toBeNull()
  expect(remoteElements()).toBeNull()
  for (const command of REMOTE_COMMANDS) {
    expect(commands).not.toContain(command)
  }
  await view.unmount()
})

it('marks a private note above its title and opens its status menu from there', async () => {
  files['notes/locked.md'] = `---\nprivate: true\n---\n# Locked\n`
  getNote.mockImplementation(async (path) => noteRow(path, true))
  const view = await renderNote('notes/locked.md')

  const notice = page.getByRole('button', { name: 'Private note: show note details' })
  await expect.element(notice).toHaveTextContent('Private · never sent to AI or other services')
  await notice.click()
  expect(requestNoteMenu).toHaveBeenCalledWith('notes/locked.md')
  await view.unmount()
})

it('treats a note whose live header is locked as private while its row says public', async () => {
  files['notes/locked.md'] = `---\nprivate: true\n---\n# Locked\n\n${REMOTE_BODY}`
  const view = await renderNote('notes/locked.md')

  await expect.element(page.getByTestId('embed-link').first()).toHaveTextContent(X_URL)
  expect(remoteElements()).toBeNull()
  for (const command of REMOTE_COMMANDS) {
    expect(commands).not.toContain(command)
  }
  await view.unmount()
})

it('switches the policy live on a Lock toggle, without remounting the editor', async () => {
  const path = 'notes/tweets.md'
  files[path] = `# Tweets\n\n![](${X_URL})\n`
  const view = await renderNote(path)
  await expect.element(page.getByText('Archived post')).toBeVisible()
  const editor = editable()
  expect(editor).not.toBeNull()

  const beforeLock = commands.length
  await toggleNotePrivate({ queryClient: client, root: '/g', generation: 1, path })
  await expect.element(page.getByTestId('embed-link')).toHaveTextContent(X_URL)
  expect(remoteElements()).toBeNull()
  expect(editable()).toBe(editor)
  await vi.waitFor(() =>
    expect(files[path]).toBe(`---\nprivate: true\n---\n\n# Tweets\n\n![](${X_URL})\n`),
  )
  for (const command of REMOTE_COMMANDS) {
    expect(commands.slice(beforeLock)).not.toContain(command)
  }

  await expect.element(page.getByTestId('private-note-notice')).toBeVisible()

  await toggleNotePrivate({ queryClient: client, root: '/g', generation: 1, path })
  await expect.element(page.getByText('Archived post')).toBeVisible()
  expect(page.getByTestId('embed-link').query()).toBeNull()
  expect(page.getByTestId('private-note-notice').query()).toBeNull()
  expect(editable()).toBe(editor)
  await view.unmount()
})

const SECRET = 'secret words'

/**
 * Open a public note, then a local-only one holding `remote`, so the public
 * note's row is cached when the pane goes back to it (its policy is known at
 * once). Returns the number of bridge calls made before the pane leaves the
 * local-only note.
 */
async function visitLocalOnlyNote(remote: string): Promise<number> {
  files['notes/public.md'] = '# Public\n\nhello public\n'
  files['secure/a.md'] = `# Secret\n\n${SECRET}\n\n${remote}\n`
  getNote.mockImplementation(async (path) => noteRow(path, path.startsWith('secure/')))
  await renderNote('notes/public.md')
  await expect.element(page.getByText('hello public')).toBeVisible()
  openNote('secure/a.md')
  await expect.element(page.getByTestId('local-only-sheet')).toBeVisible()
  await expect.element(page.getByText(SECRET)).toBeVisible()
  return commands.length
}

it('never looks up a local-only note’s X posts for the note the pane opens next', async () => {
  const beforeLeaving = await visitLocalOnlyNote('![](https://x.com/jack/status/999)')

  openNote('notes/public.md')
  await expect.element(page.getByText('hello public')).toBeVisible()
  for (const command of REMOTE_COMMANDS) {
    expect(commands.slice(beforeLeaving)).not.toContain(command)
  }
})

it('never shows a local-only note in an editor for the note the pane opens next', async () => {
  await visitLocalOnlyNote('![chart](https://example.com/secret-chart.png)')

  const stop = watchInsertions(SECRET)
  openNote('notes/public.md')
  await expect.element(page.getByText('hello public')).toBeVisible()
  expect(stop()).toEqual([])
})
