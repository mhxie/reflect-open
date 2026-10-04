import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge, type NoteRow, type OpenTask } from '@reflect/core'
import { queryClient } from '@/lib/query-client.ts'
import { makeOpenTask } from '@/lib/tasks/open-task-fixture.ts'
import type { TaskActions } from '@/lib/tasks/use-task-actions.ts'
import { RouterProvider } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { MobileTaskEditSheet } from './task-edit-sheet.tsx'

const getNote = vi.hoisted(() => vi.fn<(path: string) => Promise<NoteRow | undefined>>())
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getNote,
  // The graph's local-only folders are `secure`.
  isLocalOnlyPath: (path: string) => path.split('/').slice(0, -1).includes('secure'),
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 1 } }),
}))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: { editorMarkdownSyntax: 'hide', dateFormat: 'mdy', contactsEnabled: false },
  }),
}))

const X_URL = 'https://x.com/jack/status/101'
/** What reaches the network, or writes the X archive, on a note's behalf. */
const REMOTE_COMMANDS = [
  'x_archive_resolve',
  'x_syndication_fetch',
  'x_archive_write',
  'capture_oembed_fetch',
]

let commands: string[]

function noteRow(path: string, isPrivate: boolean): NoteRow {
  return {
    path,
    title: 'Plan',
    dailyDate: null,
    isPrivate,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
  }
}

const actions: TaskActions = {
  complete: () => {},
  toggle: () => {},
  remove: () => {},
  edit: () => {},
  checkboxToggle: () => {},
  insert: async () => null,
  insertAfter: async () => null,
  editAndToggle: () => {},
  schedule: () => {},
  convertToBullet: () => {},
  editAndConvertToBullet: () => {},
  archive: () => {},
  isPending: false,
}

beforeEach(() => {
  commands = []
  getNote.mockImplementation(async (path) => noteRow(path, path === 'notes/locked.md'))
  setBridge({
    invoke: async (command) => {
      commands.push(command)
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

function renderSheet(task: OpenTask) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'tasks' }}>
        <MobileTaskEditSheet
          task={task}
          open
          onOpenChange={() => {}}
          today="2026-10-04"
          actions={actions}
          onOpenNote={() => {}}
        />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function remoteElements(): Element | null {
  return document.querySelector(
    'img[src^="https:"], img[src^="http:"], iframe, meowdown-embed-x, meowdown-embed-youtube',
  )
}

describe('MobileTaskEditSheet network policy', () => {
  it('reaches nothing remote for a task in a locked note', async () => {
    await renderSheet(
      makeOpenTask({
        notePath: 'notes/locked.md',
        markdown: `watch ![](${X_URL}) and ![chart](https://example.com/chart.png)`,
      }),
    )
    await expect.element(page.getByTestId('embed-link')).toHaveTextContent(X_URL)
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledWith('notes/locked.md'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(remoteElements()).toBeNull()
    for (const command of REMOTE_COMMANDS) {
      expect(commands).not.toContain(command)
    }
  })

  it('never creates a note from a link in a local-only task', async () => {
    await renderSheet(
      makeOpenTask({ notePath: 'finance/secure/bank.md', markdown: 'call [[Brand New Idea]]' }),
    )
    await page.getByTestId('wikilink').getByText('Brand New Idea').click()
    await vi.waitFor(() => expect(commands).toContain('db_query'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(commands).not.toContain('note_create')
    expect(commands).not.toContain('note_write')
  })
})
