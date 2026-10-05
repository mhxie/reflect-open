import { render } from 'vitest-browser-react'
import { userEvent } from 'vitest/browser'
import { describe, expect, it } from 'vitest'
import { hover } from '@/test-utils/mouse.ts'
import { SIDEBAR_HIDE_DELAY_MS } from '@/hooks/use-sidebar-hover-reveal.ts'
import { SidebarHoverReveal } from './sidebar-hover-reveal.tsx'

function renderReveal() {
  return render(
    <div style={{ width: 800, height: 400 }}>
      <SidebarHoverReveal>
        <nav aria-label="Primary">
          <button type="button">All notes</button>
          <button type="button" aria-expanded="false" data-testid="menu-trigger">
            Graph
          </button>
        </nav>
      </SidebarHoverReveal>
      <div style={{ marginLeft: 400, height: 200 }}>
        <button type="button">Editor</button>
      </div>
    </div>,
  )
}

/** Wait out the hide grace so a dismissal that should not happen would have. */
async function outlastHideDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SIDEBAR_HIDE_DELAY_MS * 2))
}

describe('SidebarHoverReveal', () => {
  it('stays hidden until the pointer rests on the window edge', async () => {
    const view = await renderReveal()
    expect(view.getByRole('complementary', { name: 'Workspace' }).query()).toBeNull()

    await hover(view.getByTestId('sidebar-reveal-edge'))

    await expect.element(view.getByRole('complementary', { name: 'Workspace' })).toBeVisible()
    await expect.element(view.getByRole('button', { name: 'All notes' })).toBeVisible()
  })

  it('stays while the pointer is over it and slides away once it leaves', async () => {
    const view = await renderReveal()
    await hover(view.getByTestId('sidebar-reveal-edge'))
    const sidebar = view.getByRole('complementary', { name: 'Workspace' })
    await expect.element(sidebar).toBeVisible()

    await hover(view.getByRole('button', { name: 'All notes' }))
    await outlastHideDelay()
    await expect.element(sidebar).toBeVisible()

    await hover(view.getByRole('button', { name: 'Editor' }))
    await expect.element(sidebar).not.toBeInTheDocument()
  })

  it('holds while one of its menus is open, since menu content portals outside', async () => {
    const view = await renderReveal()
    await hover(view.getByTestId('sidebar-reveal-edge'))
    const sidebar = view.getByRole('complementary', { name: 'Workspace' })
    await expect.element(sidebar).toBeVisible()
    view.getByTestId('menu-trigger').element().setAttribute('aria-expanded', 'true')

    await hover(view.getByRole('button', { name: 'Editor' }))
    await outlastHideDelay()
    await expect.element(sidebar).toBeVisible()

    view.getByTestId('menu-trigger').element().setAttribute('aria-expanded', 'false')
    await hover(view.getByRole('button', { name: 'Editor' }), {
      position: { x: 4, y: 4 },
    })
    await expect.element(sidebar).not.toBeInTheDocument()
  })

  it('Escape dismisses it', async () => {
    const view = await renderReveal()
    await hover(view.getByTestId('sidebar-reveal-edge'))
    const sidebar = view.getByRole('complementary', { name: 'Workspace' })
    await expect.element(sidebar).toBeVisible()

    await userEvent.keyboard('{Escape}')

    await expect.element(sidebar).not.toBeInTheDocument()
  })
})
