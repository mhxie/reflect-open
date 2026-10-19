import { page } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement } from 'react'
import type { Route } from '@reflect/app'
import type { GraphInfo } from '@reflect/core'
import { SidebarProvider, useSidebar } from '@/providers/sidebar-provider.tsx'
import { hover } from '@/test-utils/mouse.ts'
import { renderInApp } from '@/test-utils/render-in-app.tsx'

vi.mock('@/components/command-palette/command-palette.tsx', () => ({
  CommandPalette: () => null,
}))
vi.mock('@/components/context-sidebar/daily-context-sidebar.tsx', () => ({
  DailyContextSidebar: ({ date }: { date: string }) => (
    <div data-testid="daily-context">{date}</div>
  ),
}))
vi.mock('@/components/context-sidebar/note-context-sidebar.tsx', () => ({
  NoteContextSidebar: ({ path }: { path: string }) => <div data-testid="note-context">{path}</div>,
}))
vi.mock('@/components/embeddings-sync.tsx', () => ({ EmbeddingsSync: () => null }))
vi.mock('@/components/note-find-bar.tsx', () => ({ NoteFindBar: () => null }))
vi.mock('@/components/note-status-bar.tsx', () => ({ NoteStatusBar: () => null }))
vi.mock('@/components/peek/peek-panel.tsx', () => ({ PeekPanel: () => null }))
vi.mock('@/components/route-content.tsx', () => ({ RouteContent: () => <div>Route content</div> }))
vi.mock('@/components/search-ipc-responder.tsx', () => ({ SearchIpcResponder: () => null }))
vi.mock('@/components/shortcuts-dialog.tsx', () => ({ ShortcutsDialog: () => null }))
vi.mock('@/components/sidebar/sidebar.tsx', () => ({
  Sidebar: () => <div data-testid="workspace-sidebar" />,
}))
vi.mock('@/components/templates/template-create-dialog.tsx', () => ({
  TemplateCreateDialog: () => null,
}))
vi.mock('@/components/templates/template-picker.tsx', () => ({ TemplatePicker: () => null }))
vi.mock('@/components/outline/heading-picker.tsx', () => ({ HeadingPicker: () => null }))
vi.mock('@/routing/app-shortcuts.ts', () => ({ useAppShortcuts: () => ({}) }))

const { WorkspaceContent } = await import('./workspace-content.tsx')

const GRAPH: GraphInfo = {
  root: '/notes',
  name: 'Notes',
  generation: 1,
  localOnlyFolders: [],
  localOnlyEditableFolders: [],
}

/**
 * Stands in for the "Toggle sidebar" command, which lives in the mocked shortcuts.
 */
function SidebarToggle(): ReactElement {
  const { toggleSidebar } = useSidebar()
  return (
    <button type="button" onClick={toggleSidebar}>
      Toggle sidebar
    </button>
  )
}

function renderWorkspace(route: Route) {
  return renderInApp(
    <SidebarProvider>
      <WorkspaceContent graph={GRAPH} />
      <SidebarToggle />
    </SidebarProvider>,
    {
      graph: GRAPH,
      route,
      // The AppShell asides mount resize handles, which read the persisted widths.
      settings: { sidebarWidth: 260, contextSidebarWidth: 320 },
    },
  )
}

beforeEach(async () => {
  // The context sidebar is `hidden lg:block`, so it only renders on a
  // desktop-width viewport.
  await page.viewport(1280, 800)
})

afterEach(async () => {
  await page.viewport(900, 600)
})

describe('WorkspaceContent', () => {
  it('hides and restores the workspace and daily context sidebars together', async () => {
    const view = await renderWorkspace({ kind: 'daily', date: '2026-07-11' })
    const toggle = view.getByRole('button', { name: 'Toggle sidebar' })

    await expect.element(view.getByRole('complementary', { name: 'Workspace' })).toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Context' })).toBeInTheDocument()
    expect(view.getByTestId('daily-context').element().textContent).toBe('2026-07-11')

    await toggle.click()
    await expect
      .element(view.getByRole('complementary', { name: 'Workspace' }))
      .not.toBeInTheDocument()
    expect(view.getByRole('complementary', { name: 'Context' }).query()).toBeNull()

    await toggle.click()
    await expect.element(view.getByRole('complementary', { name: 'Workspace' })).toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Context' })).toBeInTheDocument()
  })

  it('applies the same collapsed state to ordinary note context', async () => {
    const view = await renderWorkspace({ kind: 'note', path: 'notes/project.md' })
    expect(view.getByTestId('note-context').element().textContent).toBe('notes/project.md')

    await view.getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect
      .element(view.getByRole('complementary', { name: 'Context' }))
      .not.toBeInTheDocument()
  })

  it('floats the hidden workspace sidebar back over the content from the window edge', async () => {
    const view = await renderWorkspace({ kind: 'daily', date: '2026-07-11' })
    await view.getByRole('button', { name: 'Toggle sidebar' }).click()
    await expect
      .element(view.getByRole('complementary', { name: 'Workspace' }))
      .not.toBeInTheDocument()

    await hover(view.getByTestId('sidebar-reveal-edge'))

    await expect.element(view.getByTestId('workspace-sidebar')).toBeInTheDocument()
    await expect.element(view.getByRole('complementary', { name: 'Workspace' })).toBeVisible()
    expect(view.getByRole('complementary', { name: 'Context' }).query()).toBeNull()
  })

  it('offers no edge reveal while the sidebar is shown', async () => {
    const view = await renderWorkspace({ kind: 'daily', date: '2026-07-11' })
    await expect.element(view.getByRole('complementary', { name: 'Workspace' })).toBeInTheDocument()
    expect(view.getByTestId('sidebar-reveal-edge').query()).toBeNull()
  })
})
