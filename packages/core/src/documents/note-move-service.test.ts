import { describe, expect, it, vi } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createTestNoteSession } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteFileService, type TestNoteFileService } from '../testing/graph.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestIdService } from '../testing/id.ts'
import { createTestIndexStoreService } from '../testing/index-store.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createNoteMoveService, NOTE_MOVED_EVENT } from './note-move-service.ts'
import { createNoteSessionService } from './note-session-service.ts'
import { createOpenDocumentsService } from './open-documents-service.ts'
import type { NoteSession } from './note-session-types.ts'

/**
 * The move service's carry/compensate contract (Plan 17): the session and
 * registry follow the file, a failure undoes exactly what was done — and
 * never touches a *different* pane's document that happens to sit at the
 * destination (the Bugbot-reported foreign-re-key case).
 */

function setup(options?: {
  sessions?: readonly NoteSession[]
  moveError?: Error
  noteFile?: TestNoteFileService
}) {
  const ipc = createTestIpcBridgeService()
  const noteFile = options?.noteFile ?? createTestNoteFileService()
  const indexStore = createTestIndexStoreService({
    fail: (call) => (call.method === 'moveIndexed' ? options?.moveError : undefined),
  })
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  for (const session of options?.sessions ?? []) {
    openDocuments.register({ session })
  }
  const logger = createTestLoggerService()
  const noteMove = createNoteMoveService({ ipc, noteFile, indexStore, openDocuments, logger })
  const moves: Array<[string, string]> = []
  noteMove.onMoved((from, to) => {
    moves.push([from, to])
  })
  return { ipc, noteFile, indexStore, openDocuments, logger, noteMove, moves }
}

describe('moveNote', () => {
  it('flushes, retargets, re-keys, moves, and announces', async () => {
    const session = createTestNoteSession({ path: 'notes/a.md' })
    const { noteMove, openDocuments, indexStore, moves } = setup({ sessions: [session] })

    await noteMove.moveNote('notes/a.md', 'notes/b.md', 7)

    expect(session.getCalls('flush')).toHaveLength(1)
    expect(session.path).toBe('notes/b.md')
    expect(openDocuments.sessionFor('notes/b.md')).toBe(session)
    expect(indexStore.calls()).toEqual([
      { method: 'moveIndexed', from: 'notes/a.md', to: 'notes/b.md', fileGeneration: 7 },
    ])
    expect(moves).toEqual([['notes/a.md', 'notes/b.md']])
  })

  it('a failed move with a carried session retargets and re-keys back', async () => {
    const session = createTestNoteSession({ path: 'notes/a.md' })
    const { noteMove, openDocuments, moves } = setup({
      sessions: [session],
      moveError: new Error('disk full'),
    })

    await expect(noteMove.moveNote('notes/a.md', 'notes/b.md', 7)).rejects.toThrow('disk full')

    expect(session.path).toBe('notes/a.md')
    expect(openDocuments.sessionFor('notes/a.md')).toBe(session)
    expect(openDocuments.sessionFor('notes/b.md')).toBeNull()
    expect(moves).toEqual([])
  })

  it("a failed move with no carried session never re-keys a foreign pane's document", async () => {
    // Another pane legitimately holds a note at the destination path.
    const foreign = createTestNoteSession({ path: 'notes/b.md' })
    const { noteMove, openDocuments } = setup({
      sessions: [foreign],
      moveError: new Error('refused'),
    })

    await expect(noteMove.moveNote('notes/a.md', 'notes/b.md', 7)).rejects.toThrow('refused')

    // The foreign document stays exactly where it was — quit-time flush and
    // sessionFor lookups keep targeting the right path.
    expect(openDocuments.sessionFor('notes/b.md')).toBe(foreign)
    expect(openDocuments.sessionFor('notes/a.md')).toBeNull()
    expect(foreign.path).toBe('notes/b.md')
  })
})

