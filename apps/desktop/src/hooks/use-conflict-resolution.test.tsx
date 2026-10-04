import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import {
  emitFileChanges,
  indexNote,
  readNote,
  resolveConflictMarkers,
  writeNote,
  type GraphInfo,
} from '@reflect/core'
import { invalidateIndexQueries } from '@/lib/query-client.ts'
import { useConflictResolution } from './use-conflict-resolution.ts'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  readNote: vi.fn(),
  writeNote: vi.fn(async () => {}),
  indexNote: vi.fn(async () => {}),
  emitFileChanges: vi.fn(),
}))
vi.mock('@/lib/query-client.ts', () => ({ invalidateIndexQueries: vi.fn() }))

const graphState = vi.hoisted(() => ({
  graph: { root: '/g', name: 'G', generation: 3 } as GraphInfo | null,
  indexGeneration: 7 as number | null,
}))
vi.mock('@/providers/graph-provider.tsx', () => ({ useGraph: () => graphState }))

const SOURCE = [
  '<<<<<<< this device',
  'mine',
  '=======',
  'theirs',
  '>>>>>>> other device',
  '',
].join('\n')

/** A later pull's conflict over the same note, with sides the user never saw. */
const NEWER = [
  '<<<<<<< this device',
  'mine',
  '=======',
  'theirs, edited again',
  '>>>>>>> other device',
  '',
].join('\n')

const CHANGED_ON_DISK = { kind: 'io', message: 'Note changed on disk; reload before retrying' }

/**
 * Point the note commands at a one-file disk that keeps Rust's write rule: a
 * write lands only while the file still holds the contents it names.
 */
function diskHolding(contents: string): { contents: string } {
  const disk = { contents }
  vi.mocked(readNote).mockImplementation(async () => disk.contents)
  vi.mocked(writeNote).mockImplementation(async (_path, next, _generation, expected) => {
    if (expected !== disk.contents) {
      throw CHANGED_ON_DISK
    }
    disk.contents = next
  })
  return disk
}

beforeEach(() => {
  graphState.graph = {
    root: '/g',
    name: 'G',
    generation: 3,
    localOnlyFolders: [],
    localOnlyEditableFolders: [],
  }
  graphState.indexGeneration = 7
  vi.mocked(readNote).mockResolvedValue(SOURCE)
  vi.mocked(writeNote).mockImplementation(async () => {})
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('useConflictResolution', () => {
  it('splices the text the user was shown and checks the write against it', async () => {
    const disk = diskHolding(SOURCE)
    const { result, act } = await renderHook(() => useConflictResolution('notes/clash.md', SOURCE))

    await act(async () => {
      await result.current.resolve('ours')
    })

    const resolved = resolveConflictMarkers(SOURCE, 'ours')
    expect(vi.mocked(readNote)).not.toHaveBeenCalled()
    expect(vi.mocked(writeNote)).toHaveBeenCalledWith('notes/clash.md', resolved, 3, SOURCE)
    expect(disk.contents).toBe(resolved)
    expect(vi.mocked(indexNote)).toHaveBeenCalledWith('notes/clash.md', {
      generation: 7,
      content: resolved,
    })
    expect(vi.mocked(emitFileChanges)).toHaveBeenCalledWith([
      { path: 'notes/clash.md', kind: 'upsert' },
    ])
    expect(vi.mocked(invalidateIndexQueries)).toHaveBeenCalled()
    expect(result.current.error).toBeNull()
    expect(result.current.busy).toBe(false)
  })

  it('a version that landed after the view rendered is refused, never resolved unseen', async () => {
    const disk = diskHolding(NEWER)
    const { result, act } = await renderHook(() => useConflictResolution('notes/clash.md', SOURCE))

    await act(async () => {
      await result.current.resolve('ours')
    })

    expect(vi.mocked(writeNote)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeNote)).toHaveBeenCalledWith(
      'notes/clash.md',
      resolveConflictMarkers(SOURCE, 'ours'),
      3,
      SOURCE,
    )
    expect(disk.contents).toBe(NEWER)
    expect(result.current.error).toBe(CHANGED_ON_DISK.message)
    expect(vi.mocked(indexNote)).not.toHaveBeenCalled()
    expect(vi.mocked(emitFileChanges)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidateIndexQueries)).not.toHaveBeenCalled()
  })

  it('without a conflict view, splices a fresh read and checks the write against it', async () => {
    const disk = diskHolding(SOURCE)
    const { result, act } = await renderHook(() => useConflictResolution('notes/clash.md'))

    await act(async () => {
      await result.current.resolve('theirs')
    })

    const resolved = resolveConflictMarkers(SOURCE, 'theirs')
    expect(vi.mocked(readNote)).toHaveBeenCalledWith('notes/clash.md')
    expect(vi.mocked(writeNote)).toHaveBeenCalledWith('notes/clash.md', resolved, 3, SOURCE)
    expect(disk.contents).toBe(resolved)
    expect(result.current.error).toBeNull()
  })

  it('a failed write surfaces the error and notifies nothing', async () => {
    vi.mocked(writeNote).mockRejectedValueOnce({ kind: 'io', message: 'disk full' })
    const { result, act } = await renderHook(() => useConflictResolution('notes/clash.md', SOURCE))

    await act(async () => {
      await result.current.resolve('theirs')
    })

    expect(result.current.error).toBe('disk full')
    expect(vi.mocked(emitFileChanges)).not.toHaveBeenCalled()
    expect(vi.mocked(invalidateIndexQueries)).not.toHaveBeenCalled()
  })

  it('a failed reindex still notifies — the file on disk did change', async () => {
    vi.mocked(indexNote).mockRejectedValueOnce({ kind: 'io', message: 'index closed' })
    const { result, act } = await renderHook(() => useConflictResolution('notes/clash.md', SOURCE))

    await act(async () => {
      await result.current.resolve('both')
    })

    expect(result.current.error).toBe('index closed')
    expect(vi.mocked(emitFileChanges)).toHaveBeenCalled()
    expect(vi.mocked(invalidateIndexQueries)).toHaveBeenCalled()
  })

  it('does nothing without an open graph', async () => {
    graphState.graph = null
    const { result, act } = await renderHook(() => useConflictResolution('notes/clash.md'))

    await act(async () => {
      await result.current.resolve('ours')
    })

    expect(vi.mocked(readNote)).not.toHaveBeenCalled()
    expect(vi.mocked(writeNote)).not.toHaveBeenCalled()
  })
})
