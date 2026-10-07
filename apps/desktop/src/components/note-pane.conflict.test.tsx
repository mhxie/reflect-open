import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveConflictMarkers, setBridge } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { queryClient } from '@/lib/query-client.ts'
import { RouterProvider } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { RouteContent } from './route-content.tsx'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: async () => ({ contexts: [], nextCursor: null, indexedLinkCount: 0 }),
  relatedNotes: async () => [],
  getNote: async (path: string) => ({
    path,
    title: 'Clash',
    dailyDate: null,
    isPrivate: false,
    hasConflict: true,
    gistUrl: null,
    gistStale: false,
  }),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1, localOnlyFolders: [] },
    indexGeneration: null,
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

const PATH = 'notes/clash.md'
const SHOWN = '<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> other device\n'
/** A later pull's conflict, with a side the pane never rendered. */
const NEWER = '<<<<<<< this device\nmine\n=======\ntheirs, edited again\n>>>>>>> other device\n'

let files: Record<string, string>
let writes: Array<{ contents: string; expectedContents: unknown }>

beforeEach(() => {
  files = {}
  writes = []
  setBridge({
    invoke: async (command, args) => {
      const path = String(args.path)
      if (command === 'note_read') {
        if (files[path] === undefined) {
          throw { kind: 'notFound', message: `no such note: ${path}` }
        }
        return files[path]
      }
      if (command === 'note_write') {
        // Rust's rule: a write lands only over the contents it names.
        writes.push({ contents: String(args.contents), expectedContents: args.expectedContents })
        if ((files[path] ?? null) !== args.expectedContents) {
          throw { kind: 'io', message: 'Note changed on disk; reload before retrying' }
        }
        files[path] = String(args.contents)
        return 1
      }
      if (command === 'db_query') {
        return []
      }
      return null
    },
    listen: async () => () => {},
  })
})

afterEach(async () => {
  await cleanup()
  setBridge(null)
  queryClient.clear()
})

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

it('resolves exactly the conflict the pane shows', async () => {
  files[PATH] = SHOWN
  await renderNote(PATH)
  await expect.element(page.getByText(/edited on two devices/i)).toBeVisible()

  await page.getByRole('button', { name: /keep the other device’s/i }).click()

  await vi.waitFor(() => expect(files[PATH]).toBe(resolveConflictMarkers(SHOWN, 'theirs')))
  expect(writes).toEqual([
    { contents: resolveConflictMarkers(SHOWN, 'theirs'), expectedContents: SHOWN },
  ])
})

it('refuses a conflict that landed after the pane rendered, leaving it for review', async () => {
  files[PATH] = SHOWN
  await renderNote(PATH)
  await expect.element(page.getByText(/edited on two devices/i)).toBeVisible()
  // A second pull lands different sides before the watcher reports it.
  files[PATH] = NEWER

  await page.getByRole('button', { name: /keep this device’s version/i }).click()

  await expect.element(page.getByText(/couldn’t resolve: note changed on disk/i)).toBeVisible()
  expect(writes).toEqual([
    { contents: resolveConflictMarkers(SHOWN, 'ours'), expectedContents: SHOWN },
  ])
  expect(files[PATH]).toBe(NEWER)
})