describe('followHealedMove', () => {
  it('carries a live session to the healed path and announces', () => {
    const session = createTestNoteSession({ path: 'notes/a.md' })
    const { noteMove, openDocuments, indexStore, moves } = setup({ sessions: [session] })

    noteMove.followHealedMove('notes/a.md', 'notes/renamed.md')

    // The open pane follows the externally renamed file: its next save
    // writes the new path instead of resurrecting the dead one.
    expect(session.path).toBe('notes/renamed.md')
    expect(session.getCalls('flush')).toHaveLength(0)
    expect(openDocuments.sessionFor('notes/renamed.md')).toBe(session)
    expect(openDocuments.sessionFor('notes/a.md')).toBeNull()
    expect(indexStore.calls()).toEqual([])
    expect(moves).toEqual([['notes/a.md', 'notes/renamed.md']])
  })

  it('a heal of a closed note just announces (routes still follow)', () => {
    const { noteMove, moves } = setup()

    noteMove.followHealedMove('notes/a.md', 'notes/renamed.md')

    expect(moves).toEqual([['notes/a.md', 'notes/renamed.md']])
  })
})

describe('onMoved', () => {
  it('stops delivering after the unsubscribe', () => {
    const { noteMove } = setup()
    const heard: Array<[string, string]> = []
    const unsubscribe = noteMove.onMoved((from, to) => {
      heard.push([from, to])
    })

    noteMove.followHealedMove('notes/a.md', 'notes/b.md')
    unsubscribe()
    noteMove.followHealedMove('notes/b.md', 'notes/c.md')

    expect(heard).toEqual([['notes/a.md', 'notes/b.md']])
  })

  it('isolates a throwing listener: later listeners still hear the move', () => {
    const { noteMove, logger } = setup()
    const failure = new Error('listener broke')
    const heard: Array<[string, string]> = []
    noteMove.onMoved(() => {
      throw failure
    })
    noteMove.onMoved((from, to) => {
      heard.push([from, to])
    })

    noteMove.followHealedMove('notes/a.md', 'notes/b.md')

    expect(heard).toEqual([['notes/a.md', 'notes/b.md']])
    expect(logger.getErrors()).toEqual([{ message: 'note-moved listener failed:', cause: failure }])
  })
})

describe('followNativeMoves', () => {
  it('follows each `note:moved` broadcast until unlistened', async () => {
    const session = createTestNoteSession({ path: 'notes/a.md' })
    const { noteMove, ipc, openDocuments, moves } = setup({ sessions: [session] })

    const unlisten = noteMove.followNativeMoves()
    await Promise.resolve()
    ipc.emit(NOTE_MOVED_EVENT, { from: 'notes/a.md', to: 'notes/b.md' })

    expect(session.path).toBe('notes/b.md')
    expect(openDocuments.sessionFor('notes/b.md')).toBe(session)
    expect(moves).toEqual([['notes/a.md', 'notes/b.md']])

    unlisten()
    ipc.emit(NOTE_MOVED_EVENT, { from: 'notes/b.md', to: 'notes/c.md' })
    expect(moves).toEqual([['notes/a.md', 'notes/b.md']])
  })

  it('logs a payload that is not a move and follows nothing', () => {
    const { noteMove, ipc, logger, moves } = setup()

    noteMove.followNativeMoves()
    ipc.emit(NOTE_MOVED_EVENT, { from: 'notes/a.md' })

    expect(moves).toEqual([])
    expect(logger.getErrors().map((entry) => entry.message)).toEqual([
      'invalid note:moved payload:',
    ])
  })
})

