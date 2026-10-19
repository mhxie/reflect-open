import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import { foldGraphPath } from '../graph/paths.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createNodeTestDatabaseService, seedNotes, type TestNote } from '../testing/database.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createIndexQueryService } from './index-query-service.ts'
import { createMoveHealing } from './move-healing.ts'
import { createNoteDisplacementService } from './note-displacement-service.ts'

const databases: { close(): void }[] = []

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

const ORPHAN = 'notes/01arz3ndektsv4rrffq69g5fav.md'
const ARRIVAL = 'notes/meeting-notes.md'
const ID = '01abcdefghjkmnpqrstvwxyz00'
const CONTENT = `---\nid: ${ID}\n---\n# Meeting Notes\n`

interface SetupOptions {
  /**
   * Runs before each note read and may reject it.
   */
  read?: () => void
  /**
   * Runs before the id lookup.
   */
  lookup?: () => void
  /**
   * Answers each existence probe instead of the files.
   */
  exists?: (path: string) => Promise<boolean>
  /**
   * The files on disk by spelling; ARRIVAL holding CONTENT by default.
   */
  files?: Record<string, string>
  /**
   * The indexed notes; ORPHAN holding CONTENT by default.
   */
  rows?: readonly TestNote[]
  /**
   * The volume folds case and Unicode normalization (APFS): a probe or read
   * of any spelling that folds onto a file on disk finds it.
   */
  folding?: boolean
}

/**
 * Move healing over `options.rows` indexed and `options.files` on disk, with
 * the pull displacements of the open file session 7.
 */
function setup(options: SetupOptions = {}) {
  const database = createNodeTestDatabaseService()
  databases.push(database)
  seedNotes(database, options.rows ?? [{ path: ORPHAN, markdown: CONTENT }])
  const onDisk = options.files ?? { [ARRIVAL]: CONTENT }
  const files = createTestNoteFileService({ files: onDisk })
  const spellingOnDisk = (path: string): string => {
    return options.folding === true
      ? (Object.keys(onDisk).find((file) => foldGraphPath(file) === foldGraphPath(path)) ?? path)
      : path
  }
  const indexQuery = createIndexQueryService({ database })
  const calls: string[] = []
  const readFile = files.read.bind(files)
  vi.spyOn(files, 'read').mockImplementation(async (path, generation) => {
    calls.push('read')
    options.read?.()
    return await readFile(spellingOnDisk(path), generation)
  })
  const fileExists = files.exists.bind(files)
  vi.spyOn(files, 'exists').mockImplementation(async (path) => {
    calls.push('exists')
    return await (options.exists?.(path) ?? fileExists(spellingOnDisk(path)))
  })
  const getNoteIdsByPath = indexQuery.getNoteIdsByPath.bind(indexQuery)
  vi.spyOn(indexQuery, 'getNoteIdsByPath').mockImplementation(async (paths) => {
    calls.push('lookup')
    options.lookup?.()
    return await getNoteIdsByPath(paths)
  })
  const graphSession = createTestGraphSessionService({ graph: { generation: 7 } })
  const noteDisplacement = createNoteDisplacementService({
    ipc: createTestIpcBridgeService(),
    clock: createTestClockService(),
    logger: createTestLoggerService(),
    graphSession,
  })
  const healing = createMoveHealing({ noteFile: files, indexQuery, noteDisplacement })
  return { healing, calls, graphSession, noteDisplacement }
}

