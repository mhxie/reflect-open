import { page } from 'vitest/browser'
import { expect, it, vi } from 'vitest'
import type { IndexQueryService, NoteRow } from '@reflect/core'
import type { ResolvedArchivedPost } from '@reflect/core/x-archive'
import { createTestCoreServices, createTestNoteFileService } from '@reflect/core/testing'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { queryClient } from '@/lib/query-client.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import '@/test-utils/locator.ts'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { RouteContent } from './route-content.tsx'

type ResolvedArchive = ResolvedArchivedPost | null

/** What reaches the network, or writes the X archive, on a note's behalf. */
const REMOTE_COMMANDS = ['x_archive_resolve', 'x_syndication_fetch', 'x_archive_write']

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

/** An index row for `path`; the note's privacy lives in its row and frontmatter. */
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

async function renderNote(
  path: string,
  source: string,
  resolveArchive: (postId: string) => Promise<ResolvedArchive>,
  getNote: IndexQueryService['getNote'] = (notePath) => Promise.resolve(noteRow(notePath, false)),
) {
  const core = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile: createTestNoteFileService({ files: { [path]: source } }),
  })
  const resolve = vi
    .spyOn(core.xArchive, 'resolve')
    .mockImplementation(async (_generation, postId) => await resolveArchive(postId))
  vi.spyOn(core.indexQuery, 'getNote').mockImplementation(getNote)
  // The X post resolver and its preload read the app's shared query client.
  const view = await renderInApp(
    <PaletteProvider>
      <RouteContent />
    </PaletteProvider>,
    {
      core,
      queryClient,
      graph: { root: '/g', name: 'g', generation: 1 },
      settings: {
        editorMarkdownSyntax: 'hide',
        wikiLanguages: [{ label: 'English', folder: 'wiki' }],
      },
      route: { kind: 'note', path },
    },
  )
  return Object.assign(view, {
    resolve,
    commands: () => core.ipc.calls().map((call) => call.command),
  })
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
  const loadingCards = watchLoadingCards()
  const view = await renderNote(
    'notes/tweets.md',
    '![](https://x.com/jack/status/101)\n',
    async (postId) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return archivedPost(postId, 'Archived first')
    },
  )

  await expect.element(page.getByText('Archived first')).toBeVisible()
  loadingCards.stop()
  expect(loadingCards.seen).toBe(false)
  await view.unmount()
})

it('mounts the editor once the wait runs out for a slow archive', async () => {
  const view = await renderNote(
    'notes/slow.md',
    'Slow note\n\n![](https://x.com/jack/status/102)\n',
    () => new Promise(() => {}),
  )

  await expect.element(page.getByText('Slow note')).toBeVisible()
  await expect.element(page.getByText('Loading this post…')).toBeVisible()
  await view.unmount()
})

it('renders archived X posts in the first frame when the index row is slow', async () => {
  const loadingCards = watchLoadingCards()
  const view = await renderNote(
    'notes/tweets.md',
    '![](https://x.com/jack/status/103)\n',
    (postId) => Promise.resolve(archivedPost(postId, 'Archived late row')),
    async (path) => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return noteRow(path, false)
    },
  )

  await expect.element(page.getByText('Archived late row')).toBeVisible()
  loadingCards.stop()
  expect(loadingCards.seen).toBe(false)
  await view.unmount()
})

it('preloads nothing for a locked note and mounts at once', async () => {
  const view = await renderNote(
    'notes/locked.md',
    '---\nprivate: true\n---\nLocked\n\n![](https://x.com/jack/status/104)\n',
    () => new Promise(() => {}),
    (path) => Promise.resolve(noteRow(path, true)),
  )

  await expect.element(page.getByText('Locked')).toBeVisible()
  await expect
    .element(page.getByTestId('embed-link'))
    .toHaveTextContent('https://x.com/jack/status/104')
  expect(view.resolve).not.toHaveBeenCalled()
  for (const command of REMOTE_COMMANDS) {
    expect(view.commands()).not.toContain(command)
  }
  await view.unmount()
})
