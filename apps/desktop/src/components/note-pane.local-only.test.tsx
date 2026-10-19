import { page } from 'vitest/browser'
import { expect, it, vi } from 'vitest'
import { createTestCoreServices, createTestNoteFileService } from '@reflect/core/testing'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import { useNoteStatus } from '@/editor/status/note-status-store.ts'
import { renderHookInApp, renderInApp } from '@/test-utils/render-in-app.tsx'
import '@/test-utils/locator.ts'
import { RouteContent } from './route-content.tsx'

/** What reaches the network, or writes the X archive, on a note's behalf. */
const REMOTE_COMMANDS = ['x_syndication_fetch', 'x_archive_write', 'x_archive_resolve']

/**
 * The note route for `path` over `files`, in a graph whose local-only folders
 * are `secure` (read-only; the predicates are covered against the shared
 * fixture in core).
 */
async function renderNote(path: string, files: Record<string, string>) {
  const noteFile = createTestNoteFileService({ files })
  const app = createTestCoreServices({ noteFile })
  const view = await renderInApp(
    <PaletteProvider>
      <RouteContent />
    </PaletteProvider>,
    {
      app,
      graph: { root: '/g', name: 'g', generation: 1, localOnlyFolders: ['secure'] },
      settings: {
        editorMarkdownSyntax: 'hide',
        wikiLanguages: [{ label: 'English', folder: 'wiki' }],
      },
      route: { kind: 'note', path },
    },
  )
  return Object.assign(view, {
    noteFile,
    commands: () => app.ipc.calls().map((call) => call.command),
  })
}

it('opens a local-only note as a rendered read-only view, with nothing remote', async () => {
  const view = await renderNote('finance/secure/bank.md', {
    'finance/secure/bank.md':
      '# Bank\n\nAccount notes.\n\n![chart](https://example.com/chart.png)\n\n' +
      'https://x.com/jack/status/101\n',
  })

  await expect.element(page.getByTestId('local-only-notice')).toBeVisible()
  await expect.element(page.getByTestId('local-only-sheet')).toBeVisible()
  await expect.element(page.getByText('Account notes.')).toBeVisible()
  expect(document.querySelector('[contenteditable="true"]')).toBeNull()
  expect(document.querySelector('img[src^="https://"]')).toBeNull()
  // No embed lookup or archive write went out for the X link.
  for (const command of REMOTE_COMMANDS) {
    expect(view.commands()).not.toContain(command)
  }
  await view.unmount()
  expect(view.noteFile.writes()).toEqual([])
})

it('a link from a local-only note navigates but never creates a note', async () => {
  const noteFile = createTestNoteFileService({
    files: { 'finance/secure/bank.md': '# Bank\n\nSee [[Brand New Idea]].\n' },
  })
  const app = createTestCoreServices({ noteFile })
  const resolveReadOnly = vi.spyOn(app.wikiResolver, 'resolveWikiTarget')
  const resolveOrCreate = vi.spyOn(app.noteCreation, 'resolveOrCreateNoteWithTitle')
  await renderInApp(
    <PaletteProvider>
      <RouteContent />
    </PaletteProvider>,
    {
      app,
      graph: { root: '/g', name: 'g', generation: 1, localOnlyFolders: ['secure'] },
      settings: {
        editorMarkdownSyntax: 'hide',
        wikiLanguages: [{ label: 'English', folder: 'wiki' }],
      },
      route: { kind: 'note', path: 'finance/secure/bank.md' },
    },
  )

  await page.getByTestId('wikilink').getByText('Brand New Idea').click()
  // Resolution is async; let it settle before checking nothing was created.
  await vi.waitFor(() => expect(resolveReadOnly).toHaveBeenCalledWith('Brand New Idea'))
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(resolveOrCreate).not.toHaveBeenCalled()
  expect(noteFile.writes()).toEqual([])
})

it('keeps editing every other note', async () => {
  await renderNote('finance/plan.md', { 'finance/plan.md': '# Plan\n\nBudget.\n' })

  await expect.element(page.getByText('Budget.')).toBeVisible()
  expect(document.querySelector('[contenteditable="true"]')).not.toBeNull()
  expect(document.querySelector('[data-testid="local-only-notice"]')).toBeNull()
})

it('counts a local-only note for the status corner', async () => {
  await renderNote('finance/secure/bank.md', {
    'finance/secure/bank.md': '# Bank\n\nAccount notes.\n',
  })
  await expect.element(page.getByText('Account notes.')).toBeVisible()

  const status = await renderHookInApp(
    () => useNoteStatus({ generation: 1, path: 'finance/secure/bank.md' }),
    { servicesOnly: true },
  )
  expect(status.result.current?.characters).toBeGreaterThan(0)
})
