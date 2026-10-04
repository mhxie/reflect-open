import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onNoteMoved } from '@/lib/note-moves.ts'
import { followDisplacedNote, followHealedMove, moveNoteCarryingSession } from './move-note.ts'
import { createNoteSession, type NoteSession } from './note-session.ts'
import { openSession, registerOpenDocument } from './open-documents.ts'

/**
 * The shared move helper's carry/compensate contract (Plan 17): the session
 * and registry follow the file, a failure undoes exactly what was done — and
 * never touches a *different* pane's document that happens to sit at the
 * destination (the Bugbot-reported foreign-re-key case).
 */

const core = vi.hoisted(() => ({ moveNoteIndexed: vi.fn(), readNote: vi.fn() }))
vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  moveNoteIndexed: core.moveNoteIndexed,
  readNote: core.readNote,
}))

/** A session whose displacement decision is `follows` (it moves when true). */
function fakeSession(path: string, follows = false) {
  let current = path
  const flush = vi.fn(async () => {})
  const followDisplacement = vi.fn((to: string) => {
    if (follows) {
      current = to
    }
    return follows
  })
  const session: NoteSession = {
    get path() {
      return current
    },
    retarget: (to: string) => {
      current = to
    },
    followDisplacement,
    load: () => {},
    editorChanged: () => {},
    externalChanged: () => {},
    flush,
    keepMine: () => {},
    isDirty: () => false,
    isUnpersisted: () => false,
    prepareDelete: async () => false,
    cancelDelete: () => {},
    loadTheirs: () => {},
    commitFrontmatter: async () => true,
    content: () => '',
    liveContent: () => '',
    updateFrontmatter: () => true,
    commitBodyAppend: async () => false,
    commitSourceEdit: async () => false,
    dispose: () => {},
    discard: () => {},
  }
  return { session, flush, followDisplacement }
}

beforeEach(() => {
  core.moveNoteIndexed.mockReset()
  core.moveNoteIndexed.mockResolvedValue(undefined)
  core.readNote.mockReset()
  core.readNote.mockResolvedValue('# From the phone\n')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('moveNoteCarryingSession', () => {
  it('flushes, retargets, re-keys, moves, and announces', async () => {
    const { session, flush } = fakeSession('notes/a.md')
    const unregister = registerOpenDocument({ session })
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => {
      moves.push([from, to])
    })
    try {
      await moveNoteCarryingSession('notes/a.md', 'notes/b.md', 7)

      expect(flush).toHaveBeenCalled()
      expect(session.path).toBe('notes/b.md')
      expect(openSession('notes/b.md')).toBe(session)
      expect(core.moveNoteIndexed).toHaveBeenCalledWith('notes/a.md', 'notes/b.md', 7)
      expect(moves).toEqual([['notes/a.md', 'notes/b.md']])
    } finally {
      unsubscribe()
      unregister()
    }
  })

  it('a failed move with a carried session retargets and re-keys back', async () => {
    core.moveNoteIndexed.mockRejectedValue(new Error('disk full'))
    const { session } = fakeSession('notes/a.md')
    const unregister = registerOpenDocument({ session })
    try {
      await expect(moveNoteCarryingSession('notes/a.md', 'notes/b.md', 7)).rejects.toThrow(
        'disk full',
      )
      expect(session.path).toBe('notes/a.md')
      expect(openSession('notes/a.md')).toBe(session)
      expect(openSession('notes/b.md')).toBeNull()
    } finally {
      unregister()
    }
  })

  it("a failed move with no carried session never re-keys a foreign pane's document", async () => {
    core.moveNoteIndexed.mockRejectedValue(new Error('refused'))
    // Another pane legitimately holds a note at the destination path.
    const foreign = fakeSession('notes/b.md')
    const unregister = registerOpenDocument({ session: foreign.session })
    try {
      await expect(moveNoteCarryingSession('notes/a.md', 'notes/b.md', 7)).rejects.toThrow(
        'refused',
      )
      // The foreign document stays exactly where it was — quit-time flush and
      // openSession lookups keep targeting the right path.
      expect(openSession('notes/b.md')).toBe(foreign.session)
      expect(openSession('notes/a.md')).toBeNull()
      expect(foreign.session.path).toBe('notes/b.md')
    } finally {
      unregister()
    }
  })
})

describe('followHealedMove', () => {
  it('carries a live session to the healed path and announces', () => {
    const { session } = fakeSession('notes/a.md')
    const unregister = registerOpenDocument({ session })
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => {
      moves.push([from, to])
    })
    try {
      followHealedMove('notes/a.md', 'notes/renamed.md')

      // The open pane follows the externally renamed file: its next save
      // writes the new path instead of resurrecting the dead one.
      expect(session.path).toBe('notes/renamed.md')
      expect(openSession('notes/renamed.md')).toBe(session)
      expect(openSession('notes/a.md')).toBeNull()
      expect(moves).toEqual([['notes/a.md', 'notes/renamed.md']])
    } finally {
      unsubscribe()
      unregister()
    }
  })

  it('a heal of a closed note just announces (routes still follow)', () => {
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => {
      moves.push([from, to])
    })
    try {
      followHealedMove('notes/a.md', 'notes/renamed.md')
      expect(moves).toEqual([['notes/a.md', 'notes/renamed.md']])
    } finally {
      unsubscribe()
    }
  })
})

