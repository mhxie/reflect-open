import type { ReactElement, ReactNode } from 'react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type {
  AttachmentService,
  BackupState,
  NoteActionsService,
  NoteState,
  NoteStateKind,
} from '@reflect/core'
import {
  createTestBackupService,
  createTestCoreServices,
  createTestNoteFileService,
  createTestPlatformService,
  type TestBackupService,
  type TestCoreServices,
} from '@reflect/core/testing'
import type { NoteProtection } from '@/editor/status/note-protection.ts'
import {
  clearNoteStatus,
  publishNoteStatus,
  type NoteStatus,
  type NoteStatusScope,
} from '@/editor/status/note-status-store.ts'
import type { Route } from '@/routing/route.ts'
import '@/test-utils/locator.ts'
import { PeekProvider, usePeek } from '@/components/peek/peek-provider.tsx'
import { toast } from '@/components/ui/toast.tsx'
import { TooltipProvider } from '@/components/ui/tooltip.tsx'
import { requestNoteMenu } from '@/editor/status/note-menu-request.ts'
import { act } from '@/test-utils/act.ts'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { NoteStatusBar } from './note-status-bar.tsx'

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

const CONNECTED: BackupState = {
  phase: 'connected',
  remoteUrl: 'https://github.com/test/notes',
  repo: null,
  status: { state: 'idle' },
}

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

interface BarOptions {
  readonly placement?: 'overlay' | 'inline'
  /** A retained mobile screen's note, as `NoteStatusBar`'s `path` prop. */
  readonly path?: string
  readonly generation?: number
  readonly root?: string
  /** The open graph's backup state; disconnected by default. */
  readonly backup?: BackupState
  readonly statusBarEnabled?: boolean
  readonly mobile?: boolean
  /** The indexed mtime of every note (epoch ms). */
  readonly mtime?: number | null
  readonly files?: Readonly<Record<string, string>>
  /** Wraps the bar, e.g. in a Peek provider. */
  readonly around?: (bar: ReactNode) => ReactNode
  readonly writeText?: (text: string) => Promise<void>
}

// The services of the rendered bar; set by `renderBar`.
let app: TestCoreServices
let backup: TestBackupService
let reveal: MockInstance<AttachmentService['reveal']>
let togglePrivate: MockInstance<NoteActionsService['togglePrivate']>

async function renderBar(initialRoute: Route, options: BarOptions = {}) {
  backup = createTestBackupService({ state: options.backup ?? { phase: 'disconnected' } })
  app = createTestCoreServices({
    backup,
    noteFile: createTestNoteFileService({ files: { ...options.files } }),
    ...(options.mobile === true ? { platform: createTestPlatformService(MOBILE_PLATFORM) } : {}),
  })
  app.clock.setToday('2026-10-03')
  app.gitRepository.onNoteVersion(() => 'abc123def4')
  const mtime = options.mtime ?? null
  vi.spyOn(app.indexQuery, 'getNoteMtime').mockImplementation(() =>
    Promise.resolve(mtime ?? undefined),
  )
  reveal = vi.spyOn(app.attachments, 'reveal').mockResolvedValue()
  togglePrivate = vi
    .spyOn(app.noteActions, 'togglePrivate')
    .mockResolvedValue({ status: 'done', isPrivate: true, changed: true })
  const bar = (
    <NoteStatusBar
      placement={options.placement ?? 'overlay'}
      {...(options.path === undefined ? {} : { path: options.path })}
    />
  )
  return await renderInApp(options.around === undefined ? bar : options.around(bar), {
    app,
    graph: {
      root: options.root ?? '/g',
      name: 'g',
      generation: options.generation ?? 7,
    },
    settings: {
      statusBarEnabled: options.statusBarEnabled ?? true,
      timeFormat: '12h',
      dateFormat: 'mdy',
    },
    route: initialRoute,
    ...(options.writeText === undefined
      ? {}
      : { appServices: { clipboard: { writeText: options.writeText } } }),
  })
}

