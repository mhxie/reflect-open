import { page } from 'vitest/browser'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { createRef, useLayoutEffect, type RefObject } from 'react'
import type { IndexQueryService, NoteRow } from '@reflect/core'
import type { ResolvedArchivedPost } from '@reflect/core/x-archive'
import {
  createTestCoreServices,
  createTestNoteFileService,
  type TestCoreServices,
  type TestNoteFileService,
} from '@reflect/core/testing'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { useNoteMenuRequest } from '@/editor/status/note-menu-request.ts'
import { toggleNotePrivate } from '@/lib/note-privacy-toast.ts'
import { queryClient } from '@/lib/query-client.ts'
import { useRouter, type RouterNavigate } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { RouteContent } from './route-content.tsx'

type ResolvedArchive = ResolvedArchivedPost | null

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

// The app of the rendered pane; set by `renderNote`.
let app: TestCoreServices
let noteFile: TestNoteFileService
const navigateRef: RefObject<RouterNavigate | null> = createRef()
const getNote = vi.fn<IndexQueryService['getNote']>()
const resolveArchive = vi.fn<(postId: string) => Promise<ResolvedArchive>>()

function noteRow(path: string, isPrivate: boolean): NoteRow {
  return {
    path,
    title: '',
    dailyDate: null,
    isPrivate,
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
  navigateRef.current = null
  getNote.mockReset().mockImplementation((path) => Promise.resolve(noteRow(path, false)))
  resolveArchive
    .mockReset()
    .mockImplementation((postId) => Promise.resolve(archivedPost(postId, 'Archived post')))
})

/** Exposes the router's navigate, so a test can move one pane between notes. */
function Navigator(): null {
  const { navigate } = useRouter()

  useLayoutEffect(() => {
    navigateRef.current = navigate
    return () => {
      navigateRef.current = null
    }
  }, [navigate])

  return null
}

/** The newest status-menu request for `path`, as the status bar would see it. */
function MenuRequestProbe({ path }: { path: string }) {
  const request = useNoteMenuRequest(path)
  return <output data-testid="menu-request">{request ?? 'none'}</output>
}

/**
 * The note route for `path` over `files`, in a graph whose local-only folder
 * `secure` is read-only.
 */
async function renderNote(path: string, files: Record<string, string>) {
  noteFile = createTestNoteFileService({ files })
  app = createTestCoreServices({ database: createWasmTestDatabaseService(), noteFile })
  onTestFinished(() => app.database.close())
  vi.spyOn(app.indexQuery, 'getNote').mockImplementation(getNote)
  vi.spyOn(app.xArchive, 'resolve').mockImplementation(
    async (_generation, postId) => await resolveArchive(postId),
  )
  // The X post resolver and its preload read the app's shared query client.
  return await renderInApp(
    <PaletteProvider>
      <Navigator />
      <MenuRequestProbe path={path} />
      <RouteContent />
    </PaletteProvider>,
    {
      app,
      queryClient,
      graph: { root: '/g', name: 'g', generation: 1, localOnlyFolders: ['secure'] },
      settings: {
        statusBarEnabled: true,
        editorMarkdownSyntax: 'hide',
        wikiLanguages: [{ label: 'English', folder: 'wiki' }],
      },
      route: { kind: 'note', path },
    },
  )
}

/** Every remote command the pane sent so far, and the archive lookups. */
function remoteCalls(since = 0): string[] {
  const commands = app.ipc
    .calls()
    .slice(since)
    .map((call) => call.command)
  return commands.filter((command) => REMOTE_COMMANDS.includes(command))
}

function openNote(path: string): void {
  if (navigateRef.current === null) {
    throw new Error('the router has not rendered')
  }
  navigateRef.current({ kind: 'note', path })
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
  getNote.mockImplementation((path) => Promise.resolve(noteRow(path, true)))
  await renderNote('notes/locked.md', {
    'notes/locked.md': `---\nprivate: true\n---\n# Locked\n\n${REMOTE_BODY}`,
  })

  const links = page.getByTestId('embed-link')
  await expect.element(links.first()).toHaveTextContent(X_URL)
  await expect.element(links.last()).toHaveTextContent(YOUTUBE_URL)
  // The source URL is what the reader sees in place of the card.
  await expect.element(links.first()).toBeVisible()
  await expect.element(links.last()).toBeVisible()
  expect(editable()).not.toBeNull()
  expect(remoteElements()).toBeNull()
  expect(remoteCalls()).toEqual([])
  expect(resolveArchive).not.toHaveBeenCalled()
})

