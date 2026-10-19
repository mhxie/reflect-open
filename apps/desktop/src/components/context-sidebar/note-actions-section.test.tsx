import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { MIN_VISIBLE_MS } from '@reflect/app'
import {
  isOstensiblyEmptyNoteSource,
  KEPT_IN_GRAPH_TRASH,
  UNREADABLE_FRONTMATTER_LABEL,
  upsertFrontmatter,
  type IndexQueryService,
  type NoteActionsService,
  type NoteDocumentService,
  type NoteRow,
} from '@reflect/core'
import { createTestCoreServices, createTestPlatformService } from '@reflect/core/testing'
import { createTestOperationsService, type TestOperationsService } from '@reflect/app/testing'
import { frontmatterPatchToYaml } from '@/editor/note-session.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { NoteActionsSection } from './note-actions-section.tsx'

// What the app's fakes answer; each test sets them before `renderSection`.
const getPinnedNotes = vi.fn<IndexQueryService['getPinnedNotes']>()
const getNote = vi.fn<IndexQueryService['getNote']>()
const readNoteSource = vi.fn<NoteDocumentService['readSource']>()
const commitNoteFrontmatter = vi.fn<NoteDocumentService['commitFrontmatter']>()
let noteSource: string

// The services of the rendered app; set by `renderSection`.
let operations: TestOperationsService
let trash: MockInstance<NoteActionsService['trashOne']>

/**
 * The shelf as the sidebar reads it, as comma-joined titles.
 */
function PinnedTitles() {
  const titles = usePinnedNotes().map((note) => note.title)
  return <output data-testid="pinned" data-titles={titles.join(',')} />
}

function pinnedTitles(): string | null {
  return page.getByTestId('pinned').element().getAttribute('data-titles')
}

/**
 * The section for `path` over app fakes, in a graph where `secure` is an
 * editable local-only folder and `archive` a read-only one. `width` narrows
 * the sidebar column.
 */
async function renderSection(path: string, showTrash = false, copies = 1, width?: number) {
  operations = createTestOperationsService()
  const app = createTestCoreServices({
    progress: operations,
    noteDocuments: {
      readSource: readNoteSource,
      readExisting: async (notePath) => await readNoteSource(notePath),
      commitFrontmatter: commitNoteFrontmatter,
      commitSourceEdit: () => Promise.reject(new Error('commitSourceEdit is not stubbed')),
      isOstensiblyEmpty: isOstensiblyEmptyNoteSource,
    },
    platform: createTestPlatformService({
      isNativeShell: false,
      isMacosDesktop: false,
      isApplePlatform: false,
      hasMacosTitleBarOverlay: false,
    }),
  })
  vi.spyOn(app.indexQuery, 'getPinnedNotes').mockImplementation(getPinnedNotes)
  vi.spyOn(app.indexQuery, 'getNote').mockImplementation(getNote)
  trash = vi.spyOn(app.noteActions, 'trashOne').mockResolvedValue({ trashed: 'system' })
  const view = await renderInApp(
    <>
      {Array.from({ length: copies }, (_, copy) => (
        <div
          key={copy}
          data-testid={`copy-${copy}`}
          style={width === undefined ? undefined : { width }}
        >
          <NoteActionsSection path={path} showTrash={showTrash} />
        </div>
      ))}
      <PinnedTitles />
    </>,
    {
      app,
      graph: {
        root: '/g',
        name: 'g',
        generation: 7,
        localOnlyFolders: ['secure', 'archive'],
        localOnlyEditableFolders: ['secure'],
      },
      route: { kind: 'note', path },
    },
  )
  return Object.assign(view, { client: view.queryClient })
}

beforeEach(() => {
  getPinnedNotes.mockReset().mockResolvedValue([])
  getNote.mockReset().mockResolvedValue(noteRow('notes/a.md', false))
  noteSource = '# A\n'
  readNoteSource.mockReset().mockImplementation(async () => noteSource)
  commitNoteFrontmatter.mockReset().mockImplementation(async (_path, patch) => {
    noteSource = upsertFrontmatter(noteSource, frontmatterPatchToYaml(patch))
  })
})

function noteRow(path: string, isPrivate: boolean, title = 'A'): NoteRow {
  return {
    path,
    title,
    dailyDate: null,
    isPrivate,
    hasConflict: false,
    gistUrl: null,
    gistStale: false,
  }
}

