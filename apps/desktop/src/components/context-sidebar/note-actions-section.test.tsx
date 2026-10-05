import { upsertFrontmatter, type PinnedNote } from '@reflect/core'
import { frontmatterPatchToYaml, type FrontmatterPatch } from '@/editor/note-session.ts'
import { render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { queryKeys } from '@/lib/query-client.ts'
import { RouterProvider } from '@/routing/router.tsx'
import { NoteActionsSection } from './note-actions-section.tsx'

const getPinnedNotes = vi.hoisted(() => vi.fn())
const getNote = vi.hoisted(() => vi.fn())
const noteSource = vi.hoisted(() => ({ value: '# A\n' }))
const readNoteSource = vi.hoisted(() => vi.fn(async () => noteSource.value))
const commitNoteFrontmatter = vi.hoisted(() =>
  vi.fn<(path: string, patch: FrontmatterPatch, generation: number) => Promise<void>>(),
)
vi.mock('@/lib/note-frontmatter.ts', () => ({ readNoteSource, commitNoteFrontmatter }))
const deleteOpenNote = vi.hoisted(() =>
  vi.fn<(path: string, generation: number) => Promise<{ trashed: 'system' | 'graph' } | null>>(),
)
const operationFail = vi.hoisted(() => vi.fn())
const operationWarn = vi.hoisted(() => vi.fn())
const operationDone = vi.hoisted(() => vi.fn())
const startOperation = vi.hoisted(() =>
  vi.fn(() => ({
    progress: vi.fn(),
    done: operationDone,
    fail: operationFail,
    warn: operationWarn,
  })),
)
const isApplePlatform = vi.hoisted(() => vi.fn(() => false))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  hasBridge: () => true,
  getPinnedNotes,
  getNote,
  // `secure` is an editable local-only folder, `archive` a read-only one.
  isLocalOnlyPath: (path: string) =>
    path.startsWith('finance/secure/') || path.startsWith('archive/'),
  isLocalOnlyReadOnlyPath: (path: string) => path.startsWith('archive/'),
}))
vi.mock('@/lib/keybindings.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/keybindings.ts')>()),
  isApplePlatform,
}))
vi.mock('@/lib/note-delete.ts', () => ({
  deleteOpenNote,
  KEPT_IN_GRAPH_TRASH: 'Moved to .reflect/trash in this graph',
}))
vi.mock('@/lib/operations.ts', () => ({ startOperation }))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 7 } }),
}))

async function renderSection(path: string, showTrash = false, width?: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = await render(
    <TooltipProvider>
      <QueryClientProvider client={client}>
        <RouterProvider initialRoute={{ kind: 'note', path }}>
          <div style={width === undefined ? undefined : { width }}>
            <NoteActionsSection path={path} showTrash={showTrash} />
          </div>
        </RouterProvider>
      </QueryClientProvider>
    </TooltipProvider>,
  )
  return { ...view, client }
}

beforeEach(() => {
  window.sessionStorage.clear()
  getPinnedNotes.mockReset().mockResolvedValue([])
  getNote.mockReset().mockResolvedValue(noteRow('notes/a.md', false))
  noteSource.value = '# A\n'
  readNoteSource.mockReset().mockImplementation(async () => noteSource.value)
  commitNoteFrontmatter.mockReset().mockImplementation(async (_path, patch) => {
    noteSource.value = upsertFrontmatter(noteSource.value, frontmatterPatchToYaml(patch))
  })
  deleteOpenNote.mockReset().mockResolvedValue({ trashed: 'system' })
  startOperation.mockClear()
  operationFail.mockClear()
  operationWarn.mockClear()
  operationDone.mockClear()
  isApplePlatform.mockReturnValue(false)
})

function noteRow(path: string, isPrivate: boolean, title = 'A') {
  return { path, title, dailyDate: null, isPrivate }
}