/** The paths and generations the bar asked Git for a note version. */
function noteVersionCalls(): unknown[][] {
  return app.gitRepository
    .calls()
    .filter((call) => call.method === 'noteVersion')
    .map((call) => [...call.args])
}

/** Each menu row's label, without the explanatory hints. */
async function detailValues(): Promise<(string | null)[]> {
  const menu = page.getByRole('menu')
  await expect.element(menu).toBeVisible()
  return [...menu.element().querySelectorAll('[data-testid="note-menu-label"]')].map(
    (node) => node.textContent?.trim() ?? null,
  )
}

/** Open a protected note's menu and its recovery panel. */
async function openRecovery(states: string): Promise<void> {
  await page.getByRole('button', { name: `Note state: ${states}` }).click()
  await page.getByRole('menuitem', { name: /Resolve…/ }).click()
  await expect.element(page.getByRole('dialog', { name: 'Resolve note' })).toBeVisible()
}

afterEach(() => {
  for (const scope of publishedScopes.splice(0)) {
    clearNoteStatus(scope, owner)
  }
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
    await openRecovery('Protected')

    await expect.element(page.getByText('The editor cannot save', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: 'Show file', exact: true }).click()

    expect(reveal).toHaveBeenCalledWith('notes/source.md', 7)
    await expect.element(page.getByRole('button', { name: 'Note state: Protected' })).toBeVisible()
  })

  it('keeps protection and reports a failed file reveal', async () => {
    publishStatus('notes/source.md', {
      characters: 42,
      selectedCharacters: 0,
      editedAt: null,
      state: states.protected,
      protection: { kind: 'unsupported-markdown' },
    })
    await renderBar({ kind: 'note', path: 'notes/source.md' })
    reveal.mockRejectedValueOnce(new Error('File is unavailable'))
    await openRecovery('Protected')
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
    await openRecovery('Protected, Local-only')

    await expect.element(page.getByText('Folder is unavailable', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Try again', exact: true }).click()

    expect(retrySave).toHaveBeenCalledOnce()
    expect(reveal).not.toHaveBeenCalled()
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
    await openRecovery('Protected')
    await expect.element(page.getByRole('button', { name: 'Show file' })).toBeVisible()

    const retrySave = vi.fn()
    await act(() => {
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
    publishStatus('notes/source.md', {
      characters: 42,
      selectedCharacters: 0,
      editedAt: null,
      state: states.protected,
      protection: { kind: 'unsupported-markdown' },
    })
    await renderBar(
      { kind: 'note', path: 'notes/source.md' },
      { placement: 'inline', mobile: true },
    )
    await openRecovery('Protected')

    await expect.element(page.getByText('The editor cannot save', { exact: false })).toBeVisible()
    expect(page.getByRole('button', { name: 'Show file' }).query()).toBeNull()
    expect(reveal).not.toHaveBeenCalled()
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
    publishStatus('notes/a.md', { characters: 1234, selectedCharacters: 0, editedAt: null })
    const view = await renderBar({ kind: 'note', path: 'notes/a.md' }, { statusBarEnabled: false })

    expect(view.container.querySelector('[role="status"]')).toBeNull()
    expect(noteVersionCalls()).toEqual([])
  })

  it('shows when the note was last edited, preferring a newer in-pane edit', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' }, { mtime: Date.now() - 5 * 60_000 })
    const status = page.getByRole('status', { name: 'Note status' })
    await expect.element(status.getByText('Edited 5 min ago')).toBeVisible()

    await act(() => {
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
    await expect.element(page.getByRole('menu')).toBeVisible()

    document.dispatchEvent(new MouseEvent('mousemove'))
    await vi.waitFor(() => expect(statistics().className).not.toContain('opacity-0'))
  })

  it('follows a peeked note, above the Peek backdrop', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    publishStatus('notes/peeked.md', { characters: 77, selectedCharacters: 0, editedAt: null })
    const view = await renderBar(
      { kind: 'note', path: 'notes/a.md' },
      {
        around: (bar) => (
          <PeekProvider>
            <PeekOpener />
            {bar}
          </PeekProvider>
        ),
      },
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
    await renderBar(
      { kind: 'note', path: 'notes/a.md' },
      { around: (bar) => <TooltipProvider delay={0}>{bar}</TooltipProvider> },
    )
    await userEvent.hover(page.getByRole('button', { name: 'Note state: Read-only, Local-only' }))

    await expect.element(page.getByText('Read-only · Local-only', { exact: true })).toBeVisible()
  })

  it('opens full dimensions with the keyboard and restores focus after Escape', async () => {
    publishStatus('notes/a.md', {
      characters: 10,
      selectedCharacters: 0,
      editedAt: null,
      state: states.private,
    })
    await renderBar({ kind: 'note', path: 'notes/a.md' }, { backup: CONNECTED })
    const button = page.getByRole('button', { name: 'Note state: Private' })
    // The version is looked up only while the details are open.
    expect(noteVersionCalls()).toEqual([])
    await userEvent.tab()
    await expect.element(button).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    const dialog = page.getByRole('menu')
    await expect.element(dialog).toBeVisible()
    await vi.waitFor(async () =>
      expect(await detailValues()).toEqual(['Private', 'Editable', 'Backed up', 'abc123def4']),
    )
    await expect.element(dialog.getByText('Never sent to AI or other services.')).toBeVisible()
    await expect
      .element(dialog.getByRole('menuitemcheckbox', { name: 'Private' }))
      .toHaveAttribute('aria-checked', 'true')
    expect(noteVersionCalls()).toContainEqual(['notes/a.md', 7])

    await userEvent.keyboard('{Escape}')
    await expect.element(dialog).not.toBeInTheDocument()
    await expect.element(button).toHaveFocus()
  })

  it('updates protection and live graph sync without changing privacy policy', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' }, { backup: CONNECTED })
    await page.getByRole('button', { name: 'Note state: Editable' }).click()

    await act(() => {
      backup.setState({ ...CONNECTED, status: { state: 'offline', message: 'offline' } })
      publishStatus('notes/a.md', {
        characters: 10,
        selectedCharacters: 0,
        editedAt: null,
        state: states.protected,
      })
    })

    await expect.element(page.getByRole('button', { name: 'Note state: Protected' })).toBeVisible()
    await vi.waitFor(async () =>
      expect(await detailValues()).toEqual(['Standard', 'Paused', 'Offline', 'abc123def4']),
    )
  })

  it('keeps one horizontal row and hides the time before a narrow footer wraps', async () => {
    publishStatus('notes/a.md', { characters: 1234, selectedCharacters: 0, editedAt: null })
    const view = await renderBar(
      { kind: 'note', path: 'notes/a.md' },
      { mtime: Date.now() - 60_000 },
    )
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
      { placement: 'inline', path: 'daily/2026-10-02.md' },
    )

    await expect.element(page.getByText('77 chars')).toBeVisible()
    const bar = view.container.querySelector<HTMLElement>('[role="status"]')!
    expect(getComputedStyle(bar).position).toBe('static')
    await page.getByRole('button', { name: 'Note state: Local-only' }).click()
    expect(await detailValues()).toEqual(['Local-only', 'Editable', 'Never backed up'])
    expect(page.getByRole('menuitemcheckbox', { name: 'Private' }).query()).toBeNull()
    // A local-only note stays out of Git, its version included.
    expect(noteVersionCalls()).toEqual([])
  })

  it('reads the same path only from its graph file generation', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    publishStatus('notes/a.md', { characters: 77, selectedCharacters: 0, editedAt: null }, 8)
    await renderBar({ kind: 'note', path: 'notes/a.md' }, { root: '/second', generation: 8 })

    await expect.element(page.getByText('77 chars')).toBeVisible()
    await expect.element(page.getByText('10 chars')).not.toBeInTheDocument()
  })

  it('keeps secondary-window backup initialization unknown until its state is known', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' }, { backup: { phase: 'loading' } })
    await page.getByRole('button', { name: 'Note state: Editable' }).click()

    await vi.waitFor(async () =>
      expect(await detailValues()).toEqual(['Private', 'Editable', 'Checking', 'abc123def4']),
    )
  })

  it('toggles privacy from the details through the shared note action', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    await page.getByRole('button', { name: 'Note state: Editable' }).click()

    const privacy = page.getByRole('menuitemcheckbox', { name: 'Private' })
    await expect.element(privacy).toHaveAttribute('aria-checked', 'false')
    await privacy.click()

    await vi.waitFor(() => expect(togglePrivate).toHaveBeenCalledWith('notes/a.md'))
    await act(() => {
      publishStatus('notes/a.md', {
        characters: 10,
        selectedCharacters: 0,
        editedAt: null,
        state: states.private,
      })
    })
    await expect.element(page.getByRole('button', { name: 'Note state: Private' })).toBeVisible()
    await expect.element(privacy).toHaveAttribute('aria-checked', 'true')
  })

  it('keeps a locked note with unreadable frontmatter locked', async () => {
    publishStatus('notes/a.md', {
      characters: 10,
      selectedCharacters: 0,
      editedAt: null,
      state: states.private,
    })
    await renderBar(
      { kind: 'note', path: 'notes/a.md' },
      // An unrecognized `private:` value locks the note but can't be toggled.
      { files: { 'notes/a.md': '---\nprivate: maybe\n---\n# A\n' } },
    )
    await page.getByRole('button', { name: 'Note state: Private' }).click()

    await expect
      .element(page.getByRole('menuitemcheckbox', { name: 'Private' }))
      .toHaveAttribute('aria-disabled', 'true')
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

    await expect.element(page.getByRole('menuitem', { name: /Resolve…/ })).toBeVisible()
    expect(page.getByRole('menuitemcheckbox', { name: 'Private' }).query()).toBeNull()
    await vi.waitFor(async () =>
      expect(await detailValues()).toEqual([
        'Unsupported Markdown',
        'Standard',
        'Paused',
        'Backup off',
        'abc123def4',
      ]),
    )
  })

  it('moves between actionable items with the arrow keys and copies the version', async () => {
    const writeText = vi.fn(async (_text: string) => {})
    const add = vi.spyOn(toast, 'add')
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await renderBar({ kind: 'note', path: 'notes/a.md' }, { writeText })
    page.getByRole('button', { name: 'Note state: Editable' }).element().focus()
    await userEvent.keyboard('{Enter}')

    const privacy = page.getByRole('menuitemcheckbox', { name: 'Private' })
    const version = page.getByRole('menuitem', { name: 'Copy version abc123def4' })
    await expect.element(privacy).toHaveFocus()
    await expect.element(version).toBeInTheDocument()
    // Facts are disabled items a screen reader still reaches.
    await userEvent.keyboard('{ArrowDown}')
    await expect.element(page.getByRole('menuitem', { name: 'Editable' })).toHaveFocus()
    await expect
      .element(page.getByRole('menuitem', { name: 'Editable' }))
      .toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{End}')
    await expect.element(version).toHaveFocus()
    await userEvent.keyboard('{Home}')
    await expect.element(privacy).toHaveFocus()
    await userEvent.keyboard('{End}{Enter}')

    expect(writeText).toHaveBeenCalledWith('abc123def4')
    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: 'Version copied' })),
    )
    await expect.element(page.getByRole('menu')).not.toBeInTheDocument()
    add.mockRestore()
  })

  it('opens on a request for its note and never replays one made for another', async () => {
    publishStatus('notes/a.md', { characters: 10, selectedCharacters: 0, editedAt: null })
    await act(() => {
      requestNoteMenu('notes/b.md')
    })
    await renderBar({ kind: 'note', path: 'notes/a.md' })
    await expect.element(page.getByTestId('note-statistics')).toHaveTextContent('10 chars')
    expect(page.getByRole('menu').query()).toBeNull()

    await act(() => {
      requestNoteMenu('notes/a.md')
    })
    await expect.element(page.getByRole('menu')).toBeVisible()
  })
})
