import { act, type ReactElement } from 'react'
import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NoteState, NoteStateKind } from '@reflect/core'
import type { NoteProtection } from '@/editor/status/note-protection.ts'
import { setPlatformSurface } from '@/lib/platform-surface.ts'
import {
  clearNoteStatus,
  publishNoteStatus,
  type NoteStatus,
  type NoteStatusScope,
} from '@/editor/status/note-status-store.ts'
import type { useNoteGitVersion } from '@/hooks/use-note-git-version.ts'
import type { BackupState } from '@/providers/sync-provider.tsx'
import type { Route } from '@/routing/route.ts'
import { RouterProvider } from '@/routing/router.tsx'
import '@/test-utils/locator.ts'
import { PeekProvider, usePeek } from '@/components/peek/peek-provider.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { NoteStatusBar } from './note-status-bar.tsx'

const revealAsset = vi.hoisted(() => vi.fn(async (_path: string, _generation: number) => {}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  revealAsset,
}))

vi.mock('@/lib/use-today.ts', () => ({ useToday: () => '2026-10-03' }))
const settings = vi.hoisted(() => ({
  statusBarEnabled: true,
  timeFormat: '12h',
  dateFormat: 'mdy',
}))
vi.mock('@/providers/settings-provider.tsx', () => ({ useSettings: () => ({ settings }) }))
const mtime = vi.hoisted(() => ({ value: null as number | null }))
vi.mock('@/hooks/use-note-mtime.ts', () => ({ useNoteMtime: () => mtime.value }))
const graph = vi.hoisted(() => ({
  value: { root: '/g', name: 'g', generation: 7 },
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: graph.value, indexGeneration: 99 }),
}))
const sync = vi.hoisted((): { backup: BackupState } => ({
  backup: { phase: 'disconnected' },
}))
vi.mock('@/providers/sync-provider.tsx', () => ({ useSyncContext: () => sync }))
const gitVersion = vi.hoisted(() => {
  const current: { value: ReturnType<typeof useNoteGitVersion> } = {
    value: { version: 'abc123def4', pending: false, unavailable: false },
  }
  return { current, use: vi.fn<typeof useNoteGitVersion>(() => current.value) }
})
vi.mock('@/hooks/use-note-git-version.ts', () => ({ useNoteGitVersion: gitVersion.use }))
const toggleNotePrivate = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/note-private.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/note-private.ts')>()),
  toggleNotePrivate,
}))
const unreadable = vi.hoisted(() => ({ value: false }))
vi.mock('@/hooks/use-unreadable-frontmatter.ts', () => ({
  useUnreadableFrontmatter: () => unreadable.value,
}))

const EDITABLE: NoteState = {
  kind: 'editable',
  isPrivate: false,
  isLocalOnly: false,
  isReadOnly: false,
  isProtected: false,
}
const states: Record<NoteStateKind, NoteState> = {
  editable: EDITABLE,
  private: { ...EDITABLE, kind: 'private', isPrivate: true },
  'local-only': {
    ...EDITABLE,
    kind: 'local-only',
    isPrivate: true,
    isLocalOnly: true,
  },
  'read-only': {
    ...EDITABLE,
    kind: 'read-only',
    isPrivate: true,
    isLocalOnly: true,
    isReadOnly: true,
  },
  protected: {
    ...EDITABLE,
    kind: 'protected',
    isReadOnly: true,
    isProtected: true,
  },
}
const owner = Symbol('test')
const publishedScopes: NoteStatusScope[] = []

function publishStatus(
  path: string,
  status: Omit<NoteStatus, 'state' | 'protection'> & {
    state?: NoteState
    protection?: NoteProtection | null
  },
  generation = 7,
): void {
  const scope = { generation, path }
  publishedScopes.push(scope)
  publishNoteStatus(scope, owner, { state: EDITABLE, protection: null, ...status })
}

