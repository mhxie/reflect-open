import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { foldGraphPath } from '../graph/paths.ts'
import { setBridge } from '../ipc/bridge.ts'
import { detectExternalMoves } from './move-healing.ts'
import {
  clearDisplacedNotes,
  recordDisplacedNotes,
  setDisplacedNotesGeneration,
} from './note-displaced.ts'

beforeEach(() => {
  setDisplacedNotesGeneration(7)
})

afterEach(() => {
  setBridge(null)
  clearDisplacedNotes()
})

const ORPHAN = 'notes/01arz3ndektsv4rrffq69g5fav.md'
const ARRIVAL = 'notes/meeting-notes.md'
const ID = '01abcdefghjkmnpqrstvwxyz00'
const CONTENT = `---\nid: ${ID}\n---\n# Meeting Notes\n`

function fakeBridge(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
  setBridge({
    invoke,
    listen: async () => () => {},
  })
}

/**
 * A bridge over a volume that folds case and Unicode normalization (APFS):
 * `files` holds each file on disk by its spelling, and a probe or read of
 * any spelling that folds onto one of them finds it. `rows` is the index.
 */
function foldingVolume(
  files: Record<string, string>,
  rows: ReadonlyArray<{ path: string; id: string }>,
) {
  const onDisk = new Map(
    Object.entries(files).map(([path, source]) => [foldGraphPath(path), source]),
  )
  const fileAt = (args: Record<string, unknown>) =>
    typeof args.path === 'string' ? onDisk.get(foldGraphPath(args.path)) : undefined
  fakeBridge(async (command, args) => {
    if (command === 'note_exists') {
      return fileAt(args) !== undefined
    }
    if (command === 'note_read') {
      const source = fileAt(args)
      if (source === undefined) {
        throw { kind: 'io', message: 'not found' }
      }
      return source
    }
    if (command === 'db_query') {
      return rows
    }
    return null
  })
}

