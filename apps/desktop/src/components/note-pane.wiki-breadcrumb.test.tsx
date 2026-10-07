import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { queryClient } from '@/lib/query-client.ts'
import { RouterProvider } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { RouteContent } from './route-content.tsx'

/** Every way the pane renders a note — editor, protected, read-only preview — leads with the wiki trail. */

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: async () => ({ contexts: [], nextCursor: null, indexedLinkCount: 0 }),
  relatedNotes: async () => [],
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
  isLocalOnlyReadOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
  wikiAncestors: async () => [
    { path: 'wiki/index.md', title: 'Wiki Index', displayTitle: null, lang: null },
  ],
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({
    graph: { root: '/g', name: 'g', generation: 1, localOnlyFolders: ['secure'] },
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

let files: Record<string, string>

beforeEach(() => {
  files = {}
  setBridge({
    invoke: async (command, args) => {
      if (command === 'note_read') {
        return files[String(args.path)]
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

async function renderNote(path: string, content: string) {
  files[path] = content
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return await render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'note', path }}>
        <PaletteProvider>
          <RouteContent />
        </PaletteProvider>
      </RouterProvider>
    </QueryClientProvider>,
  )
}

async function expectTrail(): Promise<void> {
  const trail = page.getByRole('navigation', { name: 'Wiki path' })
  await expect.element(trail.getByRole('button', { name: 'Wiki Index' })).toBeVisible()
}

it('leads the editor with the trail', async () => {
  await renderNote('wiki/topic/Note.md', '# Note\n\nBody.\n')

  await expectTrail()
  await expect.element(page.getByText('Body.')).toBeVisible()
  expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
})

it('leads a protected, sync-conflicted note with the trail', async () => {
  await renderNote(
    'wiki/topic/Clash.md',
    '<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> other device\n',
  )

  await expect.element(page.getByText(/edited on two devices/i)).toBeVisible()
  await expectTrail()
})

it('leads a read-only local-only preview with the trail', async () => {
  await renderNote('wiki/secure/Note.md', '# Note\n\nPrivate body.\n')

  await expect.element(page.getByTestId('local-only-sheet')).toBeVisible()
  await expectTrail()
})
