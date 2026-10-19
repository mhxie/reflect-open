import { page } from 'vitest/browser'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createTestCoreServices, createTestNoteFileService } from '@reflect/core/testing'
import { PaletteProvider } from '@/components/command-palette/palette-provider.tsx'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { RouteContent } from './route-content.tsx'

/** Every way the pane renders a note — editor, protected, read-only preview — leads with the wiki trail. */

/**
 * The note route for `path` holding `content`, in a graph whose read-only
 * local-only folder is `secure`; the wiki index `wiki/index.md` sits above
 * every wiki note.
 */
async function renderNote(path: string, content: string) {
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    noteFile: createTestNoteFileService({ files: { [path]: content } }),
  })
  onTestFinished(() => app.database.close())
  // The editor round-trips nearly all Markdown, so one body stands in for a
  // converter gap and opens the note protected.
  const createSession = app.noteSessions.create.bind(app.noteSessions)
  vi.spyOn(app.noteSessions, 'create').mockImplementation((options) => {
    return createSession({
      ...options,
      classify: (markdown) => {
        return markdown.includes('Unsupported body.') ? 'lossy' : options.classify(markdown)
      },
    })
  })
  vi.spyOn(app.wiki, 'ancestors').mockResolvedValue([
    { path: 'wiki/index.md', title: 'Wiki Index', displayTitle: null, lang: null },
  ])
  vi.spyOn(app.indexQuery, 'getNote').mockResolvedValue({
    path,
    title: '',
    dailyDate: null,
    isPrivate: false,
    gistUrl: null,
    gistStale: false,
  })
  return await renderInApp(
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

it('leads a protected note with the trail', async () => {
  await renderNote('wiki/topic/Unsupported.md', '# Unsupported\n\nUnsupported body.\n')

  await expect.element(page.getByText(/reproduce faithfully/i)).toBeVisible()
  expect(document.querySelector('[contenteditable="true"]')).toBeNull()
  await expectTrail()
})

it('leads a read-only local-only preview with the trail', async () => {
  await renderNote('wiki/secure/Note.md', '# Note\n\nPrivate body.\n')

  await expect.element(page.getByTestId('local-only-sheet')).toBeVisible()
  await expectTrail()
})
