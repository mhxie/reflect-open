import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, renderHook } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setBridge } from '@reflect/core'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { useNoteStatus } from '@/editor/status/note-status-store.ts'
import { queryClient } from '@/lib/query-client.ts'
import { RouterProvider } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { RouteContent } from './route-content.tsx'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getBacklinksWithContext: async () => ({ contexts: [], nextCursor: null, indexedLinkCount: 0 }),
  relatedNotes: async () => [],
  // The graph's local-only folders are `secure` (the predicate itself is
  // covered against the shared fixture in core).
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
  isLocalOnlyReadOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
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
let commands: string[]

beforeEach(() => {
  files = {}
  commands = []
  setBridge({
    invoke: async (command, args) => {
      commands.push(command)
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
  vi.resetAllMocks()
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

it('opens a local-only note as a rendered read-only view, with nothing remote', async () => {
  files['finance/secure/bank.md'] =
    '# Bank\n\nAccount notes.\n\n![chart](https://example.com/chart.png)\n\n' +
    'https://x.com/jack/status/101\n'
  const view = await renderNote('finance/secure/bank.md')

  await expect.element(page.getByTestId('local-only-notice')).toBeVisible()
  await expect.element(page.getByTestId('local-only-sheet')).toBeVisible()
  await expect.element(page.getByText('Account notes.')).toBeVisible()
  expect(document.querySelector('[contenteditable="true"]')).toBeNull()
  expect(document.querySelector('img[src^="https://"]')).toBeNull()
  // No embed lookup or archive write went out for the X link.
  expect(commands).not.toContain('x_syndication_fetch')
  expect(commands).not.toContain('x_archive_write')
  expect(commands).not.toContain('x_archive_resolve')
  await view.unmount()
  expect(commands).not.toContain('note_write')
  expect(commands).not.toContain('note_create')
})

it('a link from a local-only note navigates but never creates a note', async () => {
  files['finance/secure/bank.md'] = '# Bank\n\nSee [[Brand New Idea]].\n'
  const view = await renderNote('finance/secure/bank.md')

  await page.getByTestId('wikilink').getByText('Brand New Idea').click()
  // Resolution is async; let it settle before checking nothing was created.
  await vi.waitFor(() => expect(commands).toContain('db_query'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(commands).not.toContain('note_create')
  expect(commands).not.toContain('note_write')
  await view.unmount()
})

it('keeps editing every other note', async () => {
  files['finance/plan.md'] = '# Plan\n\nBudget.\n'
  const view = await renderNote('finance/plan.md')

  await expect.element(page.getByText('Budget.')).toBeVisible()
  expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="local-only-notice"]')).toBeNull()
  await view.unmount()
})

it('counts a local-only note for the status corner', async () => {
  files['finance/secure/bank.md'] = '# Bank\n\nAccount notes.\n'
  await renderNote('finance/secure/bank.md')
  await expect.element(page.getByText('Account notes.')).toBeVisible()

  const status = await renderHook(() =>
    useNoteStatus({ generation: 1, path: 'finance/secure/bank.md' }),
  )
  expect(status.result.current?.characters).toBeGreaterThan(0)
})
