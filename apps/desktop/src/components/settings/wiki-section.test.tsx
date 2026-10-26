import { createTestCoreServices } from '@reflect/core/testing'
import { page } from 'vitest/browser'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings, type WikiLanguage } from '@reflect/core'
import { renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { WikiSection } from './wiki-section.tsx'

/**
 * Render the section. With `captureEdits`, its `updateWith` calls are recorded
 * and not applied: the spy must be in place before the render, since
 * `useSettings` hands out the service's function itself.
 */
async function renderSection({ captureEdits = false } = {}) {
  const app = createTestCoreServices({ database: createWasmTestDatabaseService() })
  onTestFinished(() => app.database.close())
  // The trust report row has its own test (wiki-trust-fields.test.tsx).
  app.ipc.onCommand('wiki_trust_report_read', () => null)
  const updateWith = vi.spyOn(app.settings, 'updateWith')
  if (captureEdits) {
    updateWith.mockImplementation(() => {})
  }
  const view = await renderInApp(<WikiSection />, { core: app })
  return Object.assign(view, { updateWith })
}

type SectionView = Awaited<ReturnType<typeof renderSection>>

function languages(view: SectionView): readonly WikiLanguage[] {
  return view.core.settings.get().wikiLanguages
}

/**
 * The languages the section's last `updateWith` would write over `saved` —
 * what the settings service applies an edit made before the stored settings
 * showed to.
 */
function appliedTo(
  updateWith: { mock: { calls: [(current: Settings) => Partial<Settings>][] } },
  saved: Partial<Settings>,
): unknown {
  const [updater] = updateWith.mock.calls.at(-1) ?? []
  return updater?.({ ...DEFAULT_SETTINGS, ...saved }).wikiLanguages
}

async function addLanguage(label: string, folder: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Language name' }).fill(label)
  await page.getByRole('textbox', { name: 'Language folder' }).fill(folder)
  await page.getByRole('button', { name: 'Add language' }).click()
}

describe('WikiSection', () => {
  it('lists the default languages with the source marked and only translations removable', async () => {
    const view = await renderSection()

    await expect.element(view.getByText('English')).toBeInTheDocument()
    await expect.element(view.getByText('Source')).toBeInTheDocument()
    await expect.element(view.getByText('wiki-cn/')).toBeInTheDocument()
    expect(view.getByRole('button', { name: 'Remove English' }).query()).toBeNull()

    await view.getByRole('button', { name: 'Remove 简体中文' }).click()

    expect(languages(view)).toEqual([{ label: 'English', folder: 'wiki' }])
  })

  it('adds a language with a normalized folder', async () => {
    const view = await renderSection()

    await addLanguage(' 日本語 ', '/wiki-ja/')

    expect(languages(view)).toEqual([
      { label: 'English', folder: 'wiki' },
      { label: '简体中文', folder: 'wiki-cn' },
      { label: '日本語', folder: 'wiki-ja' },
    ])
    await expect.element(view.getByRole('textbox', { name: 'Language folder' })).toHaveValue('')
  })

  it('never removes the saved source language, whatever was on screen', async () => {
    const view = await renderSection({ captureEdits: true })

    // On screen: the defaults. Saved: Chinese is the source.
    await view.getByRole('button', { name: 'Remove 简体中文' }).click()

    expect(
      appliedTo(view.updateWith, { wikiLanguages: [{ label: '简体中文', folder: 'wiki-cn' }] }),
    ).toEqual([{ label: '简体中文', folder: 'wiki-cn' }])
  })

  it('applies an edit to the saved languages even before they show', async () => {
    const view = await renderSection({ captureEdits: true })

    await addLanguage('Deutsch', 'wiki-de')

    expect(
      appliedTo(view.updateWith, {
        wikiLanguages: [
          { label: 'English', folder: 'wiki' },
          { label: '日本語', folder: 'wiki-ja' },
        ],
      }),
    ).toEqual([
      { label: 'English', folder: 'wiki' },
      { label: '日本語', folder: 'wiki-ja' },
      { label: 'Deutsch', folder: 'wiki-de' },
    ])
  })

  it('explains a missing name, an invalid folder, and a folder already in use', async () => {
    const view = await renderSection()

    await addLanguage('', 'wiki-ja')
    await expect.element(view.getByText(/Give the language a name/)).toBeInTheDocument()

    await addLanguage('日本語', '../outside')
    await expect.element(view.getByText(/can't be a folder/)).toBeInTheDocument()

    await addLanguage('Chinese', 'wiki-cn')
    await expect.element(view.getByText(/is already a wiki folder/)).toBeInTheDocument()
    await view.core.settings.flush()
    expect(view.core.settings.saves()).toEqual([])
    expect(languages(view)).toEqual(DEFAULT_SETTINGS.wikiLanguages)
  })
})