describe('followDisplacedNote', () => {
  const FROM = 'daily/2026-10-04.md'
  const TO = 'daily/2026-10-04 (this device).md'
  const GENERATION = 7

  it('carries a session that follows its moved bytes, and announces the move', async () => {
    const { session, followDisplacement } = fakeSession(FROM, true)
    const unregister = registerOpenDocument({ session })
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => {
      moves.push([from, to])
    })
    try {
      await followDisplacedNote(FROM, TO, true, GENERATION, () => true)

      expect(core.readNote).toHaveBeenCalledWith(FROM, GENERATION)
      expect(followDisplacement).toHaveBeenCalledWith(TO, '# From the phone\n', true)
      expect(session.path).toBe(TO)
      expect(openSession(TO)).toBe(session)
      expect(openSession(FROM)).toBeNull()
      expect(moves).toEqual([[FROM, TO]])
    } finally {
      unsubscribe()
      unregister()
    }
  })

  it('leaves a session that stays with the incoming note where it is, unannounced', async () => {
    const { session, followDisplacement } = fakeSession(FROM, false)
    const unregister = registerOpenDocument({ session })
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => {
      moves.push([from, to])
    })
    try {
      await followDisplacedNote(FROM, TO, false, GENERATION, () => true)

      expect(followDisplacement).toHaveBeenCalledWith(TO, '# From the phone\n', false)
      expect(openSession(FROM)).toBe(session)
      expect(moves).toEqual([])
    } finally {
      unsubscribe()
      unregister()
    }
  })

  it('hands the session null when the incoming note cannot be read', async () => {
    core.readNote.mockRejectedValue({ kind: 'notFound', message: 'missing' })
    const { session, followDisplacement } = fakeSession(FROM, true)
    const unregister = registerOpenDocument({ session })
    try {
      await followDisplacedNote(FROM, TO, false, GENERATION, () => true)
      expect(followDisplacement).toHaveBeenCalledWith(TO, null, false)
    } finally {
      unregister()
    }
  })

  it('does nothing for a note no pane has open', async () => {
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => {
      moves.push([from, to])
    })
    try {
      await followDisplacedNote(FROM, TO, true, GENERATION, () => true)
      expect(core.readNote).not.toHaveBeenCalled()
      expect(moves).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it('does not retarget or save a new graph’s dirty same-path note for an old event', async () => {
    const source = '# Graph B\n'
    const files = new Map([[FROM, source]])
    const writes: Array<{ path: string; contents: string }> = []
    const session = createNoteSession({
      path: FROM,
      io: {
        read: async (path) => {
          const contents = files.get(path)
          if (contents === undefined) {
            throw { kind: 'notFound', message: 'missing' }
          }
          return contents
        },
        write: async (path, contents, expected) => {
          expect(expected).toBe(files.get(path) ?? null)
          writes.push({ path, contents })
          files.set(path, contents)
        },
      },
      classify: () => 'exact',
      onSnapshot: () => {},
      applyContent: () => {},
      saveDebounceMs: 60_000,
    })
    const unregister = registerOpenDocument({ session })
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => {
      moves.push([from, to])
    })
    try {
      session.load()
      await vi.waitFor(() => expect(session.content()).toBe(source))
      session.editorChanged('# Graph B unsaved\n')
      expect(session.isDirty()).toBe(true)

      await followDisplacedNote(FROM, TO, false, GENERATION, () => false)
      await session.flush()

      expect(core.readNote).not.toHaveBeenCalled()
      expect(session.path).toBe(FROM)
      expect(openSession(FROM)).toBe(session)
      expect(openSession(TO)).toBeNull()
      expect(moves).toEqual([])
      expect(writes).toEqual([{ path: FROM, contents: '# Graph B unsaved\n' }])
      expect(files.has(TO)).toBe(false)
    } finally {
      session.discard()
      session.dispose()
      unsubscribe()
      unregister()
    }
  })

  it('discards a pinned read after the graph changes even when the same owner remains', async () => {
    let resolveRead: ((contents: string) => void) | undefined
    core.readNote.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveRead = resolve
      }),
    )
    let generation = GENERATION
    const { session, followDisplacement } = fakeSession(FROM, true)
    const unregister = registerOpenDocument({ session })
    const moves: Array<[string, string]> = []
    const unsubscribe = onNoteMoved((from, to) => {
      moves.push([from, to])
    })
    try {
      const following = followDisplacedNote(
        FROM,
        TO,
        true,
        GENERATION,
        () => generation === GENERATION,
      )
      expect(core.readNote).toHaveBeenCalledWith(FROM, GENERATION)
      generation += 1
      resolveRead?.('# Old graph incoming\n')
      await following

      expect(followDisplacement).not.toHaveBeenCalled()
      expect(session.path).toBe(FROM)
      expect(openSession(FROM)).toBe(session)
      expect(openSession(TO)).toBeNull()
      expect(moves).toEqual([])
    } finally {
      unsubscribe()
      unregister()
    }
  })
})