function PeekOpener(): ReactElement {
  const peek = usePeek()
  return (
    <button
      type="button"
      onClick={() =>
        peek?.openPeek({
          kind: 'note',
          path: 'notes/peeked.md',
          route: { kind: 'note', path: 'notes/peeked.md' },
        })
      }
    >
      peek
    </button>
  )
}

function renderBar(
  initialRoute: Route,
  placement: 'overlay' | 'inline' = 'overlay',
  path?: string,
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider initialRoute={initialRoute}>
        <NoteStatusBar placement={placement} {...(path === undefined ? {} : { path })} />
      </RouterProvider>
    </QueryClientProvider>,
  )
}

/** Each menu row's label, without the explanatory hints. */
function detailValues(): (string | null)[] {
  const dialog = page.getByRole('dialog', { name: 'Note details' })
  return [...dialog.element().querySelectorAll('[data-testid="note-menu-label"]')].map(
    (node) => node.textContent?.trim() ?? null,
  )
}

afterEach(async () => {
  await cleanup()
  for (const scope of publishedScopes.splice(0)) {
    clearNoteStatus(scope, owner)
  }
  settings.statusBarEnabled = true
  mtime.value = null
  graph.value = { root: '/g', name: 'g', generation: 7 }
  sync.backup = { phase: 'disconnected' }
  gitVersion.current.value = { version: 'abc123def4', pending: false, unavailable: false }
  gitVersion.use.mockClear()
  revealAsset.mockReset()
  toggleNotePrivate.mockClear()
  unreadable.value = false
  setPlatformSurface({ mobileApp: false })
})

