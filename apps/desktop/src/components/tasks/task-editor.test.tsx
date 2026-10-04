import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render } from 'vitest-browser-react'
import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { setBridge, type NoteRow, type OpenTask } from '@reflect/core'
import type { resolveArchivedPost } from '@reflect/core/x-archive'
import { queryClient, queryKeys } from '@/lib/query-client.ts'
import { makeOpenTask } from '@/lib/tasks/open-task-fixture.ts'
import { RouterProvider } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { TaskEditor } from './task-editor.tsx'

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  convertFileSrc: (path: string) => `reflect-asset://${path}`,
}))
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

type ResolvedArchive = Awaited<ReturnType<typeof resolveArchivedPost>>

const X_URL = 'https://x.com/jack/status/101'
/** What reaches the network, or writes the X archive, on a note's behalf. */
const REMOTE_COMMANDS = [
  'x_archive_resolve',
  'x_syndication_fetch',
  'x_archive_write',
  'capture_oembed_fetch',
]

let commands: string[]
let client: QueryClient

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

function archivedPost(id: string): NonNullable<ResolvedArchive> {
  return {
    archive: {
      kind: 'x-post',
      capturedAt: '2026-09-14T00:00:00Z',
      data: {
        id,
        createdAt: '2026-09-14T00:00:00Z',
        author: { name: 'Jack', handle: 'jack' },
        body: [{ type: 'text', text: 'Archived post' }],
      },
    },
    resources: [],
  }
}

beforeEach(() => {
  commands = []
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  getNote.mockImplementation(async (path) => noteRow(path, path === 'notes/locked.md'))
  setBridge({
    invoke: async (command, args) => {
      commands.push(command)
      if (command === 'x_archive_resolve') return archivedPost(String(args.postId))
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

function renderTaskEditor(task: OpenTask) {
  const noop = (): void => {}
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider initialRoute={{ kind: 'tasks' }}>
        <TaskEditor
          task={task}
          onCommit={noop}
          onContinue={noop}
          onDelete={noop}
          onDeleteEmpty={noop}
          onCancel={noop}
          onComplete={noop}
          onCheckboxToggle={noop}
          onConvertToBullet={noop}
          onFlush={noop}
          onNavigate={noop}
        />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

function editable(): Element | null {
  return document.querySelector('[data-task-editor] [contenteditable="true"]')
}

function remoteElements(): Element | null {
  return document.querySelector(
    'img[src^="https:"], img[src^="http:"], iframe, meowdown-embed-x, meowdown-embed-youtube',
  )
}

describe('TaskEditor network policy', () => {
  it('reaches nothing remote for a task in a locked note', async () => {
    await renderTaskEditor(
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

  it('switches live when the note is locked, without remounting', async () => {
    const path = 'notes/plan.md'
    await renderTaskEditor(makeOpenTask({ notePath: path, markdown: `watch ![](${X_URL})` }))
    await expect.element(page.getByText('Archived post')).toBeVisible()
    const editor = editable()
    expect(editor).not.toBeNull()

    const beforeLock = commands.length
    act(() => {
      client.setQueryData(queryKeys.index.note('/g', path), noteRow(path, true))
    })
    await expect.element(page.getByTestId('embed-link')).toHaveTextContent(X_URL)
    expect(remoteElements()).toBeNull()
    expect(editable()).toBe(editor)
    for (const command of REMOTE_COMMANDS) {
      expect(commands.slice(beforeLock)).not.toContain(command)
    }
  })

  it('never creates a note from a link in a local-only task', async () => {
    await renderTaskEditor(
      makeOpenTask({ notePath: 'finance/secure/bank.md', markdown: 'call [[Brand New Idea]]' }),
    )
    await page.getByTestId('wikilink').getByText('Brand New Idea').click()
    await vi.waitFor(() => expect(commands).toContain('db_query'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(commands).not.toContain('note_create')
    expect(commands).not.toContain('note_write')
  })
})