describe('MoveHealing.detectExternalMoves', () => {
  it('pairs an orphan with the arrival carrying its id and hands back the content', async () => {
    const { healing } = setup()

    const scan = await healing.detectExternalMoves([ORPHAN], [ARRIVAL], 1)
    expect(scan.moves).toEqual([{ from: ORPHAN, to: ARRIVAL }])
    expect(scan.content.get(ARRIVAL)).toBe(CONTENT)
  })

  it('skips an unreadable arrival: no pair, no content, no throw', async () => {
    const { healing } = setup({
      read: () => {
        throw new AppError('io', 'locked')
      },
    })

    const scan = await healing.detectExternalMoves([ORPHAN], [ARRIVAL], 1)
    expect(scan.moves).toEqual([])
    expect(scan.content.size).toBe(0)
  })

  it('never reads or queries when either side is empty', async () => {
    const { healing, calls } = setup()

    expect((await healing.detectExternalMoves([], [ARRIVAL], 1)).moves).toEqual([])
    expect((await healing.detectExternalMoves([ORPHAN], [], 1)).moves).toEqual([])
    expect(calls).toEqual([])
  })

  it('returns no moves once aborted — the caller is bailing anyway', async () => {
    const controller = new AbortController()
    const { healing } = setup({ lookup: () => controller.abort() })

    const scan = await healing.detectExternalMoves([ORPHAN], [ARRIVAL], 1, {
      signal: controller.signal,
    })
    expect(scan.moves).toEqual([])
  })

  it('never pairs an orphan whose path holds a file again', async () => {
    // A pull moved this device's note aside and wrote the other device's
    // note at the old path: the row's path is not vacant, so no move.
    const { healing, calls } = setup({ files: { [ORPHAN]: CONTENT, [ARRIVAL]: CONTENT } })

    const scan = await healing.detectExternalMoves([ORPHAN], [ARRIVAL], 1)
    expect(scan.moves).toEqual([])
    expect(calls).not.toContain('lookup')
  })

  it('treats a failed existence probe as present: no guess, plain delete+create', async () => {
    const { healing } = setup({
      exists: () => Promise.reject(new AppError('io', 'probe failed')),
    })

    expect((await healing.detectExternalMoves([ORPHAN], [ARRIVAL], 1)).moves).toEqual([])
  })

  it('never pairs a pair a pull recorded as moved aside', async () => {
    const recorded = setup()
    recorded.noteDisplacement.record([{ from: ORPHAN, to: ARRIVAL }], 7)
    expect((await recorded.healing.detectExternalMoves([ORPHAN], [ARRIVAL], 1)).moves).toEqual([])

    // Another arrival for the same orphan still pairs: only the pair is out.
    const elsewhere = setup()
    elsewhere.noteDisplacement.record([{ from: ORPHAN, to: 'notes/elsewhere.md' }], 7)
    expect((await elsewhere.healing.detectExternalMoves([ORPHAN], [ARRIVAL], 1)).moves).toEqual([
      { from: ORPHAN, to: ARRIVAL },
    ])

    // A late record from the previous file session suppresses nothing.
    elsewhere.graphSession.setGraph({ generation: 8 })
    elsewhere.noteDisplacement.record([{ from: ORPHAN, to: ARRIVAL }], 7)
    expect((await elsewhere.healing.detectExternalMoves([ORPHAN], [ARRIVAL], 1)).moves).toEqual([
      { from: ORPHAN, to: ARRIVAL },
    ])
  })

  it('pairs a rename of the case alone on a volume that folds case', async () => {
    // A pull of the other device's `Plan.md` → `plan.md`: the old spelling's
    // probe finds the new file, which must not read as "still there".
    const from = 'notes/Plan.md'
    const to = 'notes/plan.md'
    const { healing } = setup({
      folding: true,
      files: { [to]: CONTENT },
      rows: [{ path: from, markdown: CONTENT }],
    })

    expect((await healing.detectExternalMoves([from], [to], 1)).moves).toEqual([{ from, to }])
  })

  it('pairs a rename of the Unicode normalization alone', async () => {
    const from = 'notes/cafe\u{301}.md'
    const to = 'notes/caf\u{E9}.md'
    const { healing } = setup({
      folding: true,
      files: { [to]: CONTENT },
      rows: [{ path: from, markdown: CONTENT }],
    })

    expect((await healing.detectExternalMoves([from], [to], 1)).moves).toEqual([{ from, to }])
  })

  it('never pairs a case-only displacement a pull recorded', async () => {
    // This device's `notes/Plan.md` moved aside to its copy, and the other
    // device's own note took `notes/plan.md`.
    const from = 'notes/Plan.md'
    const copy = 'notes/Plan (this device).md'
    const theirs = '---\nid: 01abcdefghjkmnpqrstvwxyz99\n---\n# Plan\n'
    const { healing, noteDisplacement } = setup({
      folding: true,
      files: { 'notes/plan.md': theirs, [copy]: CONTENT },
      rows: [{ path: from, markdown: CONTENT }],
    })
    noteDisplacement.record([{ from, to: copy }], 7)

    expect((await healing.detectExternalMoves([from], ['notes/plan.md', copy], 1)).moves).toEqual(
      [],
    )
  })

  it('still probes an orphan that is also among the arrivals', async () => {
    const { healing } = setup({
      folding: true,
      files: { [ORPHAN]: CONTENT },
      rows: [{ path: ORPHAN, markdown: CONTENT }],
    })

    expect((await healing.detectExternalMoves([ORPHAN], [ORPHAN], 1)).moves).toEqual([])
  })
})