describe('NoteStatusBar', () => {
  it('explains unsupported Markdown and reveals the exact note in its graph generation', async () => {
    publishStatus('notes/source.md', {
      characters: 42,
      selectedCharacters: 0,
      editedAt: null,
      state: states.protected,
      protection: { kind: 'unsupported-markdown' },
    })
    await renderBar({ kind: 'note', path: 'notes/source.md' })
    await page.getByRole('button', { name: 'Note state: Protected' }).click()

    await expect.element(page.getByText('Unsupported Markdown', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Show file', exact: true }).click()

    expect(revealAsset).toHaveBeenCalledWith('notes/source.md', 7)
    await expect.element(page.getByRole('button', { name: 'Note state: Protected' })).toBeVisible()
  })

  it('keeps protection and reports a failed file reveal', async () => {
    revealAsset.mockRejectedValueOnce(new Error('File is unavailable'))
    publishStatus('notes/source.md', {
      characters: 42,
      selectedCharacters: 0,
      editedAt: null,
      state: states.protected,
      protection: { kind: 'unsupported-markdown' },
    })
    await renderBar({ kind: 'note', path: 'notes/source.md' })
    await page.getByRole('button', { name: 'Note state: Protected' }).click()
    await page.getByRole('button', { name: 'Show file', exact: true }).click()

    await expect.element(page.getByRole('alert')).toHaveTextContent('File is unavailable')
    await expect.element(page.getByRole('button', { name: 'Note state: Protected' })).toBeVisible()
  })

  it('offers the existing save retry with the concrete blocking error', async () => {
    const retrySave = vi.fn()
    publishStatus('notes/local.md', {
      characters: 42,
      selectedCharacters: 0,
      editedAt: null,
      state: { ...states.protected, isPrivate: true, isLocalOnly: true },
      protection: { kind: 'save-blocked', message: 'Folder is unavailable', retrySave },
    })
    await renderBar({ kind: 'note', path: 'notes/local.md' })
    await page.getByRole('button', { name: 'Note state: Protected, Local-only' }).click()

    await expect.element(page.getByText('Folder is unavailable', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Try again', exact: true }).click()

    expect(retrySave).toHaveBeenCalledOnce()
    expect(revealAsset).not.toHaveBeenCalled()
  })

  it('offers both conflict choices when an external change blocks save recovery', async () => {
    const keepMine = vi.fn()
    const loadTheirs = vi.fn()
    publishStatus('notes/local.md', {
      characters: 42,
      selectedCharacters: 0,
      editedAt: null,
      state: { ...states.protected, isPrivate: true, isLocalOnly: true },
      protection: {
        kind: 'external-change',
        message: 'Folder is unavailable',
        keepMine,
        loadTheirs,
      },
    })
    await renderBar({ kind: 'note', path: 'notes/local.md' })
    await page.getByRole('button', { name: 'Note state: Protected, Local-only' }).click()

    await expect.element(page.getByText('External change', { exact: true })).toBeVisible()
    expect(page.getByRole('button', { name: 'Try again', exact: true }).query()).toBeNull()
    await page.getByRole('button', { name: 'Keep mine', exact: true }).click()
    await page.getByRole('button', { name: 'Load theirs', exact: true }).click()

    expect(keepMine).toHaveBeenCalledOnce()
    expect(loadTheirs).toHaveBeenCalledOnce()
  })

  it('updates recovery when the reason changes while Protected stays open', async () => {
    const initial = {
      characters: 42,
      selectedCharacters: 0,
      editedAt: null,
      state: states.protected,
    }
    publishStatus('notes/recovery.md', {
      ...initial,
      protection: { kind: 'unsupported-markdown' },
    })
    await renderBar({ kind: 'note', path: 'notes/recovery.md' })
    await page.getByRole('button', { name: 'Note state: Protected' }).click()
    await expect.element(page.getByRole('button', { name: 'Show file' })).toBeVisible()

    const retrySave = vi.fn()
    await act(async () => {
      publishStatus('notes/recovery.md', {
        ...initial,
        protection: { kind: 'save-blocked', message: 'Permission denied', retrySave },
      })
    })

    await expect.element(page.getByText('Saving blocked', { exact: true })).toBeVisible()
    expect(page.getByRole('button', { name: 'Show file' }).query()).toBeNull()
    await page.getByRole('button', { name: 'Try again' }).click()
    expect(retrySave).toHaveBeenCalledOnce()
    await expect.element(page.getByTestId('note-statistics')).toHaveTextContent('42 chars')
  })

  it('explains unsupported Markdown on mobile without offering desktop file reveal', async () => {
    setPlatformSurface({ mobileApp: true })
    publishStatus('notes/source.md', {
      characters: 42,
      selectedCharacters: 0,
      editedAt: null,
      state: states.protected,
      protection: { kind: 'unsupported-markdown' },
    })
    await renderBar({ kind: 'note', path: 'notes/source.md' }, 'inline')
    await page.getByRole('button', { name: 'Note state: Protected' }).click()

    await expect.element(page.getByText('Unsupported Markdown', { exact: true })).toBeVisible()
    expect(page.getByRole('button', { name: 'Show file' }).query()).toBeNull()
    expect(revealAsset).not.toHaveBeenCalled()
  })

  it('shows the routed note’s live character count', async () => {
    publishStatus('notes/a.md', { characters: 1234, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' })

    await expect.element(page.getByTestId('note-statistics')).toHaveTextContent('1,234 chars')
  })

  it('follows today’s daily note on the daily stream', async () => {
    publishStatus('daily/2026-10-03.md', { characters: 42, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'today' })

    await expect.element(page.getByTestId('note-statistics')).toHaveTextContent('42 chars')
  })

  it('stays out of screens that edit no note', async () => {
    publishStatus('notes/a.md', { characters: 1234, selectedCharacters: 0, editedAt: null })
    const view = await renderBar({ kind: 'allNotes', filter: null })

    expect(view.container.querySelector('[role="status"]')).toBeNull()
  })

  it('stays hidden when turned off in settings', async () => {
    settings.statusBarEnabled = false
    publishStatus('notes/a.md', { characters: 1234, selectedCharacters: 0, editedAt: null })
    const view = await renderBar({ kind: 'note', path: 'notes/a.md' })

    expect(view.container.querySelector('[role="status"]')).toBeNull()
    expect(gitVersion.use).toHaveBeenLastCalledWith(expect.objectContaining({ open: false }))
  })

  it('shows when the note was last edited, preferring a newer in-pane edit', async () => {
    mtime.value = Date.now() - 5 * 60_000
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    const status = page.getByRole('status', { name: 'Note status' })
    await expect.element(status.getByText('Edited 5 min ago')).toBeVisible()

    await act(async () => {
      publishStatus('notes/a.md', {
        characters: 11,
        selectedCharacters: 0,
        editedAt: Date.now(),
      })
    })
    await expect.element(status.getByText('Edited just now')).toBeVisible()
  })

  it('counts the selection against the whole note', async () => {
    publishStatus('notes/a.md', { characters: 1234, selectedCharacters: 38, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' })

    await expect.element(page.getByTestId('note-statistics')).toHaveTextContent('38 / 1,234 chars')
  })

  it('fades only the statistics while typing and keeps the state entry usable', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    const view = await renderBar({ kind: 'note', path: 'notes/a.md' })
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    view.container.append(editor)
    const statistics = () =>
      view.container.querySelector<HTMLElement>('[data-testid="note-statistics"]')!

    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    await vi.waitFor(() => expect(statistics().className).toContain('opacity-0'))
    expect(view.container.querySelector('[role="status"]')!.className).not.toContain('opacity-0')
    await page.getByRole('button', { name: 'Note state: Editable' }).click()
    await expect.element(page.getByRole('dialog', { name: 'Note details' })).toBeVisible()

    document.dispatchEvent(new MouseEvent('mousemove'))
    await vi.waitFor(() => expect(statistics().className).not.toContain('opacity-0'))
  })

  it('follows a peeked note, above the Peek backdrop', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    publishStatus('notes/peeked.md', { characters: 77, selectedCharacters: 0, editedAt: null })
    const view = await render(
      <RouterProvider initialRoute={{ kind: 'note', path: 'notes/a.md' }}>
        <PeekProvider>
          <PeekOpener />
          <NoteStatusBar />
        </PeekProvider>
      </RouterProvider>,
    )
    const bar = page.getByRole('status', { name: 'Note status' })
    await expect.element(bar.getByText('10 chars')).toBeVisible()

    await userEvent.click(page.getByRole('button', { name: 'peek' }))

    await expect.element(bar.getByText('77 chars')).toBeVisible()
    expect(view.container.querySelector('[role="status"]')!.className).toContain('z-30')
  })

  it.each([
    { state: states.editable, kinds: ['editable'], labels: ['Editable'] },
    { state: states.private, kinds: ['private'], labels: ['Private'] },
    { state: states['local-only'], kinds: ['local-only'], labels: ['Local-only'] },
    {
      state: states['read-only'],
      kinds: ['read-only', 'local-only'],
      labels: ['Read-only', 'Local-only'],
    },
    { state: states.protected, kinds: ['protected'], labels: ['Protected'] },
    {
      state: { ...states.protected, isPrivate: true },
      kinds: ['protected', 'private'],
      labels: ['Protected', 'Private'],
    },
  ])('shows an icon for every state that applies: $labels', async ({ state, kinds, labels }) => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null, state })
    await renderBar({ kind: 'note', path: 'notes/a.md' })

    const button = page.getByRole('button', { name: `Note state: ${labels.join(', ')}` })
    await expect.element(button).toBeVisible()
    const badges = [...button.element().querySelectorAll('[data-testid="note-state-badge"]')]
    expect(badges.map((badge) => badge.getAttribute('data-state'))).toEqual(kinds)
    expect(button.element().textContent?.trim()).toBe('')
  })

  it('names the states in a tooltip on the icon-only trigger', async () => {
    publishStatus('notes/a.md', {
      characters: 10,
      selectedCharacters: 0,
      editedAt: null,
      state: states['read-only'],
    })
    await render(
      <TooltipProvider delay={0}>
        <QueryClientProvider client={new QueryClient()}>
          <RouterProvider initialRoute={{ kind: 'note', path: 'notes/a.md' }}>
            <NoteStatusBar />
          </RouterProvider>
        </QueryClientProvider>
      </TooltipProvider>,
    )
    await userEvent.hover(page.getByRole('button', { name: 'Note state: Read-only, Local-only' }))

    await expect.element(page.getByText('Read-only · Local-only', { exact: true })).toBeVisible()
  })

  it('opens full dimensions with the keyboard and restores focus after Escape', async () => {
    sync.backup = {
      phase: 'connected',
      remoteUrl: 'https://github.com/test/notes',
      repo: null,
      status: { state: 'idle' },
    }
    publishStatus('notes/a.md', {
      characters: 10,
      selectedCharacters: 0,
      editedAt: null,
      state: states.private,
    })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    const button = page.getByRole('button', { name: 'Note state: Private' })
    expect(gitVersion.use).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 7, path: 'notes/a.md', open: false }),
    )
    await userEvent.tab()
    await expect.element(button).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    const dialog = page.getByRole('dialog', { name: 'Note details' })
    await expect.element(dialog).toBeVisible()
    expect(detailValues()).toEqual(['Private', 'Editable', 'Backed up', 'abc123def4'])
    await expect.element(dialog.getByText('Never sent to AI or other services.')).toBeVisible()
    await expect
      .element(dialog.getByRole('button', { name: 'Private' }))
      .toHaveAttribute('aria-pressed', 'true')
    expect(gitVersion.use).toHaveBeenLastCalledWith(
      expect.objectContaining({ root: '/g', generation: 7, path: 'notes/a.md', open: true }),
    )

    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    await expect.element(button).toHaveFocus()
  })

  it('updates protection and live graph sync without changing privacy policy', async () => {
    sync.backup = {
      phase: 'connected',
      remoteUrl: 'https://github.com/test/notes',
      repo: null,
      status: { state: 'idle' },
    }
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    await page.getByRole('button', { name: 'Note state: Editable' }).click()

    await act(async () => {
      sync.backup = {
        phase: 'connected',
        remoteUrl: 'https://github.com/test/notes',
        repo: null,
        status: { state: 'offline', message: 'offline' },
      }
      publishStatus('notes/a.md', {
        characters: 10,
        selectedCharacters: 0,
        editedAt: null,
        state: states.protected,
      })
    })

    await expect.element(page.getByRole('button', { name: 'Note state: Protected' })).toBeVisible()
    expect(detailValues()).toEqual(['Standard', 'Paused', 'Offline', 'abc123def4'])
  })

  it('keeps one horizontal row and hides the time before a narrow footer wraps', async () => {
    mtime.value = Date.now() - 60_000
    publishStatus('notes/a.md', { characters: 1234, selectedCharacters: 0, editedAt: null })
    const view = await renderBar({ kind: 'note', path: 'notes/a.md' })
    view.container.style.position = 'relative'
    view.container.style.width = '520px'
    view.container.style.height = '60px'
    const time = page.getByTestId('note-edit-time')
    await expect.element(time).toBeVisible()

    view.container.style.width = '320px'
    await expect.element(time).not.toBeVisible()
    const button = page
      .getByRole('button', { name: 'Note state: Editable' })
      .element()
      .getBoundingClientRect()
    const statistics = page.getByTestId('note-statistics').element().getBoundingClientRect()
    expect(
      Math.abs((button.top + button.bottom) / 2 - (statistics.top + statistics.bottom) / 2),
    ).toBeLessThan(2)
    expect(
      page.getByRole('status', { name: 'Note status' }).element().getBoundingClientRect().height,
    ).toBeLessThan(28)
    await expect.element(page.getByText('1,234 chars')).toBeVisible()
  })

  it('uses the explicit mobile screen path in an inline row', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    publishStatus('daily/2026-10-02.md', {
      characters: 77,
      selectedCharacters: 0,
      editedAt: null,
      state: states['local-only'],
    })
    const view = await renderBar(
      { kind: 'note', path: 'notes/a.md' },
      'inline',
      'daily/2026-10-02.md',
    )

    await expect.element(page.getByText('77 chars')).toBeVisible()
    const bar = view.container.querySelector<HTMLElement>('[role="status"]')!
    expect(getComputedStyle(bar).position).toBe('static')
    await page.getByRole('button', { name: 'Note state: Local-only' }).click()
    expect(gitVersion.use).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: 'daily/2026-10-02.md', isLocalOnly: true }),
    )
    expect(detailValues()).toEqual(['Local-only', 'Editable', 'Never backed up'])
    expect(page.getByRole('button', { name: 'Private' }).query()).toBeNull()
  })

  it('reads the same path only from its graph file generation', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    publishStatus('notes/a.md', { characters: 77, selectedCharacters: 0, editedAt: null }, 8)
    graph.value = { root: '/second', name: 'second', generation: 8 }
    await renderBar({ kind: 'note', path: 'notes/a.md' })

    await expect.element(page.getByText('77 chars')).toBeVisible()
    await expect.element(page.getByText('10 chars')).not.toBeInTheDocument()
  })

  it('keeps secondary-window backup initialization unknown until its state is known', async () => {
    sync.backup = { phase: 'loading' }
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    await page.getByRole('button', { name: 'Note state: Editable' }).click()

    expect(detailValues()).toEqual(['Private', 'Editable', 'Checking', 'abc123def4'])
  })

  it('toggles privacy from the details through the shared note action', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    await page.getByRole('button', { name: 'Note state: Editable' }).click()

    const privacy = page.getByRole('button', { name: 'Private', exact: true })
    await expect.element(privacy).toHaveAttribute('aria-pressed', 'false')
    await privacy.click()

    expect(toggleNotePrivate).toHaveBeenCalledWith(
      expect.objectContaining({ root: '/g', generation: 7, path: 'notes/a.md' }),
    )
    await act(async () => {
      publishStatus('notes/a.md', {
        characters: 10,
        selectedCharacters: 0,
        editedAt: null,
        state: states.private,
      })
    })
    await expect.element(page.getByRole('button', { name: 'Note state: Private' })).toBeVisible()
    await expect.element(privacy).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps a locked note with unreadable frontmatter locked', async () => {
    unreadable.value = true
    publishStatus('notes/a.md', {
      characters: 10,
      selectedCharacters: 0,
      editedAt: null,
      state: states.private,
    })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    await page.getByRole('button', { name: 'Note state: Private' }).click()

    await expect.element(page.getByRole('button', { name: 'Private', exact: true })).toBeDisabled()
    await expect
      .element(page.getByText("Fix this note's frontmatter to lock or unlock it."))
      .toBeVisible()
  })

  it('offers no privacy toggle while the note is protected', async () => {
    publishStatus('notes/a.md', {
      characters: 10,
      selectedCharacters: 0,
      editedAt: null,
      state: states.protected,
      protection: { kind: 'unsupported-markdown' },
    })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    await page.getByRole('button', { name: 'Note state: Protected' }).click()

    await expect.element(page.getByText('Unsupported Markdown', { exact: true })).toBeVisible()
    expect(page.getByRole('button', { name: 'Private', exact: true }).query()).toBeNull()
    expect(detailValues()).toEqual(['Standard', 'Paused', 'Backup off', 'abc123def4'])
  })

  it('moves between actionable rows with the arrow keys and copies the version', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    await page.getByRole('button', { name: 'Note state: Editable' }).click()

    const privacy = page.getByRole('button', { name: 'Private', exact: true })
    const version = page.getByRole('button', { name: 'Copy version abc123def4' })
    privacy.element().focus()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(version).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(privacy).toHaveFocus()
    await userEvent.keyboard('{End}')
    await expect.element(version).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    expect(writeText).toHaveBeenCalledWith('abc123def4')
    await expect.element(version.getByText('Copied', { exact: true })).toBeVisible()
    writeText.mockRestore()
  })
})
