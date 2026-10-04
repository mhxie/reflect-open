import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import {
  clearDisplacedNotes,
  DISPLACED_RECORD_TTL_MS,
  isRecentlyDisplaced,
  NOTE_DISPLACED_EVENT,
  recordDisplacedNotes,
  setDisplacedNotesGeneration,
  subscribeNoteDisplaced,
  type NoteDisplacement,
} from './note-displaced.ts'

beforeEach(() => {
  setDisplacedNotesGeneration(7)
})

afterEach(() => {
  setBridge(null)
  clearDisplacedNotes()
})

describe('subscribeNoteDisplaced', () => {
  it('delivers well-formed payloads and drops malformed ones loudly', async () => {
    const listener: { emit: ((payload: unknown) => void) | null } = { emit: null }
    const events: string[] = []
    setBridge({
      invoke: async () => null,
      listen: async (event, handler) => {
        events.push(event)
        listener.emit = handler
        return () => {}
      },
    })
    const received: NoteDisplacement[] = []
    await subscribeNoteDisplaced((displacement) => {
      received.push(displacement)
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    listener.emit?.({
      generation: 7,
      from: 'daily/2026-10-04.md',
      to: 'daily/2026-10-04 (this device).md',
      keptOut: true,
    })
    listener.emit?.({ from: 'daily/2026-10-04.md' })
    for (const generation of [undefined, -1, 1.5, '7']) {
      listener.emit?.({
        generation,
        from: 'daily/2026-10-04.md',
        to: 'daily/2026-10-04 (this device).md',
        keptOut: true,
      })
    }

    expect(events).toEqual([NOTE_DISPLACED_EVENT])
    expect(received).toEqual([
      {
        generation: 7,
        from: 'daily/2026-10-04.md',
        to: 'daily/2026-10-04 (this device).md',
        keptOut: true,
      },
    ])
    expect(error).toHaveBeenCalledTimes(5)
    error.mockRestore()
  })
})

describe('recorded displacements', () => {
  it('remembers a pair for a while, and only that pair', () => {
    recordDisplacedNotes([{ from: 'notes/a.md', to: 'notes/a (this device).md' }], 7, 1_000)

    expect(isRecentlyDisplaced('notes/a.md', 'notes/a (this device).md', 1_000)).toBe(true)
    expect(isRecentlyDisplaced('notes/a (this device).md', 'notes/a.md', 1_000)).toBe(false)
    expect(isRecentlyDisplaced('notes/a.md', 'notes/b.md', 1_000)).toBe(false)
    expect(
      isRecentlyDisplaced(
        'notes/a.md',
        'notes/a (this device).md',
        1_000 + DISPLACED_RECORD_TTL_MS,
      ),
    ).toBe(false)
  })

  it('clears pairs on graph switches and rejects late records from the previous session', () => {
    const pair = { from: 'notes/a.md', to: 'notes/a (this device).md' }
    recordDisplacedNotes([pair], 7, 1_000)
    expect(isRecentlyDisplaced(pair.from, pair.to, 1_000)).toBe(true)

    setDisplacedNotesGeneration(8)
    recordDisplacedNotes([pair], 7, 1_000)
    expect(isRecentlyDisplaced(pair.from, pair.to, 1_000)).toBe(false)

    recordDisplacedNotes([pair], 8, 1_000)
    expect(isRecentlyDisplaced(pair.from, pair.to, 1_000)).toBe(true)
    setDisplacedNotesGeneration(8)
    expect(isRecentlyDisplaced(pair.from, pair.to, 1_000)).toBe(true)
  })
})
