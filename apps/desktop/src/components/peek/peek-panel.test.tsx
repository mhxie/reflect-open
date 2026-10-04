import { cleanup, render } from 'vitest-browser-react'
import { page, userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import { RouterProvider, useRouter } from '@/routing/router.tsx'
import { routeForPath } from '@/routing/route.ts'
import '@/test-utils/locator.ts'
import { PeekPanel } from './peek-panel.tsx'
import { PeekProvider, usePeek, usePeekNavigation } from './peek-provider.tsx'

const openPaths = vi.hoisted(() => new Set<string>())
const openRouteInNewWindow = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/editor/open-documents.ts', () => ({
  openSession: (path: string) => (openPaths.has(path) ? {} : null),
}))
vi.mock('@/components/note-pane.tsx', () => ({
  NotePane: ({ path }: { path: string }) => <p>pane:{path}</p>,
}))
vi.mock('@/hooks/use-note-row.ts', () => ({ useNoteRow: () => null }))
vi.mock('./pdf-peek-pages.tsx', () => ({
  PdfPeekPages: ({ path }: { path: string }) => <p>pages:{path}</p>,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({
  useGraph: () => ({ graph: { root: '/g', name: 'g', generation: 3 } }),
}))
const openAsset = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  openAsset,
}))
vi.mock('@/lib/use-today.ts', () => ({ useToday: () => '2026-10-03' }))
vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({ settings: { dateFormat: 'mdy' } }),
}))
vi.mock('@/lib/windows/open-in-new-window.ts', () => ({ openRouteInNewWindow }))

const PAST = 'daily/2025-10-03.md'

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

function renderPeek() {
  return render(
    <RouterProvider>
      <PeekProvider>
        <Opener path={PAST} />
        <PdfOpener />
        <PeekPanel />
        <RouteProbe />
      </PeekProvider>
    </RouterProvider>,
  )
}

const dialog = () => page.getByRole('dialog', { name: 'Peek: Fri, October 3rd, 2025' })

beforeEach(() => {
  openPaths.clear()
  openRouteInNewWindow.mockClear()
})

afterEach(async () => {
  await cleanup()
})

describe('Peek', () => {
  it('floats the note over the editor instead of navigating', async () => {
    await renderPeek()

    await userEvent.click(page.getByRole('button', { name: `open ${PAST}` }))

    await expect.element(dialog()).toBeVisible()
    await expect.element(dialog().getByText(`pane:${PAST}`)).toBeVisible()
    await expect.element(page.getByTestId('route')).toHaveTextContent('{"kind":"today"}')
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
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('leaves a ⌘-click to the new-window path', async () => {
    await renderPeek()

    await userEvent.click(page.getByRole('button', { name: `open ${PAST}` }), {
      modifiers: ['Meta'],
    })

    await vi.waitFor(() => expect(openRouteInNewWindow).toHaveBeenCalled())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('reads a PDF page by page, with a way out to its default app', async () => {
    await renderPeek()

    await userEvent.click(page.getByRole('button', { name: 'open pdf' }))

    const pdf = page.getByRole('dialog', { name: 'Peek: a.pdf' })
    await expect.element(pdf.getByText('pages:papers/a.pdf')).toBeVisible()
    await userEvent.click(pdf.getByRole('button', { name: 'Open in default app' }))
    expect(openAsset).toHaveBeenCalledWith('papers/a.pdf', 3)
  })
})
