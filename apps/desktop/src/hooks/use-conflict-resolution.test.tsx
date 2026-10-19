import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { ReflectError, resolveConflictMarkers } from '@reflect/core'
import {
  createTestCoreServices,
  createTestFileChangeService,
  createTestIndexLifecycleService,
  createTestNoteFileService,
  type TestFileChangeService,
  type TestIndexLifecycleService,
  type TestNoteFileService,
  type TestOpenGraph,
} from '@reflect/core/testing'
import { queryClient, queryKeys } from '@/lib/query-client.ts'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useConflictResolution } from './use-conflict-resolution.ts'

const GRAPH: TestOpenGraph = { root: '/g', name: 'G', generation: 3, indexGeneration: 7 }
const INDEX_QUERIES = { queryKey: queryKeys.index.all }

const PATH = 'notes/clash.md'
const SOURCE = [
  '<<<<<<< this device',
  'mine',
  '=======',
  'theirs',
  '>>>>>>> other device',
  '',
].join('\n')

let noteFile: TestNoteFileService
let fileChanges: TestFileChangeService
let indexLifecycle: TestIndexLifecycleService
let invalidateQueries: MockInstance<typeof queryClient.invalidateQueries>
let indexed: Array<{ path: string; generation: number; content: string | undefined }>

beforeEach(() => {
  // `invalidateIndexQueries` goes through the app's query client.
  invalidateQueries = vi.spyOn(queryClient, 'invalidateQueries')
  noteFile = createTestNoteFileService({ files: { [PATH]: SOURCE } })
  fileChanges = createTestFileChangeService()
  indexed = []
  indexLifecycle = createTestIndexLifecycleService({ noteFile, fileChanges })
  vi.spyOn(indexLifecycle, 'indexNote').mockImplementation(async (path, options) => {
    indexed.push({ path, generation: options.generation, content: options.content })
  })
})

/**
 * Render the hook over app services built on the fakes above.
 */
async function mount(overrides?: { noteFile?: TestNoteFileService; graph?: null }) {
  const app = createTestCoreServices({
    noteFile: overrides?.noteFile ?? noteFile,
    fileChanges,
    indexLifecycle,
  })
  return await renderHookInApp(() => useConflictResolution(PATH), {
    app,
    graph: overrides?.graph === null ? null : GRAPH,
  })
}

describe('useConflictResolution', () => {
  it('writes the spliced side, reindexes, and notifies open views', async () => {
    const { result, act } = await mount()

    await act(async () => {
      await result.current.resolve('ours')
    })

    const resolved = resolveConflictMarkers(SOURCE, 'ours')
    expect(noteFile.writes()).toEqual([{ path: PATH, contents: resolved, generation: 3 }])
    expect(indexed).toEqual([{ path: PATH, generation: 7, content: resolved }])
    expect(fileChanges.batches()).toEqual([
      { changes: [{ path: PATH, kind: 'upsert' }], source: 'own-write' },
    ])
    expect(invalidateQueries).toHaveBeenCalledWith(INDEX_QUERIES)
    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  it('a failed write surfaces the error and notifies nothing', async () => {
    vi.spyOn(noteFile, 'write').mockRejectedValue(new ReflectError('io', 'disk full'))
    const { result, act } = await mount()

    await act(async () => {
      await result.current.resolve('theirs')
    })

    expect(result.current.error).toBe('disk full')
    expect(result.current.busy).toBe(false)
    expect(fileChanges.batches()).toEqual([])
    expect(invalidateQueries).not.toHaveBeenCalledWith(INDEX_QUERIES)
  })

  it('a failed reindex still notifies — the file on disk did change', async () => {
    indexLifecycle.indexNote = async () => {
      throw new ReflectError('io', 'index closed')
    }
    const { result, act } = await mount()

    await act(async () => {
      await result.current.resolve('both')
    })

    expect(result.current.error).toBe('index closed')
    expect(fileChanges.batches()).toHaveLength(1)
    expect(invalidateQueries).toHaveBeenCalledWith(INDEX_QUERIES)
  })

  it('does nothing without an open graph', async () => {
    const { result, act } = await mount({ graph: null })

    await act(async () => {
      await result.current.resolve('ours')
    })

    expect(noteFile.writes()).toEqual([])
    expect(fileChanges.batches()).toEqual([])
    expect(invalidateQueries).not.toHaveBeenCalledWith(INDEX_QUERIES)
  })
})
