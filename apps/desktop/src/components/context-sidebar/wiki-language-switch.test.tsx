import { createTestWindowService } from '@reflect/app/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import type { WikiService } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import { deepLinkForRoute } from '@/lib/deep-links/format.ts'
import { useRouter } from '@/routing/router.tsx'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { WikiLanguageSwitch } from './wiki-language-switch.tsx'

const ENGLISH = { label: 'English', folder: 'wiki' }
const CHINESE = { label: '简体中文', folder: 'wiki-cn' }
const JAPANESE = { label: '日本語', folder: 'wiki-ja' }

const wikiCopies = vi.fn<WikiService['copies']>()
const openNoteWindow = vi.fn<(deepLink: string) => boolean | Promise<boolean>>()

function RouteProbe(): ReactNode {
  const { route } = useRouter()
  return <output data-testid="route">{JSON.stringify(route)}</output>
}

async function renderSection(path: string) {
  const app = createTestCoreServices()
  vi.spyOn(app.wiki, 'copies').mockImplementation(wikiCopies)
  return await renderInApp(
    <>
      <WikiLanguageSwitch path={path} />
      <RouteProbe />
    </>,
    {
      app,
      appServices: { window: createTestWindowService({ openNoteWindow }) },
      graph: { root: '/g', name: 'g' },
      settings: { wikiLanguages: [ENGLISH, CHINESE, JAPANESE] },
    },
  )
}

beforeEach(() => {
  openNoteWindow.mockReset().mockResolvedValue(true)
  wikiCopies.mockReset().mockResolvedValue([
    { language: ENGLISH, path: 'wiki/memory/Spacing Effect.md' },
    { language: CHINESE, path: 'wiki-cn/memory/Spacing Effect.md' },
    { language: JAPANESE, path: null },
  ])
})

describe('WikiLanguageSwitch', () => {
  it('presses the copy being read, on one line, and opens another language in place', async () => {
    const view = await renderSection('wiki/memory/Spacing Effect.md')

    const switcher = view.getByRole('group', { name: 'Language' })
    await expect
      .element(switcher.getByRole('button', { name: 'English' }))
      .toHaveAttribute('aria-pressed', 'true')
    const buttons = [...switcher.element().querySelectorAll('button')]
    expect(new Set(buttons.map((button) => button.getBoundingClientRect().top)).size).toBe(1)

    await view.getByRole('button', { name: 'English' }).click()
    // Pressing the copy being read stays put.
    expect(JSON.parse(view.getByTestId('route').element().textContent ?? 'null')).toEqual({
      kind: 'today',
    })

    await view.getByRole('button', { name: '简体中文' }).click()

    expect(JSON.parse(view.getByTestId('route').element().textContent ?? 'null')).toEqual({
      kind: 'note',
      path: 'wiki-cn/memory/Spacing Effect.md',
    })
  })

  it('opens a language in a new window on ⌘-click', async () => {
    const view = await renderSection('wiki/memory/Spacing Effect.md')

    await view.getByRole('button', { name: '简体中文' }).click({ modifiers: ['ControlOrMeta'] })

    await vi.waitFor(() =>
      expect(openNoteWindow).toHaveBeenCalledWith(
        deepLinkForRoute({ kind: 'note', path: 'wiki-cn/memory/Spacing Effect.md' }),
      ),
    )
  })

  it('dims a language without a copy', async () => {
    const view = await renderSection('wiki/memory/Spacing Effect.md')

    await expect
      .element(view.getByRole('button', { name: '日本語, not translated' }))
      .toBeDisabled()
  })

  it('renders nothing for a note outside the wiki', async () => {
    const view = await renderSection('notes/plan.md')

    expect(view.getByRole('group', { name: 'Language' }).query()).toBeNull()
    expect(wikiCopies).not.toHaveBeenCalled()
  })
})