it('marks a private note above its title and opens its status menu from there', async () => {
  getNote.mockImplementation((path) => Promise.resolve(noteRow(path, true)))
  await renderNote('notes/locked.md', { 'notes/locked.md': `---\nprivate: true\n---\n# Locked\n` })

  const notice = page.getByRole('button', { name: 'Private note: show note details' })
  await expect.element(notice).toHaveTextContent('Private · never sent to AI or other services')
  const before = page.getByTestId('menu-request').element().textContent
  await notice.click()
  await expect.element(page.getByTestId('menu-request')).not.toHaveTextContent(before ?? '')
  await expect.element(page.getByTestId('menu-request')).not.toHaveTextContent('none')
})

it('treats a note whose live header is locked as private while its row says public', async () => {
  await renderNote('notes/locked.md', {
    'notes/locked.md': `---\nprivate: true\n---\n# Locked\n\n${REMOTE_BODY}`,
  })

  await expect.element(page.getByTestId('embed-link').first()).toHaveTextContent(X_URL)
  expect(remoteElements()).toBeNull()
  expect(remoteCalls()).toEqual([])
  expect(resolveArchive).not.toHaveBeenCalled()
})

it('switches the policy live on a Lock toggle, without remounting the editor', async () => {
  const path = 'notes/tweets.md'
  await renderNote(path, { [path]: `# Tweets\n\n![](${X_URL})\n` })
  await expect.element(page.getByText('Archived post')).toBeVisible()
  const editor = editable()
  expect(editor).not.toBeNull()

  const beforeLock = app.ipc.calls().length
  const lookupsBeforeLock = resolveArchive.mock.calls.length
  await toggleNotePrivate(app.noteActions, path)
  await expect.element(page.getByTestId('embed-link')).toHaveTextContent(X_URL)
  expect(remoteElements()).toBeNull()
  expect(editable()).toBe(editor)
  await vi.waitFor(() => {
    expect(noteFile.files().get(path)).toBe(
      `---\nprivate: true\n---\n\n# Tweets\n\n![](${X_URL})\n`,
    )
  })
  expect(remoteCalls(beforeLock)).toEqual([])
  expect(resolveArchive).toHaveBeenCalledTimes(lookupsBeforeLock)

  await expect.element(page.getByTestId('private-note-notice')).toBeVisible()

  await toggleNotePrivate(app.noteActions, path)
  await expect.element(page.getByText('Archived post')).toBeVisible()
  expect(page.getByTestId('embed-link').query()).toBeNull()
  expect(page.getByTestId('private-note-notice').query()).toBeNull()
  expect(editable()).toBe(editor)
})

const SECRET = 'secret words'

/**
 * Open a public note, then a local-only one holding `remote`, so the public
 * note's row is cached when the pane goes back to it (its policy is known at
 * once). Returns how many IPC calls and archive lookups were made before the
 * pane leaves the local-only note.
 */
async function visitLocalOnlyNote(remote: string): Promise<{ calls: number; lookups: number }> {
  getNote.mockImplementation((path) => Promise.resolve(noteRow(path, path.startsWith('secure/'))))
  await renderNote('notes/public.md', {
    'notes/public.md': '# Public\n\nhello public\n',
    'secure/a.md': `# Secret\n\n${SECRET}\n\n${remote}\n`,
  })
  await expect.element(page.getByText('hello public')).toBeVisible()
  openNote('secure/a.md')
  await expect.element(page.getByTestId('local-only-sheet')).toBeVisible()
  await expect.element(page.getByText(SECRET)).toBeVisible()
  return { calls: app.ipc.calls().length, lookups: resolveArchive.mock.calls.length }
}

it('never looks up a local-only note’s X posts for the note the pane opens next', async () => {
  const before = await visitLocalOnlyNote('![](https://x.com/jack/status/999)')

  openNote('notes/public.md')
  await expect.element(page.getByText('hello public')).toBeVisible()
  expect(remoteCalls(before.calls)).toEqual([])
  expect(resolveArchive).toHaveBeenCalledTimes(before.lookups)
})

it('never shows a local-only note in an editor for the note the pane opens next', async () => {
  await visitLocalOnlyNote('![chart](https://example.com/secret-chart.png)')

  const stop = watchInsertions(SECRET)
  openNote('notes/public.md')
  await expect.element(page.getByText('hello public')).toBeVisible()
  expect(stop()).toEqual([])
})
