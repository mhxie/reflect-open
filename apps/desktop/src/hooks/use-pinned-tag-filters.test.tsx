import { DEFAULT_SETTINGS, type Settings } from '@reflect/core'
import { cleanup, renderHook } from 'vitest-browser-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { usePinnedTagFilters } from './use-pinned-tag-filters.ts'

type SettingsUpdater = (current: Settings) => Partial<Settings>

const settingsState = vi.hoisted(() => ({
  tags: ['book', 'person'],
  queued: [] as SettingsUpdater[],
  loaded: true,
}))
const updateSettingsWith = vi.hoisted(() => vi.fn<(updater: SettingsUpdater) => void>())

vi.mock('@/providers/settings-provider.tsx', () => ({
  useSettings: () => ({
    settings: { allNotesFilterTags: settingsState.tags },
    updateSettingsWith,
  }),
}))

function currentSettings(): Settings {
  return { ...DEFAULT_SETTINGS, allNotesFilterTags: settingsState.tags }
}

beforeEach(() => {
  settingsState.tags = ['book', 'person']
  settingsState.queued = []
  settingsState.loaded = true
  updateSettingsWith.mockReset().mockImplementation((updater) => {
    if (!settingsState.loaded) {
      settingsState.queued.push(updater)
      return
    }
    const patch = updater(currentSettings())
    if (patch.allNotesFilterTags !== undefined) {
      settingsState.tags = patch.allNotesFilterTags
    }
  })
})

afterEach(async () => {
  await cleanup()
})

describe('usePinnedTagFilters', () => {
  it('reports an edit that changed the loaded pin list', async () => {
    const { result } = await renderHook(() => usePinnedTagFilters())

    expect(result.current.pinTag('#Travel')).toBe(true)
    expect(settingsState.tags).toEqual(['book', 'person', 'travel'])
    expect(result.current.moveTag('travel', 'top')).toBe(true)
    expect(settingsState.tags).toEqual(['travel', 'book', 'person'])
  })

  it('reports no change for an edit that leaves the list as it is', async () => {
    const { result } = await renderHook(() => usePinnedTagFilters())

    expect(result.current.pinTag('book')).toBe(false)
    expect(result.current.unpinTag('missing')).toBe(false)
    expect(result.current.moveTag('book', 'up')).toBe(false)
    expect(result.current.pinTag('not a tag')).toBe(false)
    expect(settingsState.tags).toEqual(['book', 'person'])
  })

  it('reports no change for an edit queued until settings load', async () => {
    settingsState.loaded = false
    const { result } = await renderHook(() => usePinnedTagFilters())

    expect(result.current.pinTag('travel')).toBe(false)
    expect(settingsState.queued).toHaveLength(1)
  })
})
