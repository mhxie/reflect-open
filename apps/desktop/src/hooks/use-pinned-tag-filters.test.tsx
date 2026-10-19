import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@reflect/core'
import { createTestCoreServices } from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { usePinnedTagFilters } from './use-pinned-tag-filters.ts'

const PINS = { allNotesFilterTags: ['book', 'person'] }

describe('usePinnedTagFilters', () => {
  it('reports an edit that changed the loaded pin list', async () => {
    const { result, app } = await renderHookInApp(() => usePinnedTagFilters(), {
      settings: PINS,
    })

    expect(result.current.pinTag('#Travel')).toBe(true)
    expect(app.settings.get().allNotesFilterTags).toEqual(['book', 'person', 'travel'])
    expect(result.current.moveTag('travel', 'top')).toBe(true)
    expect(app.settings.get().allNotesFilterTags).toEqual(['travel', 'book', 'person'])
  })

  it('reports no change for an edit that leaves the list as it is', async () => {
    const { result, app } = await renderHookInApp(() => usePinnedTagFilters(), {
      settings: PINS,
    })

    expect(result.current.pinTag('book')).toBe(false)
    expect(result.current.unpinTag('missing')).toBe(false)
    expect(result.current.moveTag('book', 'up')).toBe(false)
    expect(result.current.pinTag('not a tag')).toBe(false)
    expect(app.settings.get().allNotesFilterTags).toEqual(['book', 'person'])
  })

  it('reports no change for an edit queued until settings load', async () => {
    const app = createTestCoreServices()
    // Hold the load, so the edit waits for it.
    const load = Promise.withResolvers<void>()
    app.settings.ipc.onCommand('settings_load', async () => {
      await load.promise
      return { ...DEFAULT_SETTINGS, ...PINS }
    })
    const { result } = await renderHookInApp(() => usePinnedTagFilters(), {
      app,
      servicesOnly: true,
    })

    expect(result.current.pinTag('travel')).toBe(false)
    load.resolve()
    await app.settings.whenLoaded()
    // The queued edit replays once the stored list is read.
    expect(app.settings.get().allNotesFilterTags).toEqual(['book', 'person', 'travel'])
  })
})
