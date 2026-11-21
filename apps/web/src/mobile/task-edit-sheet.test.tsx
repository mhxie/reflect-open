import { createTestCoreServices, makeOpenTask } from '@reflect/core/testing'
import { page } from 'vitest/browser'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { NoteRow, OpenTask } from '@reflect/core'
import type { TaskActions } from '@/lib/tasks/use-task-actions.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { MobileTaskEditSheet } from './task-edit-sheet.tsx'

const X_URL = 'https://x.com/jack/status/101'
/** What reaches the network, or writes the X archive, on a note's behalf. */
const REMOTE_COMMANDS = [
  'x_archive_resolve',
  'x_syndication_fetch',
  'x_archive_write',
  'capture_oembed_fetch',
]

// The graph's local-only folders are `secure`.
const GRAPH = { root: '/g', name: 'g', generation: 1, localOnlyFolders: ['secure'] }

function noteRow(path: string, isPrivate: boolean): NoteRow {
  return {
    path,
    title: 'Plan',
    dailyDate: null,
    isPrivate,
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
  insert: () => Promise.resolve(null),
  insertAfter: () => Promise.resolve(null),
  editAndToggle: () => {},
  schedule: () => {},
  convertToBullet: () => {},
  editAndConvertToBullet: () => {},
  archive: () => {},
  isPending: false,
}

async function renderSheet(task: OpenTask) {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  const getNote = vi
    .spyOn(app.indexQuery, 'getNote')
    .mockImplementation((path) => Promise.resolve(noteRow(path, path === 'notes/locked.md')))
  const view = await renderInApp(
    <MobileTaskEditSheet
      task={task}
      open
      onOpenChange={() => {}}
      today="2026-10-04"
      actions={actions}
      onOpenNote={() => {}}
    />,
    {
      core: app,
      graph: GRAPH,
      route: { kind: 'tasks' },
      settings: { editorMarkdownSyntax: 'hide', dateFormat: 'mdy', contactsEnabled: false },
    },
  )
  return { view, getNote }
}

/**
 * What reached the network or the X archive so far: bridge commands, plus the
 * X archive's resolves, writes and syndication fetches.
 */
function commands(view: Awaited<ReturnType<typeof renderSheet>>['view']): string[] {
  const { core: app } = view
  return [
    ...app.ipc.calls().map((call) => call.command),
    ...app.xArchive.resolves().map(() => 'x_archive_resolve'),
    ...app.xArchive.writes().map(() => 'x_archive_write'),
    ...app.xArchive.syndicationRequests().map(() => 'x_syndication_fetch'),
  ]
}

function remoteElements(): Element | null {
  return document.querySelector(
    'img[src^="https:"], img[src^="http:"], iframe, meowdown-embed-x, meowdown-embed-youtube',
  )
}

describe('MobileTaskEditSheet network policy', () => {
  it('reaches nothing remote for a task in a locked note', async () => {
    const { view, getNote } = await renderSheet(
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
      expect(commands(view)).not.toContain(command)
    }
  })

  it('never creates a note from a link in a local-only task', async () => {
    const { view } = await renderSheet(
      makeOpenTask({ notePath: 'finance/secure/bank.md', markdown: 'call [[Brand New Idea]]' }),
    )
    await page.getByTestId('wikilink').getByText('Brand New Idea').click()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(view.core.noteFile.writes()).toEqual([])
    expect([...view.core.noteFile.files().keys()]).toEqual([])
  })
})