describe('NoteActionsSection pin toggle', () => {
  it('offers Pin this note with the platform-formatted hint and toggles on click', async () => {
    const view = await renderSection('notes/a.md')
    const button = view.getByRole('button', { name: /Pin this note/ })
    // The mocked platform is non-Apple, so Mod renders as Ctrl.
    expect(button.element().textContent).toContain('CtrlO')
    await userEvent.click(button)
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/a.md', { pinned: 1024 }, 7)
  })

  it('offers Un-pin this note when the index lists the note as pinned', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'daily/2026-06-10.md', title: 'June 10th, 2026', dailyDate: '2026-06-10' },
    ])
    noteSource = '---\npinned: true\n---\n# A\n'
    const view = await renderSection('daily/2026-06-10.md')
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('daily/2026-06-10.md', { pinned: false }, 7)
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    // The index still reports unpinned; the toggle's resolved state bridges
    // the watcher round-trip so a second click can't invert the user's intent.
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    noteSource = '---\npinned: true\n---\n# A\n'
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    await expect.element(view.getByText('Pin this note', { exact: true })).toBeInTheDocument()
    expect(commitNoteFrontmatter).toHaveBeenCalledTimes(2)
  })

  it('updates the button and shelf while the pin write is still pending', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const view = await renderSection('notes/a.md')
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(1))
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    expect(pinnedTitles()).toBe('A')
    write.resolve()
    await write.promise
  })

  it('optimistically adds a newly pinned note after explicitly ordered pins', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/zeta.md', title: 'Zeta', dailyDate: null, pinnedOrder: 0 },
      { path: 'notes/alpha.md', title: 'Alpha', dailyDate: null, pinnedOrder: 1 },
    ])
    getNote.mockResolvedValue(noteRow('notes/mid.md', false, 'Mid'))
    const view = await renderSection('notes/mid.md')
    await vi.waitFor(() => expect(pinnedTitles()).toBe('Zeta,Alpha'))

    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))

    await vi.waitFor(() => expect(pinnedTitles()).toBe('Zeta,Alpha,Mid'))
  })

  it('reverts the pin when the write fails', async () => {
    let rejectToggle!: (cause: unknown) => void
    commitNoteFrontmatter.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectToggle = reject
        }),
    )
    const view = await renderSection('notes/a.md')
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(1))

    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    rejectToggle({ kind: 'io', message: 'disk on fire' })

    await expect.element(view.getByText('Pin this note', { exact: true })).toBeInTheDocument()
    expect(pinnedTitles()).toBe('')
    expect(operations.findByLabel('Updating pin')?.status).toBe('failed')
  })
})

describe('NoteActionsSection for a local-only note', () => {
  it('offers no actions in a read-only folder: each would write or publish the note', async () => {
    getNote.mockResolvedValue(noteRow('archive/2019/bank.md', true))
    const view = await renderSection('archive/2019/bank.md', true)
    await expect
      .element(view.getByRole('button', { name: /Make this note standard/ }))
      .not.toBeInTheDocument()
    await expect
      .element(view.getByRole('button', { name: /Pin this note/ }))
      .not.toBeInTheDocument()
    expect(view.getByTestId('copy-0').element().textContent).toBe('')
  })

  it('offers only Pin and Trash in an editable folder', async () => {
    getNote.mockResolvedValue(noteRow('finance/secure/bank.md', true))
    const view = await renderSection('finance/secure/bank.md', true)

    await expect.element(view.getByRole('button', { name: /Pin this note/ })).toBeVisible()
    await expect.element(view.getByRole('button', { name: 'Trash note' })).toBeVisible()
    // Its privacy is its folder's, never a toggle, and nothing publishes it.
    expect(
      view.getByRole('button', { name: /Make this note (private|standard)/ }).query(),
    ).toBeNull()
    expect(view.getByRole('button', { name: /private link|Unpublish/ }).query()).toBeNull()
  })

  it('says so when the system Trash refused a note and the graph’s trash kept it', async () => {
    const view = await renderSection('finance/secure/bank.md', true)
    trash.mockResolvedValue({ trashed: 'graph' })
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))
    await expect
      .element(page.getByRole('dialog'))
      .toMatchTextContent('by way of a private holding folder')
    await userEvent.click(page.getByRole('dialog').getByRole('button', { name: 'Trash note' }))

    await vi.waitFor(() =>
      expect(operations.findByLabel('Trashing note')).toMatchObject({
        status: 'warning',
        message: KEPT_IN_GRAPH_TRASH,
      }),
    )
    expect(trash).toHaveBeenCalledWith('finance/secure/bank.md')
  })
})