describe('NoteActionsSection pin toggle', () => {
  it('offers Pin this note with the platform-formatted hint and toggles on click', async () => {
    const view = await renderSection('notes/a.md')
    const button = view.getByRole('button', { name: /Pin this note/ })
    // The mocked platform is non-Apple, so Mod renders as Ctrl.
    expect(button.element().textContent).toContain('CtrlO')
    await userEvent.click(button)
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('notes/a.md', { pinned: 1024 }, 7)
    await view.unmount()
  })

  it('offers Un-pin this note when the index lists the note as pinned', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'daily/2026-06-10.md', title: 'June 10th, 2026', dailyDate: '2026-06-10' },
    ])
    noteSource.value = '---\npinned: true\n---\n# A\n'
    const view = await renderSection('daily/2026-06-10.md')
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    expect(commitNoteFrontmatter).toHaveBeenCalledWith('daily/2026-06-10.md', { pinned: false }, 7)
    await view.unmount()
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    // The index still reports unpinned; the toggle's resolved state bridges
    // the watcher round-trip so a second click can't invert the user's intent.
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    noteSource.value = '---\npinned: true\n---\n# A\n'
    await userEvent.click(view.getByRole('button', { name: /Un-pin this note/ }))
    await expect.element(view.getByText('Pin this note', { exact: true })).toBeInTheDocument()
    expect(commitNoteFrontmatter).toHaveBeenCalledTimes(2)
    await view.unmount()
  })

  it('updates the button and shelf while the pin write is still pending', async () => {
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const view = await renderSection('notes/a.md')
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(1))
    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))
    await expect.element(view.getByText('Un-pin this note')).toBeInTheDocument()
    expect(
      view.client.getQueryData<PinnedNote[]>(queryKeys.index.pinnedNotes('/g'))?.[0]?.path,
    ).toBe('notes/a.md')
    write.resolve()
    await write.promise
    await view.unmount()
  })

  it('optimistically adds a newly pinned note after explicitly ordered pins', async () => {
    getPinnedNotes.mockResolvedValue([
      { path: 'notes/zeta.md', title: 'Zeta', dailyDate: null, pinnedOrder: 0 },
      { path: 'notes/alpha.md', title: 'Alpha', dailyDate: null, pinnedOrder: 1 },
    ])
    getNote.mockResolvedValue(noteRow('notes/mid.md', false, 'Mid'))
    const view = await renderSection('notes/mid.md')
    const queryKey = queryKeys.index.pinnedNotes('/g')
    await vi.waitFor(() =>
      expect(view.client.getQueryData<PinnedNote[]>(queryKey)?.map((note) => note.title)).toEqual([
        'Zeta',
        'Alpha',
      ]),
    )

    await userEvent.click(view.getByRole('button', { name: /Pin this note/ }))

    await vi.waitFor(() =>
      expect(view.client.getQueryData<PinnedNote[]>(queryKey)?.map((note) => note.title)).toEqual([
        'Zeta',
        'Alpha',
        'Mid',
      ]),
    )
    await view.unmount()
  })

  it('invalidates pinned notes when an optimistic pin fails', async () => {
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
    await vi.waitFor(() => expect(getPinnedNotes).toHaveBeenCalledTimes(2))
    expect(startOperation).toHaveBeenCalledWith('Updating pin')
    expect(operationFail).toHaveBeenCalled()
    await view.unmount()
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
    expect(view.container.textContent).toBe('')
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
    await view.unmount()
  })

  it('says so when the system Trash refused a note and the graph’s trash kept it', async () => {
    deleteOpenNote.mockResolvedValue({ trashed: 'graph' })
    const view = await renderSection('finance/secure/bank.md', true)
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))
    await expect
      .element(page.getByRole('dialog'))
      .toMatchTextContent('by way of a private holding folder')
    await userEvent.click(page.getByRole('dialog').getByRole('button', { name: 'Trash note' }))

    await vi.waitFor(() =>
      expect(operationWarn).toHaveBeenCalledWith('Moved to .reflect/trash in this graph'),
    )
    expect(deleteOpenNote).toHaveBeenCalledWith('finance/secure/bank.md', 7)
    expect(operationDone).not.toHaveBeenCalled()
    await view.unmount()
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
    await view.unmount()
  })

  it('offers Standard when the index reports the note private', async () => {
    getNote.mockResolvedValue(noteRow('daily/2026-06-10.md', true))
    noteSource.value = '---\nprivate: true\n---\n# A\n'
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
    await view.unmount()
  })

  it('flips the label from the toggle result before the index catches up', async () => {
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Make this note private/ }))
    await expect.element(view.getByText('Make this note standard')).toBeInTheDocument()
    noteSource.value = '---\nprivate: true\n---\n# A\n'
    await userEvent.click(view.getByRole('button', { name: /Make this note standard/ }))
    await expect
      .element(view.getByText('Make this note private', { exact: true }))
      .toBeInTheDocument()
    expect(commitNoteFrontmatter).toHaveBeenCalledTimes(2)
    await view.unmount()
  })

  it('shares an externally triggered privacy toggle with the button while saving', async () => {
    const { toggleNotePrivate } = await import('@/lib/note-private.ts')
    const write = Promise.withResolvers<void>()
    commitNoteFrontmatter.mockReturnValueOnce(write.promise)
    const view = await renderSection('notes/a.md')
    await vi.waitFor(() => expect(getNote).toHaveBeenCalledOnce())
    const action = toggleNotePrivate({
      queryClient: view.client,
      root: '/g',
      generation: 7,
      path: 'notes/a.md',
    })
    await expect.element(view.getByText('Make this note standard')).toBeInTheDocument()
    write.resolve()
    await action
    await view.unmount()
  })

  it.each([
    ['an unrecognized private value', '---\nprivate: maybe\n---\n# A\n'],
    [
      'a locking line in YAML that does not load',
      '---\nprivate: true\ntitle: [unclosed\n---\n# A\n',
    ],
  ])('shows %s as locked and disables the toggle', async (_case, source) => {
    getNote.mockResolvedValue(noteRow('notes/a.md', true))
    noteSource.value = source
    const view = await renderSection('notes/a.md')
    await expect
      .element(view.getByRole('button', { name: /Frontmatter can't be read — treated as locked/ }))
      .toBeDisabled()
    expect(view.getByRole('button', { name: /Make this note standard/ }).query()).toBeNull()
    expect(commitNoteFrontmatter).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('wraps the unreadable label instead of cutting it off in the narrowest sidebar', async () => {
    getNote.mockResolvedValue(noteRow('notes/a.md', true))
    noteSource.value = '---\nprivate: maybe\n---\n# A\n'
    const view = await renderSection('notes/a.md', false, 240)
    const label = view.getByText("Frontmatter can't be read — treated as locked")
    await expect.element(label).toBeVisible()
    const element = label.element()
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth)
    await view.unmount()
  })

  it('restores the private label when a write fails', async () => {
    commitNoteFrontmatter.mockRejectedValueOnce({ kind: 'io', message: 'disk on fire' })
    const view = await renderSection('notes/a.md')
    await userEvent.click(view.getByRole('button', { name: /Make this note private/ }))
    await expect
      .element(view.getByText('Make this note private', { exact: true }))
      .toBeInTheDocument()
    expect(startOperation).toHaveBeenCalledWith('Updating privacy')
    expect(operationFail).toHaveBeenCalled()
    await view.unmount()
  })
})

describe('NoteActionsSection deep-link action', () => {
  it('does not offer Copy deep link in note actions', async () => {
    const view = await renderSection('notes/a.md')
    expect(view.getByRole('button', { name: /Copy deep link/ }).query()).toBeNull()
    await view.unmount()
  })
})

describe('NoteActionsSection trash action', () => {
  it('does not offer trash unless the note sidebar opts in', async () => {
    const view = await renderSection('notes/a.md')
    expect(view.getByRole('button', { name: 'Trash note' }).query()).toBeNull()
    await view.unmount()
  })

  it('trashes an ordinary note after confirmation', async () => {
    const view = await renderSection('notes/a.md', true)
    await userEvent.click(view.getByRole('button', { name: 'Trash note' }))
    const confirmButton = page.getByRole('dialog').getByRole('button', { name: 'Trash note' })
    await userEvent.click(confirmButton)
    await vi.waitFor(() => expect(deleteOpenNote).toHaveBeenCalledWith('notes/a.md', 7))
    expect(startOperation).toHaveBeenCalledWith('Trashing note')
    await vi.waitFor(() => expect(operationDone).toHaveBeenCalled())
    expect(operationWarn).not.toHaveBeenCalled()
    await view.unmount()
  })

  it('does not offer trash for daily notes even if enabled', async () => {
    const view = await renderSection('daily/2026-06-10.md', true)
    expect(view.getByRole('button', { name: 'Trash note' }).query()).toBeNull()
    await view.unmount()
  })
})
