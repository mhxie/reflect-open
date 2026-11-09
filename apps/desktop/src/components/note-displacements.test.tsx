import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { createTestCoreServices, createTestPlatformService } from '@reflect/core/testing'
import { MobileRoot } from '@/mobile/mobile-root.tsx'
import { act } from '@/test-utils/act.ts'
import { MOBILE_PLATFORM, renderInApp } from '@/test-utils/render-in-app.tsx'
import { createWasmTestDatabaseService } from '@/test-utils/test-database.ts'
import { NoteDisplacements } from './note-displacements.tsx'

// The mobile shell's screens: the wiring test only needs the root around them.
vi.mock('@/mobile/mobile-app.tsx', () => ({ MobileApp: () => null }))

const FROM = 'notes/plan.md'
const TO = 'notes/plan (this device).md'

/** The graph the tests open: file and index generations are independent counters. */
const GRAPH = { root: '/graph', name: 'graph', generation: 7, indexGeneration: 70 }

/**
 * Core services whose `note:displaced` subscriptions are kept by the test, as
 * Rust would deliver to them: `deliver(index, generation)` calls the
 * `index`-th subscription's handler, a disposed one included. With
 * `gateListen`, a subscription resolves only on `release()`.
 */
function setup(options?: { gateListen?: boolean; mobile?: boolean }) {
  const app = createTestCoreServices({
    database: createWasmTestDatabaseService(),
    ...(options?.mobile === true ? { platform: createTestPlatformService(MOBILE_PLATFORM) } : {}),
  })
  onTestFinished(() => app.database.close())
  const { ipc } = app
  const handlers: Array<(payload: unknown) => void> = []
  const unlisten = vi.fn()
  const gate = Promise.withResolvers<void>()
  const listen = ipc.listen.bind(ipc)
  vi.spyOn(ipc, 'listen').mockImplementation(async (event, handler) => {
    if (event !== 'note:displaced') {
      return await listen(event, handler)
    }
    handlers.push(handler)
    if (options?.gateListen === true) {
      await gate.promise
    }
    return unlisten
  })
  const follow = vi.spyOn(app.noteMove, 'followDisplacedNote').mockResolvedValue()
  return {
    app,
    follow,
    unlisten,
    subscriptions: () => handlers.length,
    deliver: (index: number, generation: number) => {
      handlers[index]?.({ generation, from: FROM, to: TO, keptOut: false })
    },
    release: () => gate.resolve(),
  }
}

describe('NoteDisplacements', () => {
  it('subscribes on the mobile surface within its graph provider', async () => {
    const { app, follow, deliver, subscriptions } = setup({ mobile: true })
    app.graphSession.setGraph(GRAPH)
    await renderInApp(<MobileRoot platform="ios" />, { core: app, servicesOnly: true })
    await vi.waitFor(() => expect(subscriptions()).toBe(1))

    deliver(0, GRAPH.generation)
    expect(follow).toHaveBeenCalledWith(FROM, TO, false, 7, expect.any(Function))
    expect(app.noteDisplacement.isRecentlyDisplaced(FROM, TO)).toBe(true)
  })

  it('uses the file generation rather than the independent index generation', async () => {
    const { app, follow, deliver, subscriptions } = setup()
    await renderInApp(<NoteDisplacements />, { core: app, graph: GRAPH })
    await vi.waitFor(() => expect(subscriptions()).toBe(1))

    deliver(0, GRAPH.indexGeneration)
    expect(follow).not.toHaveBeenCalled()
    expect(app.noteDisplacement.isRecentlyDisplaced(FROM, TO)).toBe(false)

    deliver(0, GRAPH.generation)
    expect(app.noteDisplacement.isRecentlyDisplaced(FROM, TO)).toBe(true)
    expect(follow).toHaveBeenCalledWith(FROM, TO, false, 7, expect.any(Function))
  })

  it('rejects old events after a graph switch, including delivery to the disposed listener', async () => {
    const { app, follow, deliver, subscriptions } = setup()
    await renderInApp(<NoteDisplacements />, { core: app, graph: GRAPH })
    await vi.waitFor(() => expect(subscriptions()).toBe(1))
    deliver(0, 7)
    const oldGuard = follow.mock.calls[0]?.[4]
    follow.mockClear()

    await act(() => app.graphSession.setGraph({ ...GRAPH, generation: 8, indexGeneration: 80 }))
    await vi.waitFor(() => expect(subscriptions()).toBe(2))
    deliver(0, 7)
    deliver(1, 7)

    expect(oldGuard?.()).toBe(false)
    expect(follow).not.toHaveBeenCalled()
    expect(app.noteDisplacement.isRecentlyDisplaced(FROM, TO)).toBe(false)
    deliver(1, 8)
    expect(follow).toHaveBeenCalledWith(FROM, TO, false, 8, expect.any(Function))
    expect(app.noteDisplacement.isRecentlyDisplaced(FROM, TO)).toBe(true)
  })

  it('ignores delivery after unmount and disposes a late-resolving subscription', async () => {
    const { app, follow, deliver, release, unlisten, subscriptions } = setup({
      gateListen: true,
    })
    const view = await renderInApp(<NoteDisplacements />, { core: app, graph: GRAPH })
    await vi.waitFor(() => expect(subscriptions()).toBe(1))
    await view.unmount()
    deliver(0, 7)
    release()

    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce())
    expect(follow).not.toHaveBeenCalled()
    expect(app.noteDisplacement.isRecentlyDisplaced(FROM, TO)).toBe(false)
  })
})
