import { describe, expect, it } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import {
  createNoteDisplacementService,
  DISPLACED_RECORD_TTL_MS,
  NOTE_DISPLACED_EVENT,
  type NoteDisplacement,
} from './note-displacement-service.ts'

function setup(generation: number | null = 7) {
  const ipc = createTestIpcBridgeService()
  const logger = createTestLoggerService()
  const clock = createTestClockService({ now: 1_000 })
  const graphSession = createTestGraphSessionService({
    graph: generation === null ? null : { generation },
  })
  const displacements = createNoteDisplacementService({ ipc, clock, logger, graphSession })
  return { ipc, logger, clock, graphSession, displacements }
}

/**
 * Let `listenNow` finish registering.
 */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

const pair = { from: 'notes/a.md', to: 'notes/a (this device).md' }

describe('NoteDisplacementService.onDisplaced', () => {
  it('delivers well-formed payloads and drops malformed ones loudly', async () => {
    const { ipc, logger, displacements } = setup()
    const received: NoteDisplacement[] = []
    displacements.onDisplaced((displacement) => {
      received.push(displacement)
    })
    await settle()

    ipc.emit(NOTE_DISPLACED_EVENT, {
      generation: 7,
      from: 'daily/2026-10-04.md',
      to: 'daily/2026-10-04 (this device).md',
      keptOut: true,
    })
    ipc.emit(NOTE_DISPLACED_EVENT, { from: 'daily/2026-10-04.md' })
    for (const generation of [undefined, -1, 1.5, '7']) {
      ipc.emit(NOTE_DISPLACED_EVENT, {
        generation,
        from: 'daily/2026-10-04.md',
        to: 'daily/2026-10-04 (this device).md',
        keptOut: true,
      })
    }

    expect(received).toEqual([
      {
        generation: 7,
        from: 'daily/2026-10-04.md',
        to: 'daily/2026-10-04 (this device).md',
        keptOut: true,
      },
    ])
    expect(logger.getErrors()).toHaveLength(5)
  })

  it('stops delivering once unsubscribed', async () => {
    const { ipc, displacements } = setup()
    const received: NoteDisplacement[] = []
    const unlisten = displacements.onDisplaced((displacement) => {
      received.push(displacement)
    })
    await settle()
    unlisten()

    ipc.emit(NOTE_DISPLACED_EVENT, { generation: 7, ...pair, keptOut: false })

    expect(received).toEqual([])
  })
})

describe('recorded displacements', () => {
  it('remembers a pair for a while, and only that pair', async () => {
    const { clock, displacements } = setup()
    displacements.record([pair], 7)

    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(true)
    expect(displacements.isRecentlyDisplaced(pair.to, pair.from)).toBe(false)
    expect(displacements.isRecentlyDisplaced('notes/a.md', 'notes/b.md')).toBe(false)

    await clock.advance(DISPLACED_RECORD_TTL_MS)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(false)
  })

  it('clears pairs on graph switches and rejects late records from the previous session', () => {
    const { graphSession, displacements } = setup(7)
    displacements.record([pair], 7)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(true)

    graphSession.setGraph({ generation: 8 })
    displacements.record([pair], 7)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(false)

    displacements.record([pair], 8)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(true)
    // Re-adopting the same session keeps its records.
    graphSession.setGraph({ generation: 8 })
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(true)
  })

  it('records nothing while no graph is open', () => {
    const { graphSession, displacements } = setup(null)
    displacements.record([pair], 7)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(false)

    graphSession.setGraph({ generation: 7 })
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(false)
  })
})

describe('displacement records follow the file graph session', () => {
  it('changes scope on every newly opened session', () => {
    const { graphSession, displacements } = setup(50)
    displacements.record([pair], 50)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(true)

    graphSession.setGraph({ generation: 51 })
    displacements.record([pair], 50)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(false)
    displacements.record([pair], 51)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(true)

    graphSession.setGraph({ generation: 52, root: '/graphs/other' })
    displacements.record([pair], 51)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(false)
    displacements.record([pair], 52)
    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(true)
  })

  it('cannot reactivate an older session when its result arrives late', () => {
    const { displacements } = setup(54)
    displacements.record([pair], 54)
    // A pull of the session the open one replaced reports late.
    displacements.record([{ from: 'notes/b.md', to: 'notes/b (this device).md' }], 53)

    expect(displacements.isRecentlyDisplaced(pair.from, pair.to)).toBe(true)
    expect(displacements.isRecentlyDisplaced('notes/b.md', 'notes/b (this device).md')).toBe(false)
  })
})