describe('detectExternalMoves', () => {
  it('pairs an orphan with the arrival carrying its id and hands back the content', async () => {
    fakeBridge(async (command) => {
      if (command === 'note_exists') {
        return false
      }
      if (command === 'note_read') {
        return CONTENT
      }
      if (command === 'db_query') {
        return [{ path: ORPHAN, id: ID }]
      }
      return null
    })

    const scan = await detectExternalMoves([ORPHAN], [ARRIVAL])
    expect(scan.moves).toEqual([{ from: ORPHAN, to: ARRIVAL }])
    expect(scan.content.get(ARRIVAL)).toBe(CONTENT)
  })

  it('skips an unreadable arrival: no pair, no content, no throw', async () => {
    fakeBridge(async (command) => {
      if (command === 'note_exists') {
        return false
      }
      if (command === 'note_read') {
        throw { kind: 'io', message: 'locked' }
      }
      if (command === 'db_query') {
        return [{ path: ORPHAN, id: ID }]
      }
      return null
    })

    const scan = await detectExternalMoves([ORPHAN], [ARRIVAL])
    expect(scan.moves).toEqual([])
    expect(scan.content.size).toBe(0)
  })

  it('never touches the bridge when either side is empty', async () => {
    const calls: string[] = []
    fakeBridge(async (command) => {
      calls.push(command)
      return null
    })

    expect((await detectExternalMoves([], [ARRIVAL])).moves).toEqual([])
    expect((await detectExternalMoves([ORPHAN], [])).moves).toEqual([])
    expect(calls).toEqual([])
  })

  it('returns no moves once aborted — the caller is bailing anyway', async () => {
    const controller = new AbortController()
    fakeBridge(async (command) => {
      if (command === 'note_exists') {
        return false
      }
      if (command === 'db_query') {
        controller.abort()
        return [{ path: ORPHAN, id: ID }]
      }
      return CONTENT
    })

    const scan = await detectExternalMoves([ORPHAN], [ARRIVAL], { signal: controller.signal })
    expect(scan.moves).toEqual([])
  })

  it('never pairs an orphan whose path holds a file again', async () => {
    // A pull moved this device's note aside and wrote the other device's
    // note at the old path: the row's path is not vacant, so no move.
    const calls: string[] = []
    fakeBridge(async (command) => {
      calls.push(command)
      if (command === 'note_exists') {
        return true
      }
      if (command === 'note_read') {
        return CONTENT
      }
      if (command === 'db_query') {
        return [{ path: ORPHAN, id: ID }]
      }
      return null
    })

    const scan = await detectExternalMoves([ORPHAN], [ARRIVAL])
    expect(scan.moves).toEqual([])
    expect(calls).not.toContain('db_query')
  })

  it('treats a failed existence probe as present: no guess, plain delete+create', async () => {
    fakeBridge(async (command) => {
      if (command === 'note_exists') {
        throw { kind: 'io', message: 'probe failed' }
      }
      if (command === 'note_read') {
        return CONTENT
      }
      if (command === 'db_query') {
        return [{ path: ORPHAN, id: ID }]
      }
      return null
    })

    expect((await detectExternalMoves([ORPHAN], [ARRIVAL])).moves).toEqual([])
  })

  it('never pairs a pair a pull recorded as moved aside', async () => {
    fakeBridge(async (command) => {
      if (command === 'note_exists') {
        return false
      }
      if (command === 'note_read') {
        return CONTENT
      }
      if (command === 'db_query') {
        return [{ path: ORPHAN, id: ID }]
      }
      return null
    })
    recordDisplacedNotes([{ from: ORPHAN, to: ARRIVAL }], 7)

    expect((await detectExternalMoves([ORPHAN], [ARRIVAL])).moves).toEqual([])
    // Another arrival for the same orphan still pairs: only the pair is out.
    clearDisplacedNotes()
    recordDisplacedNotes([{ from: ORPHAN, to: 'notes/elsewhere.md' }], 7)
    expect((await detectExternalMoves([ORPHAN], [ARRIVAL])).moves).toEqual([
      { from: ORPHAN, to: ARRIVAL },
    ])

    setDisplacedNotesGeneration(8)
    recordDisplacedNotes([{ from: ORPHAN, to: ARRIVAL }], 7)
    expect((await detectExternalMoves([ORPHAN], [ARRIVAL])).moves).toEqual([
      { from: ORPHAN, to: ARRIVAL },
    ])
  })

  it('pairs a rename of the case alone on a volume that folds case', async () => {
    // A pull of the other device's `Plan.md` → `plan.md`: the old spelling's
    // probe finds the new file, which must not read as "still there".
    const from = 'notes/Plan.md'
    const to = 'notes/plan.md'
    foldingVolume({ [to]: CONTENT }, [{ path: from, id: ID }])

    expect((await detectExternalMoves([from], [to])).moves).toEqual([{ from, to }])
  })

  it('pairs a rename of the Unicode normalization alone', async () => {
    const from = 'notes/café.md'
    const to = 'notes/café.md'
    foldingVolume({ [to]: CONTENT }, [{ path: from, id: ID }])

    expect((await detectExternalMoves([from], [to])).moves).toEqual([{ from, to }])
  })

  it('never pairs a case-only displacement a pull recorded', async () => {
    // This device's `notes/Plan.md` moved aside to its copy, and the other
    // device's own note took `notes/plan.md`.
    const from = 'notes/Plan.md'
    const copy = 'notes/Plan (this device).md'
    const theirs = '---\nid: 01abcdefghjkmnpqrstvwxyz99\n---\n# Plan\n'
    foldingVolume({ 'notes/plan.md': theirs, [copy]: CONTENT }, [{ path: from, id: ID }])
    recordDisplacedNotes([{ from, to: copy }], 7)

    expect((await detectExternalMoves([from], ['notes/plan.md', copy])).moves).toEqual([])
  })

  it('still probes an orphan that is also among the arrivals', async () => {
    foldingVolume({ [ORPHAN]: CONTENT }, [{ path: ORPHAN, id: ID }])

    expect((await detectExternalMoves([ORPHAN], [ORPHAN])).moves).toEqual([])
  })
})