describe('followDisplacedNote', () => {
  const FROM = 'daily/2026-10-04.md'
  const TO = 'daily/2026-10-04 (this device).md'
  const GENERATION = 7

  /**
   * An open session at `FROM` in file generation `generation` whose
   * displacement decision is `follows`: it moves to the copy when true.
   */
  function displacedSession(follows: boolean, generation = GENERATION) {
    return createTestNoteSession({ path: FROM, generation, followsDisplacement: follows })
  }

  it('ignores a same-path owner from another graph generation', async () => {
    const session = displacedSession(true, GENERATION + 1)
    const { noteMove, noteFile, openDocuments } = setup({ sessions: [session] })

    await noteMove.followDisplacedNote(FROM, TO, true, GENERATION, () => true)

    expect(noteFile.getReads()).toEqual([])
    expect(session.getCalls('followDisplacement')).toEqual([])
    expect(openDocuments.sessionFor(FROM)).toBe(session)
    expect(openDocuments.sessionFor(TO)).toBeNull()
  })

  it('carries a session that follows its moved bytes, and announces the move', async () => {
    const session = displacedSession(true)
    const { noteMove, noteFile, openDocuments, moves } = setup({
      sessions: [session],
      noteFile: createTestNoteFileService({ files: { [FROM]: '# From the phone\n' } }),
    })

    await noteMove.followDisplacedNote(FROM, TO, true, GENERATION, () => true)

    expect(noteFile.getReads()).toEqual([{ path: FROM, generation: GENERATION }])
    expect(session.getCalls('followDisplacement')).toEqual([[TO, '# From the phone\n', true]])
    expect(session.path).toBe(TO)
    expect(openDocuments.sessionFor(TO)).toBe(session)
    expect(openDocuments.sessionFor(FROM)).toBeNull()
    expect(moves).toEqual([[FROM, TO]])
  })

  it('leaves a session that stays with the incoming note where it is, unannounced', async () => {
    const session = displacedSession(false)
    const { noteMove, openDocuments, moves } = setup({
      sessions: [session],
      noteFile: createTestNoteFileService({ files: { [FROM]: '# From the phone\n' } }),
    })

    await noteMove.followDisplacedNote(FROM, TO, false, GENERATION, () => true)

    expect(session.getCalls('followDisplacement')).toEqual([[TO, '# From the phone\n', false]])
    expect(openDocuments.sessionFor(FROM)).toBe(session)
    expect(moves).toEqual([])
  })

  it('hands the session null when the incoming note cannot be read', async () => {
    const session = displacedSession(true)
    const { noteMove } = setup({ sessions: [session] }) // nothing on disk at FROM

    await noteMove.followDisplacedNote(FROM, TO, false, GENERATION, () => true)

    expect(session.getCalls('followDisplacement')).toEqual([[TO, null, false]])
  })

  it('does nothing for a note no pane has open', async () => {
    const { noteMove, noteFile, moves } = setup()

    await noteMove.followDisplacedNote(FROM, TO, true, GENERATION, () => true)

    expect(noteFile.getReads()).toEqual([])
    expect(moves).toEqual([])
  })

  it('does not retarget or save a new graph’s dirty same-path note for an old event', async () => {
    const source = '# Graph B\n'
    const noteFile = createTestNoteFileService({ files: { [FROM]: source } })
    const session = createNoteSessionService({
      noteFile,
      clock: createTestClockService(),
      logger: createTestLoggerService(),
      graphSession: createTestGraphSessionService({ graph: { generation: GENERATION } }),
      id: createTestIdService(),
    }).create({
      path: FROM,
      classify: () => 'exact',
      onSnapshot: () => {},
      applyContent: () => {},
    })
    const { noteMove, openDocuments, moves } = setup({ sessions: [session], noteFile })
    try {
      session.load()
      await vi.waitFor(() => expect(session.content()).toBe(source))
      session.editorChanged('# Graph B unsaved\n')
      expect(session.isDirty()).toBe(true)

      await noteMove.followDisplacedNote(FROM, TO, false, GENERATION, () => false)
      await session.flush()

      // The session's own load is the only read: the stale event read nothing.
      expect(noteFile.getReads()).toEqual([{ path: FROM, generation: GENERATION }])
      expect(session.path).toBe(FROM)
      expect(openDocuments.sessionFor(FROM)).toBe(session)
      expect(openDocuments.sessionFor(TO)).toBeNull()
      expect(moves).toEqual([])
      expect(noteFile.writes().map(({ path, contents }) => ({ path, contents }))).toEqual([
        { path: FROM, contents: '# Graph B unsaved\n' },
      ])
      expect(noteFile.files().has(TO)).toBe(false)
    } finally {
      session.discard()
      session.dispose()
    }
  })

  it('discards a pinned read after the graph changes even when the same owner remains', async () => {
    const noteFile = createTestNoteFileService()
    const read = Promise.withResolvers<string>()
    const reads = vi.spyOn(noteFile, 'read').mockReturnValueOnce(read.promise)
    let generation = GENERATION
    const session = displacedSession(true)
    const { noteMove, openDocuments, moves } = setup({ sessions: [session], noteFile })

    const following = noteMove.followDisplacedNote(
      FROM,
      TO,
      true,
      GENERATION,
      () => generation === GENERATION,
    )
    expect(reads).toHaveBeenCalledWith(FROM, GENERATION)
    generation += 1
    read.resolve('# Old graph incoming\n')
    await following

    expect(session.getCalls('followDisplacement')).toEqual([])
    expect(session.path).toBe(FROM)
    expect(openDocuments.sessionFor(FROM)).toBe(session)
    expect(openDocuments.sessionFor(TO)).toBeNull()
    expect(moves).toEqual([])
  })
})
