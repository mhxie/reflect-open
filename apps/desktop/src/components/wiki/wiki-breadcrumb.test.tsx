import { createTestCoreServices } from '@reflect/core/testing'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { deepLinkForRoute } from '@reflect/app'
import type { WikiAncestor, WikiLanguage } from '@reflect/core'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { WikiBreadcrumb } from './wiki-breadcrumb.tsx'

const LANGUAGES: WikiLanguage[] = [
  { label: 'English', folder: 'wiki' },
  { label: '简体中文', folder: 'wiki-cn' },
]

const wikiAncestors =
  vi.fn<(path: string, languages: readonly WikiLanguage[]) => Promise<WikiAncestor[]>>()

async function renderBreadcrumb(path: string) {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  vi.spyOn(app.wiki, 'ancestors').mockImplementation(wikiAncestors)
  return await renderInApp(
    <div data-testid="host">
      <WikiBreadcrumb path={path} />
    </div>,
    {
      core: app,
      graph: { root: '/g', name: 'g', generation: 1 },
      settings: { wikiLanguages: LANGUAGES },
    },
  )
}

type BreadcrumbView = Awaited<ReturnType<typeof renderBreadcrumb>>

function probedRoute(view: BreadcrumbView): unknown {
  return view.appServices.navigation.getState().route
}

beforeEach(() => {
  window.sessionStorage.clear()
  wikiAncestors.mockReset().mockResolvedValue([
    { path: 'wiki-cn/index.md', title: 'Wiki 索引', displayTitle: null, lang: 'zh-CN' },
    { path: 'wiki-cn/memory/index.md', title: '记忆', displayTitle: null, lang: 'zh-CN' },
  ])
})

describe('WikiBreadcrumb', () => {
  it('shows the indexes above a note, root first, on one line, each opening in place', async () => {
    const view = await renderBreadcrumb('wiki-cn/memory/Spacing Effect.md')

    const trail = view.getByRole('navigation', { name: 'Wiki path' })
    await expect.element(trail.getByRole('button', { name: 'Wiki 索引，中文' })).toBeVisible()
    const crumbs = [...trail.element().querySelectorAll('button')]
    expect(crumbs.map((crumb) => crumb.textContent)).toEqual(['Wiki 索引中文', '记忆中文'])
    expect(new Set(crumbs.map((crumb) => crumb.getBoundingClientRect().top)).size).toBe(1)
    expect(wikiAncestors).toHaveBeenCalledWith('wiki-cn/memory/Spacing Effect.md', LANGUAGES)

    await trail.getByRole('button', { name: '记忆，中文' }).click()

    expect(probedRoute(view)).toEqual({ kind: 'note', path: 'wiki-cn/memory/index.md' })
  })

  it('opens an index in a new window on a modifier click', async () => {
    const view = await renderBreadcrumb('wiki-cn/memory/Spacing Effect.md')

    await view
      .getByRole('button', { name: 'Wiki 索引，中文' })
      .click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() => {
      expect(view.appServices.window.openedNoteWindows()).toContain(
        deepLinkForRoute({ kind: 'note', path: 'wiki-cn/index.md' }),
      )
    })
  })

  it('holds its line while the lookup runs, so the title below does not jump', async () => {
    wikiAncestors.mockReturnValue(new Promise(() => {}))
    const view = await renderBreadcrumb('wiki/memory/Spacing Effect.md')

    await expect.element(view.getByTestId('wiki-path-pending')).toBeInTheDocument()
    const pending = view.getByTestId('wiki-path-pending').element()
    expect(pending.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(view.getByRole('navigation', { name: 'Wiki path' }).query()).toBeNull()
  })

  it('takes no space when the lookup fails', async () => {
    wikiAncestors.mockRejectedValue(new Error('index unavailable'))
    const view = await renderBreadcrumb('wiki/memory/Spacing Effect.md')

    await vi.waitFor(() => expect(wikiAncestors).toHaveBeenCalled())
    await vi.waitFor(() => expect(view.getByTestId('host').element().childElementCount).toBe(0))
  })

  it('takes no space when no index exists above a note', async () => {
    wikiAncestors.mockResolvedValue([])
    const view = await renderBreadcrumb('wiki/memory/Spacing Effect.md')

    await vi.waitFor(() => expect(view.getByTestId('host').element().childElementCount).toBe(0))
  })

  it('never asks the index where no index could sit above the note', async () => {
    for (const path of ['wiki/index.md', 'notes/plan.md']) {
      const view = await renderBreadcrumb(path)
      expect(view.getByTestId('host').element().childElementCount).toBe(0)
      await view.unmount()
    }
    expect(wikiAncestors).not.toHaveBeenCalled()
  })
})
