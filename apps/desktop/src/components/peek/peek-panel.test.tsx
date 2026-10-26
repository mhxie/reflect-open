import { createTestWindowService } from '@reflect/app/testing'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { ReactElement } from 'react'
import {
  createTestCoreServices,
  createTestNoteSession,
  type TestCoreServices,
} from '@reflect/core/testing'
import type { MaybePromise } from '@reflect/utils'
import { useRouter } from '@/routing/router.tsx'
import { routeForPath } from '@/routing/route.ts'
import '@/test-utils/locator.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { PeekPanel } from './peek-panel.tsx'
import { PeekProvider, usePeek, usePeekNavigation } from './peek-provider.tsx'

// Heavy children: the pane mounts the editor, the pages render the PDF.
vi.mock('@/components/note-pane.tsx', () => ({
  NotePane: ({ path, outline }: { path: string; outline?: boolean }) => (
    <p data-outline={String(outline === true)}>pane:{path}</p>
  ),
}))
vi.mock('./pdf-peek-pages.tsx', () => ({
  PdfPeekPages: ({ path }: { path: string }) => <p>pages:{path}</p>,
}))

const PAST = 'daily/2025-10-03.md'
const NOTE = 'notes/draft.md'

/** Notes open in a pane of this window: Peek navigates to them instead. */
let openPaths: Set<string>
const openNoteWindow = vi.fn<(deepLink: string) => MaybePromise<boolean>>()

function Opener({ path }: { path: string }): ReactElement {
  const navigate = usePeekNavigation()
  return (
    <button
      type="button"
      onClick={(event) => navigate({ target: routeForPath(path), openInNewWindow: event.metaKey })}
    >
      open {path}
    </button>
  )
}

function PdfOpener(): ReactElement {
  const peek = usePeek()
  return (
    <button type="button" onClick={() => peek?.openPeek({ kind: 'pdf', path: 'papers/a.pdf' })}>
      open pdf
    </button>
  )
}

function RouteProbe(): ReactElement {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

async function renderPeek(): Promise<TestCoreServices> {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  app.clock.setToday('2026-10-03')
  vi.spyOn(app.openDocuments, 'sessionFor').mockImplementation((path) => {
    return openPaths.has(path) ? createTestNoteSession({ path }) : null
  })
  await renderInApp(
    <PeekProvider>
      <Opener path={PAST} />
      <Opener path={NOTE} />
      <PdfOpener />
      <input aria-label="Editor underneath" />
      <PeekPanel />
      <RouteProbe />
    </PeekProvider>,
    {
      core: app,
      appServices: { window: createTestWindowService({ openNoteWindow }) },
      graph: { root: '/g', name: 'g', generation: 3 },
      settings: { dateFormat: 'mdy' },
    },
  )
  return app
}

const dialog = () => page.getByRole('dialog', { name: 'Peek: Fri, October 3rd, 2025' })

beforeEach(() => {
  openPaths = new Set()
  openNoteWindow.mockReset().mockResolvedValue(true)
})

describe('Peek', () => {
  it('floats the note over the editor instead of navigating', async () => {
    await renderPeek()

    await userEvent.click(page.getByRole('button', { name: `open ${PAST}` }))

    await expect.element(dialog()).toBeVisible()
    await expect.element(dialog().getByText(`pane:${PAST}`)).toBeVisible()
    await expect.element(page.getByTestId('route')).toHaveTextContent('{"kind":"today"}')
    // Its outline is published, so "Jump to heading…" works on the peeked note.
    await expect.element(dialog().getByText(`pane:${PAST}`)).toHaveAttribute('data-outline', 'true')
  })

  it('closes on Esc and on the close button', async () => {
    await renderPeek()
    await userEvent.click(page.getByRole('button', { name: `open ${PAST}` }))
    await expect.element(dialog()).toBeVisible()

    dialog().element().querySelector('button')!.focus()
    await userEvent.keyboard('{Escape}')
    await expect.element(dialog()).not.toBeInTheDocument()

    await userEvent.click(page.getByRole('button', { name: `open ${PAST}` }))
    await userEvent.click(dialog().getByRole('button', { name: 'Close' }))
    await expect.element(dialog()).not.toBeInTheDocument()
  })

  it('promotes the note to the main view with Open', async () => {
    await renderPeek()
    await userEvent.click(page.getByRole('button', { name: `open ${PAST}` }))

    await userEvent.click(dialog().getByRole('button', { name: 'Open in main view' }))

    await expect
      .element(page.getByTestId('route'))
      .toHaveTextContent('{"kind":"daily","date":"2025-10-03"}')
    await expect.element(dialog()).not.toBeInTheDocument()
  })

  it('navigates instead when the note is already open in a pane', async () => {
    openPaths.add(PAST)
    await renderPeek()

    await userEvent.click(page.getByRole('button', { name: `open ${PAST}` }))

    await expect
      .element(page.getByTestId('route'))
      .toHaveTextContent('{"kind":"daily","date":"2025-10-03"}')
    expect(page.getByRole('dialog').query()).toBeNull()
  })

  it('leaves a ⌘-click to the new-window path', async () => {
    await renderPeek()

    await userEvent.click(page.getByRole('button', { name: `open ${PAST}` }), {
      modifiers: ['Meta'],
    })

    await vi.waitFor(() => expect(openNoteWindow).toHaveBeenCalled())
    expect(page.getByRole('dialog').query()).toBeNull()
  })

  it('reads a PDF page by page, with a way out to its default app', async () => {
    const app = await renderPeek()

    await userEvent.click(page.getByRole('button', { name: 'open pdf' }))

    const pdf = page.getByRole('dialog', { name: 'Peek: a.pdf' })
    await expect.element(pdf.getByText('pages:papers/a.pdf')).toBeVisible()
    await userEvent.click(pdf.getByRole('button', { name: 'Open in default app' }))
    await vi.waitFor(() => expect(app.attachments.opened()).toEqual(['papers/a.pdf']))
  })

  it('takes focus for a PDF and closes it on Esc', async () => {
    await renderPeek()

    await userEvent.click(page.getByRole('button', { name: 'open pdf' }))

    const pdf = page.getByRole('dialog', { name: 'Peek: a.pdf' })
    await expect.element(pdf).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await expect.element(pdf).not.toBeInTheDocument()
  })

  it('closes on Esc while focus stays on the surface underneath', async () => {
    await renderPeek()
    await userEvent.click(page.getByRole('button', { name: 'open pdf' }))
    const pdf = page.getByRole('dialog', { name: 'Peek: a.pdf' })
    await expect.element(pdf).toBeVisible()

    const underneath = page.getByRole('textbox', { name: 'Editor underneath' })
    underneath.element().focus()
    await userEvent.keyboard('{Escape}')

    await expect.element(pdf).not.toBeInTheDocument()
  })

  it('follows a peeked note through a rename', async () => {
    const app = await renderPeek()
    await userEvent.click(page.getByRole('button', { name: `open ${NOTE}` }))
    await expect.element(page.getByText(`pane:${NOTE}`)).toBeVisible()

    app.noteMove.followHealedMove(NOTE, 'notes/final.md')

    const renamed = page.getByRole('dialog', { name: 'Peek: notes/final.md' })
    await expect.element(renamed.getByText('pane:notes/final.md')).toBeVisible()
    await userEvent.click(renamed.getByRole('button', { name: 'Open in main view' }))
    await expect
      .element(page.getByTestId('route'))
      .toHaveTextContent('{"kind":"note","path":"notes/final.md"}')
  })
})
