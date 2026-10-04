import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import type { ReactNode } from 'react'
import {
  clearDisplacedNotes,
  isRecentlyDisplaced,
  setBridge,
  setDisplacedNotesGeneration,
  setLocalWriteEcho,
} from '@reflect/core'
import { setPlatformSurface } from '@/lib/platform-surface.ts'
import { MobileRoot } from '@/mobile/mobile-root.tsx'
import { NoteDisplacements } from './note-displacements.tsx'

const state = vi.hoisted(() => ({ generation: 7, status: 'ready', indexGeneration: 70 }))
const followDisplacedNote = vi.hoisted(() =>
  vi.fn<typeof import('@/editor/move-note.ts').followDisplacedNote>(async () => {}),
)
vi.mock('@/providers/graph-provider.tsx', () => ({
  GraphProvider: ({ children }: { children: ReactNode }) => children,
  useGraph: () => ({
    graph: { root: '/graph', generation: state.generation },
    status: state.status,
    indexGeneration: state.indexGeneration,
  }),
}))
vi.mock('@/editor/move-note.ts', () => ({ followDisplacedNote }))
vi.mock('@/mobile/mobile-app.tsx', () => ({ MobileApp: () => null }))

const FROM = 'notes/plan.md'
const TO = 'notes/plan (this device).md'

function fakeBridge(gateListen = false) {
  const handlers: Array<(payload: unknown) => void> = []
  const unlisten = vi.fn()
  let release: (() => void) | undefined
  setBridge({
    invoke: async () => null,
    listen: async (event, handler) => {
      expect(event).toBe('note:displaced')
      handlers.push(handler)
      if (gateListen) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return unlisten
    },
  })
  return {
    emit: (index: number, generation: number) => {
      handlers[index]?.({ generation, from: FROM, to: TO, keptOut: false })
    },
    release: () => release?.(),
    unlisten,
  }
}

beforeEach(() => {
  state.generation = 7
  state.status = 'ready'
  followDisplacedNote.mockClear()
  setDisplacedNotesGeneration(state.generation)
})

afterEach(() => {
  setBridge(null)
  clearDisplacedNotes()
  setLocalWriteEcho(false)
  setPlatformSurface({ touchEditor: false, mobileApp: false })
})

describe('NoteDisplacements', () => {
  it('subscribes on the mobile surface within its graph provider', async () => {
    const bridge = fakeBridge()
    await render(<MobileRoot platform="ios" />)

    bridge.emit(0, state.generation)
    expect(followDisplacedNote).toHaveBeenCalledWith(FROM, TO, false, 7, expect.any(Function))
    expect(isRecentlyDisplaced(FROM, TO)).toBe(true)
  })

  it('uses the file generation rather than the independent index generation', async () => {
    const bridge = fakeBridge()
    await render(<NoteDisplacements />)

    bridge.emit(0, state.indexGeneration)
    expect(followDisplacedNote).not.toHaveBeenCalled()
    expect(isRecentlyDisplaced(FROM, TO)).toBe(false)

    bridge.emit(0, state.generation)
    expect(isRecentlyDisplaced(FROM, TO)).toBe(true)
    expect(followDisplacedNote).toHaveBeenCalledWith(FROM, TO, false, 7, expect.any(Function))
  })

  it('rejects old events after a graph switch, including delivery to the disposed listener', async () => {
    const bridge = fakeBridge()
    const view = await render(<NoteDisplacements />)
    bridge.emit(0, 7)
    const oldGuard = followDisplacedNote.mock.calls[0]?.[4]
    followDisplacedNote.mockClear()

    state.generation = 8
    setDisplacedNotesGeneration(state.generation)
    await view.rerender(<NoteDisplacements />)
    bridge.emit(0, 7)
    bridge.emit(1, 7)

    expect(oldGuard?.()).toBe(false)
    expect(followDisplacedNote).not.toHaveBeenCalled()
    expect(isRecentlyDisplaced(FROM, TO)).toBe(false)
    bridge.emit(1, 8)
    expect(followDisplacedNote).toHaveBeenCalledWith(FROM, TO, false, 8, expect.any(Function))
    expect(isRecentlyDisplaced(FROM, TO)).toBe(true)
  })

  it('ignores delivery after unmount and disposes a late-resolving subscription', async () => {
    const bridge = fakeBridge(true)
    const view = await render(<NoteDisplacements />)
    await view.unmount()
    bridge.emit(0, 7)
    bridge.release()

    await vi.waitFor(() => expect(bridge.unlisten).toHaveBeenCalledOnce())
    expect(followDisplacedNote).not.toHaveBeenCalled()
    expect(isRecentlyDisplaced(FROM, TO)).toBe(false)
  })
})
