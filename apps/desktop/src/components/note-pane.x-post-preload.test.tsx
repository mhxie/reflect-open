import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge, type NoteRow } from '@reflect/core'
import type { resolveArchivedPost } from '@reflect/core/x-archive'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { queryClient } from '@/lib/query-client.ts'
import { RouterProvider } from '@/routing/router.tsx'
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
  getNote,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1 },
    indexing: false,
  }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: {
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

let files: Record<string, string>
let commands: string[]
const resolveArchive = vi.fn<(postId: string) => Promise<ResolvedArchive>>()

/** An index row for `path`; the note's privacy lives in its row and frontmatter. */
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

beforeEach(() => {
  files = {}
  commands = []
  getNote.mockImplementation(async (path) => noteRow(path, false))
  setBridge({
    invoke: async (command, args) => {
      commands.push(command)
      if (command === 'note_read') return files[String(args.path)]
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
})

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

function renderNote(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'note', path }}>
        <PaletteProvider>
          <RouteContent />
        </PaletteProvider>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

// Every rendered state is observed before it can paint.
function watchLoadingCards(): { seen: boolean; stop: () => void } {
  const watch = { seen: false, stop: () => observer.disconnect() }
  const observer = new MutationObserver(() => {
    if (document.querySelector('post-embed-x-post [data-pending]')) watch.seen = true
  })
  observer.observe(document.body, { subtree: true, childList: true, attributes: true })
  return watch
}

it('renders archived X posts in the first frame of the editor', async () => {
  files['notes/tweets.md'] = '![](https://x.com/jack/status/101)\n'
  resolveArchive.mockImplementation(async (postId) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return archivedPost(postId, 'Archived first')
  })
  const loadingCards = watchLoadingCards()
  const view = await renderNote('notes/tweets.md')

  await expect.element(page.getByText('Archived first')).toBeVisible()
  loadingCards.stop()
  expect(loadingCards.seen).toBe(false)
  await view.unmount()
})

it('mounts the editor once the wait runs out for a slow archive', async () => {
  files['notes/slow.md'] = 'Slow note\n\n![](https://x.com/jack/status/102)\n'
  resolveArchive.mockImplementation(() => new Promise(() => {}))
  const view = await renderNote('notes/slow.md')

  await expect.element(page.getByText('Slow note')).toBeVisible()
  await expect.element(page.getByText('Loading this post…')).toBeVisible()
  await view.unmount()
})

it('renders archived X posts in the first frame when the index row is slow', async () => {
  files['notes/tweets.md'] = '![](https://x.com/jack/status/103)\n'
  getNote.mockImplementation(async (path) => {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return noteRow(path, false)
  })
  resolveArchive.mockImplementation(async (postId) => archivedPost(postId, 'Archived late row'))
  const loadingCards = watchLoadingCards()
  const view = await renderNote('notes/tweets.md')

  await expect.element(page.getByText('Archived late row')).toBeVisible()
  loadingCards.stop()
  expect(loadingCards.seen).toBe(false)
  await view.unmount()
})

it('preloads nothing for a locked note and mounts at once', async () => {
  files['notes/locked.md'] =
    '---\nprivate: true\n---\nLocked\n\n![](https://x.com/jack/status/104)\n'
  getNote.mockImplementation(async (path) => noteRow(path, true))
  resolveArchive.mockImplementation(() => new Promise(() => {}))
  const view = await renderNote('notes/locked.md')

  await expect.element(page.getByText('Locked')).toBeVisible()
  await expect
    .element(page.getByTestId('embed-link'))
    .toHaveTextContent('https://x.com/jack/status/104')
  expect(commands).not.toContain('x_archive_resolve')
  expect(commands).not.toContain('x_syndication_fetch')
  expect(commands).not.toContain('x_archive_write')
  await view.unmount()
})
