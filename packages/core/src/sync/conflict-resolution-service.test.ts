import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReflectError } from '../errors.ts'
import { resolveConflictMarkers } from '../markdown/conflict-markers.ts'
import { createTestFileChangeService, type TestFileChangeService } from '../testing/file-change.ts'
import {
  createTestGraphSessionService,
  type TestGraphSessionService,
} from '../testing/graph-session.ts'
import {
  createTestNoteFileService,
  overrideNoteFileService,
  type TestNoteFileService,
} from '../testing/graph.ts'
import { createTestIndexLifecycleService } from '../testing/index-lifecycle.ts'
import {
  createConflictResolutionService,
  type ConflictResolutionService,
} from './conflict-resolution-service.ts'

const PATH = 'notes/clash.md'
const SOURCE = [
  '<<<<<<< this device',
  'mine',
  '=======',
  'theirs',
  '>>>>>>> other device',
  '',
].join('\n')
const GRAPH = { generation: 3, indexGeneration: 7 }

let noteFile: TestNoteFileService
let fileChanges: TestFileChangeService
let graphSession: TestGraphSessionService
let indexed: Array<{ path: string; generation: number; content: string | undefined }>
let failIndex: boolean
let service: ConflictResolutionService

beforeEach(() => {
  noteFile = createTestNoteFileService({ files: { [PATH]: SOURCE } })
  fileChanges = createTestFileChangeService()
  graphSession = createTestGraphSessionService({ graph: GRAPH })
  indexed = []
  failIndex = false
  const indexLifecycle = createTestIndexLifecycleService()
  vi.spyOn(indexLifecycle, 'indexNote').mockImplementation(async (path, options) => {
    if (failIndex) {
      throw new ReflectError('io', 'index closed')
    }
    indexed.push({ path, generation: options.generation, content: options.content })
  })
  service = createConflictResolutionService({
    noteFile,
    indexLifecycle,
    fileChanges,
    graphSession,
  })
})

describe('createConflictResolutionService', () => {
  it('reads the conflict markers of the file on disk', async () => {
    await expect(service.conflictMarkers(PATH)).resolves.toEqual({
      labels: { ours: 'this device', theirs: 'other device' },
      blocks: 1,
    })
  })

  it('rejects reading markers with no graph open', async () => {
    graphSession.setGraph(null)
    await expect(service.conflictMarkers(PATH)).rejects.toMatchObject({ kind: 'noGraph' })
  })

  it('writes the spliced side, reindexes, and notifies open sessions', async () => {
    const outcome = await service.resolve(PATH, 'ours')

    const resolved = resolveConflictMarkers(SOURCE, 'ours')
    expect(outcome).toEqual({ wrote: true, error: null })
    expect(noteFile.writes()).toEqual([{ path: PATH, contents: resolved, generation: 3 }])
    expect(indexed).toEqual([{ path: PATH, generation: 7, content: resolved }])
    expect(fileChanges.batches()).toEqual([
      { changes: [{ path: PATH, kind: 'upsert' }], source: 'own-write' },
    ])
  })

  it('a failed write reports the error and notifies nothing', async () => {
    const indexLifecycle = createTestIndexLifecycleService()
    vi.spyOn(indexLifecycle, 'indexNote').mockResolvedValue(undefined)
    const outcome = await createConflictResolutionService({
      noteFile: overrideNoteFileService(noteFile, {
        write: async () => {
          throw new ReflectError('io', 'disk full')
        },
      }),
      indexLifecycle,
      fileChanges,
      graphSession,
    }).resolve(PATH, 'theirs')

    expect(outcome).toEqual({ wrote: false, error: 'disk full' })
    expect(fileChanges.batches()).toEqual([])
  })

  it('refuses to resolve a version that landed after the read', async () => {
    const indexLifecycle = createTestIndexLifecycleService()
    vi.spyOn(indexLifecycle, 'indexNote').mockResolvedValue(undefined)
    const outcome = await createConflictResolutionService({
      noteFile: overrideNoteFileService(noteFile, {
        read: async (path, generation) => {
          const shown = await noteFile.read(path, generation)
          noteFile.set(PATH, `${SOURCE}a pull landed meanwhile\n`)
          return shown
        },
      }),
      indexLifecycle,
      fileChanges,
      graphSession,
    }).resolve(PATH, 'ours')

    expect(outcome.wrote).toBe(false)
    expect(outcome.error).not.toBeNull()
    expect(noteFile.files().get(PATH)).toBe(`${SOURCE}a pull landed meanwhile\n`)
    expect(fileChanges.batches()).toEqual([])
  })

  it('a missing note reports the error and writes nothing', async () => {
    const outcome = await service.resolve('notes/missing.md', 'ours')

    expect(outcome.wrote).toBe(false)
    expect(outcome.error).not.toBeNull()
    expect(noteFile.writes()).toEqual([])
    expect(fileChanges.batches()).toEqual([])
  })

  it('a failed reindex still notifies — the file on disk did change', async () => {
    failIndex = true

    const outcome = await service.resolve(PATH, 'both')

    expect(outcome).toEqual({ wrote: true, error: 'index closed' })
    expect(noteFile.getWrites(PATH)).toEqual([resolveConflictMarkers(SOURCE, 'both')])
    expect(fileChanges.batches()).toHaveLength(1)
  })

  it('skips the reindex without an open index session', async () => {
    graphSession.setGraph({ generation: 3, indexGeneration: null })

    const outcome = await service.resolve(PATH, 'ours')

    expect(outcome).toEqual({ wrote: true, error: null })
    expect(indexed).toEqual([])
    expect(fileChanges.batches()).toHaveLength(1)
  })

  it('does nothing when no graph is open', async () => {
    graphSession.setGraph(null)

    const outcome = await service.resolve(PATH, 'ours')

    expect(outcome).toEqual({ wrote: false, error: null })
    expect(noteFile.writes()).toEqual([])
    expect(fileChanges.batches()).toEqual([])
  })
})