describe('NoteActionsSection private toggle', () => {
  it('offers Private and toggles on click', async () => {
    const view = await renderSection('notes/a.md')
    expect(
      view
        .getByRole('button', { name: /^Make this note private\b/ })
        .element()
        .querySelector('.lucide-shield'),
    ).not.toBeNull()
    await userEvent.click(view.getByRole('button', { name: /Make this note private/ }))
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/a.md', { private: true }, 7)
  })

  it('offers Standard when the index reports the note private', async () => {
    getNote.mockResolvedValue(noteRow('daily/2026-06-10.md', true))
    noteSource = '---\nprivate: true\n---\n# A\n'
    const view = await renderSection('daily/2026-06-10.md')
    await expect.element(view.getByText('Make this note standard')).toBeInTheDocument()
    expect(
      view
        .getByRole('button', { name: /^Make this note standard\b/ })
        .element()
        .querySelector('.lucide-shield-off'),
    ).not.toBeNull()
    await userEvent.click(view.getByRole('button', { name: /Make this note standard/ }))
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('daily/2026-06-10.md', { private: false }, 7)
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Make this note private/ }))
    await expect.element(view.getByText('Make this note standard')).toBeInTheDocument()
    noteSource = '---\nprivate: true\n---\n# A\n'
    await userEvent.click(view.getByRole('button', { name: /Make this note standard/ }))
    await expect
      .element(view.getByText('Make this note private', { exact: true }))
      .toBeInTheDocument()
    expect(commitNoteFrontmatter).toHaveBeenCalledTimes(2)
  })

  it('shares an externally triggered privacy toggle with the button while saving', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    // The second copy is the other entry point: both read one note row cache.
    const view = await renderSection('notes/a.md', false, 2)
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledOnce())

    await userEvent.click(
      view.getByTestId('copy-1').getByRole('button', { name: /Make this note private/ }),
    )

    await expect
      .element(view.getByTestId('copy-0').getByText('Make this note standard'))
      .toBeInTheDocument()
    write.resolve()
    await write.promise
  })

  it.each([
    ['an unrecognized private value', '---\nprivate: maybe\n---\n# A\n'],
    [
      'a locking line in YAML that does not load',
      '---\nprivate: true\ntitle: [unclosed\n---\n# A\n',
    ],
  ])('shows %s as locked and disables the toggle', async (_case, source) => {
    getNote.mockResolvedValue(noteRow('notes/a.md', true))
    noteSource = source
    const view = await renderSection('notes/a.md')
    await expect
      .element(view.getByRole('button', { name: UNREADABLE_FRONTMATTER_LABEL }))
      .toBeDisabled()
    expect(view.getByRole('button', { name: /Make this note standard/ }).query()).toBeNull()
    expect(commitNoteFrontmatter).not.toHaveBeenCalled()
  })

  it('wraps the unreadable label instead of cutting it off in the narrowest sidebar', async () => {
    getNote.mockResolvedValue(noteRow('notes/a.md', true))
    noteSource = '---\nprivate: maybe\n---\n# A\n'
    const view = await renderSection('notes/a.md', false, 1, 240)
    const label = view.getByText(UNREADABLE_FRONTMATTER_LABEL)
    await expect.element(label).toBeVisible()
    const element = label.element()
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth)
  })

  it('restores the private label when a write fails', async () => {
    commitNoteFrontmatter.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Make this note private/ }))
    await expect
      .element(view.getByText('Make this note private', { exact: true }))
      .toBeInTheDocument()
    expect(operations.findByLabel('Updating privacy')?.status).toBe('failed')
  })
})

describe('NoteActionsSection deep-link action', () => {
  it('does not offer Copy deep link in note actions', async () => {
    const view = await renderSection('notes/a.md')
    expect(view.getByRole('button', { name: /Copy deep link/ }).query()).toBeNull()
  })
})

describe('NoteActionsSection trash action', () => {
  it('does not offer trash unless the note sidebar opts in', async () => {
    const view = await renderSection('notes/a.md')
    expect(view.getByRole('button', { name: 'Trash note' }).query()).toBeNull()
  })

  it('trashes an ordinary note after confirmation', async () => {
    const view = await renderSection('notes/a.md', true)
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))
    const confirmButton = page.getByRole('dialog').getByRole('button', { name: 'Trash note' })
    await userEvent.click(confirmButton)
    await vi.waitFor(() => expect(trash).toHaveBeenCalledWith('notes/a.md'))
    // Done, not a warning: it leaves once its minimum visible time is up.
    await vi.waitFor(() => expect(page.getByRole('dialog').query()).toBeNull())
    expect(operations.findByLabel('Trashing note')?.status).toBe('running')
    await operations.clock.advance(MIN_VISIBLE_MS)
    expect(operations.findByLabel('Trashing note')).toBeUndefined()
  })

  it('does not offer trash for daily notes even if enabled', async () => {
    const view = await renderSection('daily/2026-06-10.md', true)
    expect(view.getByRole('button', { name: 'Trash note' }).query()).toBeNull()
  })
})
