import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { Settings } from '@reflect/core'
import { WikiSection } from './wiki-section.tsx'

/**
 * The settings patch the section renders, as a tiny store so an update
 * re-renders it, plus `loaded`: what the saved settings say before they show
 * (the provider applies `updateSettingsWith` updaters to those).
 */
const settingsStore = vi.hoisted(() => {
  let patch: Record<string, unknown> = {}
  let loaded: Record<string, unknown> = {}
  const listeners = new Set<() => void>()
  return {
    get: (): Record<string, unknown> => patch,
    loaded: (): Record<string, unknown> => loaded,
    setLoaded: (next: Record<string, unknown>): void => {
      loaded = next
    },
    set: (next: Record<string, unknown>): void => {
      patch = { ...patch, ...next }
      for (const listener of listeners) {
        listener()
      }
    },
    reset: (): void => {
      patch = {}
      loaded = {}
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
})

vi.mock('@/providers/settings-provider.tsx', async () => {
  const { useSyncExternalStore } = await import('react')
  const { DEFAULT_SETTINGS } = await import('@reflect/core')
  return {
    useSettings: () => {
      useSyncExternalStore(settingsStore.subscribe, settingsStore.get)
      return {
        settings: { ...DEFAULT_SETTINGS, ...settingsStore.get() },
        updateSettings: (patch: Partial<Settings>) => settingsStore.set(patch),
        updateSettingsWith: (updater: (current: Settings) => Partial<Settings>) =>
          settingsStore.set(
            updater({ ...DEFAULT_SETTINGS, ...settingsStore.loaded(), ...settingsStore.get() }),
          ),
      }
    },
  }
})

beforeEach(() => {
  settingsStore.reset()
})

async function addLanguage(label: string, folder: string): Promise<void> {
  const page = (await import('vitest/browser')).page
  await page.getByRole('textbox', { name: 'Language name' }).fill(label)
  await page.getByRole('textbox', { name: 'Language folder' }).fill(folder)
  await page.getByRole('button', { name: 'Add language' }).click()
}

describe('WikiSection', () => {
  it('lists the default languages with the source marked and only translations removable', async () => {
    const view = await render(<WikiSection />)

    await expect.element(view.getByText('English')).toBeInTheDocument()
    await expect.element(view.getByText('Source')).toBeInTheDocument()
    await expect.element(view.getByText('wiki-cn/')).toBeInTheDocument()
    expect(view.getByRole('button', { name: 'Remove English' }).query()).toBeNull()

    await view.getByRole('button', { name: 'Remove 简体中文' }).click()

    expect(settingsStore.get()['wikiLanguages']).toEqual([{ label: 'English', folder: 'wiki' }])
  })

  it('adds a language with a normalized folder', async () => {
    const view = await render(<WikiSection />)

    await addLanguage(' 日本語 ', '/wiki-ja/')

    expect(settingsStore.get()['wikiLanguages']).toEqual([
      { label: 'English', folder: 'wiki' },
      { label: '简体中文', folder: 'wiki-cn' },
      { label: '日本語', folder: 'wiki-ja' },
    ])
    await expect.element(view.getByRole('textbox', { name: 'Language folder' })).toHaveValue('')
  })

  it('never removes the saved source language, whatever was on screen', async () => {
    // Saved: Chinese is the source; on screen (still loading): the defaults.
    settingsStore.setLoaded({ wikiLanguages: [{ label: '简体中文', folder: 'wiki-cn' }] })
    const view = await render(<WikiSection />)

    await view.getByRole('button', { name: 'Remove 简体中文' }).click()

    expect(settingsStore.get()['wikiLanguages']).toEqual([{ label: '简体中文', folder: 'wiki-cn' }])
  })

  it('applies an edit to the saved languages even before they show', async () => {
    settingsStore.setLoaded({
      wikiLanguages: [
        { label: 'English', folder: 'wiki' },
        { label: '日本語', folder: 'wiki-ja' },
      ],
    })
    await render(<WikiSection />)

    await addLanguage('Deutsch', 'wiki-de')

    expect(settingsStore.get()['wikiLanguages']).toEqual([
      { label: 'English', folder: 'wiki' },
      { label: '日本語', folder: 'wiki-ja' },
      { label: 'Deutsch', folder: 'wiki-de' },
    ])
  })

  it('explains a missing name, an invalid folder, and a folder already in use', async () => {
    const view = await render(<WikiSection />)

    await addLanguage('', 'wiki-ja')
    await expect.element(view.getByText(/Give the language a name/)).toBeInTheDocument()

    await addLanguage('日本語', '../outside')
    await expect.element(view.getByText(/can't be a folder/)).toBeInTheDocument()

    await addLanguage('Chinese', 'wiki-cn')
    await expect.element(view.getByText(/is already a wiki folder/)).toBeInTheDocument()
    expect(settingsStore.get()['wikiLanguages']).toBeUndefined()
  })
})
