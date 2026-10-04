import { afterEach, describe, expect, it, vi } from 'vitest'
import { subscribeOwnWrites } from '../indexing/local-write-echo.ts'
import {
  clearDisplacedNotes,
  isRecentlyDisplaced,
  recordDisplacedNotes,
} from '../indexing/note-displaced.ts'
import { setBridge } from '../ipc/bridge.ts'
import { isEditableLocalOnlyPath, isLocalOnlyPath } from './local-only.ts'
import {
  cancelReflectV1Import,
  clearNoteRecovery,
  createGraph,
  createNoteIfAbsent,
  deleteNote,
  importReflectV1Zip,
  markReflectV1ImportOwnWrites,
  openAsset,
  openGraph,
  readNoteRecovery,
  subscribeImportProgress,
  windowBootstrap,
  writeNoteRecovery,
  IMPORT_PROGRESS_EVENT,
} from './commands.ts'
import { graphInfoSchema } from './schemas.ts'

interface GraphInfoFixture {
  generation: number
  localOnlyFolders: string[]
  localOnlyEditableFolders?: string[]
}

/** A bridge answering the graph-open commands with `info` per command. */
function graphBridge(infos: Record<string, GraphInfoFixture>) {
  setBridge({
    invoke: async (command) => {
      const info = infos[command]
      if (info === undefined) {
        throw new Error(`unexpected command ${command}`)
      }
      const graph = { root: '/g', name: 'g', ...info }
      return command === 'window_bootstrap'
        ? { graph, indexGeneration: null, initialDeepLink: null }
        : graph
    },
    listen: async () => () => {},
  })
}

describe('local-only folders follow the open graph', () => {
  // Module state persists across these tests, so generations only grow.
  it('records the names from graph_open and clears them on a reopen with none', async () => {
    graphBridge({ graph_open: { generation: 10, localOnlyFolders: ['secure'] } })
    await openGraph('/g')
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(true)

    graphBridge({ graph_open: { generation: 11, localOnlyFolders: [] } })
    await openGraph('/g')
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(false)
  })

  it('records the names from graph_create and window_bootstrap', async () => {
    graphBridge({ graph_create: { generation: 12, localOnlyFolders: ['raw'] } })
    await createGraph('/g')
    expect(isLocalOnlyPath('papers/raw/scan.png')).toBe(true)
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(false)

    graphBridge({ window_bootstrap: { generation: 12, localOnlyFolders: ['secure'] } })
    await windowBootstrap()
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(true)
  })

  it('never lets a late response for an older session replace the names', async () => {
    graphBridge({ graph_open: { generation: 20, localOnlyFolders: ['secure'] } })
    await openGraph('/g')
    graphBridge({ graph_open: { generation: 19, localOnlyFolders: [] } })
    await openGraph('/g')
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(true)

    // Control: the next session's response does replace them.
    graphBridge({ graph_open: { generation: 21, localOnlyFolders: [] } })
    await openGraph('/g')
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(false)
  })

  it('records the editable names with the folders', async () => {
    graphBridge({
      graph_open: {
        generation: 30,
        localOnlyFolders: ['secure', 'archive'],
        localOnlyEditableFolders: ['secure'],
      },
    })
    await openGraph('/g')
    expect(isEditableLocalOnlyPath('finance/secure/bank.md')).toBe(true)
    expect(isEditableLocalOnlyPath('archive/2019/q1.md')).toBe(false)

    // A build that predates the key sends none: every folder is read-only.
    graphBridge({ graph_open: { generation: 31, localOnlyFolders: ['secure'] } })
    await openGraph('/g')
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(true)
    expect(isEditableLocalOnlyPath('finance/secure/bank.md')).toBe(false)
  })

  it('never lets a late response for an older session replace the editable names', async () => {
    graphBridge({
      graph_open: { generation: 40, localOnlyFolders: ['secure'], localOnlyEditableFolders: [] },
    })
    await openGraph('/g')
    graphBridge({
      window_bootstrap: {
        generation: 39,
        localOnlyFolders: ['secure'],
        localOnlyEditableFolders: ['secure'],
      },
    })
    await windowBootstrap()
    expect(isEditableLocalOnlyPath('finance/secure/bank.md')).toBe(false)
  })
})

describe('graphInfoSchema', () => {
  it('reads a missing editable list as none', () => {
    const info = graphInfoSchema.parse({
      root: '/g',
      name: 'g',
      generation: 1,
      localOnlyFolders: ['secure'],
    })
    expect(info.localOnlyEditableFolders).toEqual([])
  })
})

afterEach(() => {
  setBridge(null)
  clearDisplacedNotes()
})

describe('displacement records follow the file graph session', () => {
  const pair = { from: 'notes/a.md', to: 'notes/a (this device).md' }

  it('changes scope on open, create, and secondary-window bootstrap', async () => {
    graphBridge({ graph_open: { generation: 50, localOnlyFolders: [] } })
    await openGraph('/g')
    recordDisplacedNotes([pair], 50)
    expect(isRecentlyDisplaced(pair.from, pair.to)).toBe(true)

    graphBridge({ graph_create: { generation: 51, localOnlyFolders: [] } })
    await createGraph('/g')
    recordDisplacedNotes([pair], 50)
    expect(isRecentlyDisplaced(pair.from, pair.to)).toBe(false)
    recordDisplacedNotes([pair], 51)
    expect(isRecentlyDisplaced(pair.from, pair.to)).toBe(true)

    graphBridge({ window_bootstrap: { generation: 52, localOnlyFolders: [] } })
    await windowBootstrap()
    recordDisplacedNotes([pair], 51)
    expect(isRecentlyDisplaced(pair.from, pair.to)).toBe(false)
    recordDisplacedNotes([pair], 52)
    expect(isRecentlyDisplaced(pair.from, pair.to)).toBe(true)
  })

  it('cannot reactivate an older session when its open response arrives late', async () => {
    graphBridge({ graph_open: { generation: 54, localOnlyFolders: [] } })
    await openGraph('/g')
    recordDisplacedNotes([pair], 54)
    graphBridge({ graph_open: { generation: 53, localOnlyFolders: [] } })
    await openGraph('/g')

    expect(isRecentlyDisplaced(pair.from, pair.to)).toBe(true)
    clearDisplacedNotes()
    recordDisplacedNotes([pair], 53)
    expect(isRecentlyDisplaced(pair.from, pair.to)).toBe(false)
    recordDisplacedNotes([pair], 54)
    expect(isRecentlyDisplaced(pair.from, pair.to)).toBe(true)
  })
})

describe('graph commands', () => {
  it('reports which trash took a deleted note', async () => {
    const invoke = vi.fn(async () => ({ trashed: 'graph' }))
    setBridge({ invoke, listen: async () => () => {} })

    await expect(deleteNote('finance/secure/bank.md', 7)).resolves.toEqual({ trashed: 'graph' })
    expect(invoke).toHaveBeenCalledWith('note_delete', {
      path: 'finance/secure/bank.md',
      generation: 7,
    })
  })

  it('keeps and drops only an owned version of local-only unsaved text by generation', async () => {
    const kept = {
      ownerId: 'a'.repeat(32),
      token: 'b'.repeat(32),
      sourceRevision: '# Bank\n',
      savedAtMs: 1_700_000_000_000,
      contents: '# Bank\n\nunsaved\n',
    }
    const invoke = vi.fn(async (command: string) =>
      command === 'note_recovery_clear' ? null : kept,
    )
    setBridge({ invoke, listen: async () => () => {} })

    await expect(
      writeNoteRecovery(
        'finance/secure/bank.md',
        kept.contents,
        kept.ownerId,
        kept.sourceRevision,
        3,
      ),
    ).resolves.toEqual(kept)
    await expect(readNoteRecovery('finance/secure/bank.md', 3)).resolves.toEqual(kept)
    await clearNoteRecovery('finance/secure/bank.md', kept.ownerId, kept.token, 3)

    expect(invoke.mock.calls).toEqual([
      [
        'note_recovery_write',
        {
          path: 'finance/secure/bank.md',
          contents: kept.contents,
          ownerId: kept.ownerId,
          sourceRevision: kept.sourceRevision,
          generation: 3,
        },
      ],
      ['note_recovery_read', { path: 'finance/secure/bank.md', generation: 3 }],
      [
        'note_recovery_clear',
        {
          path: 'finance/secure/bank.md',
          ownerId: kept.ownerId,
          token: kept.token,
          generation: 3,
        },
      ],
    ])
  })

  it('reads no kept text as null', async () => {
    setBridge({ invoke: async () => null, listen: async () => () => {} })
    await expect(readNoteRecovery('finance/secure/bank.md', 3)).resolves.toBeNull()
  })

  it('rejects recovery receipts without a valid ownership token', async () => {
    setBridge({
      invoke: async () => ({
        ownerId: 'a'.repeat(32),
        token: '../other',
        sourceRevision: null,
        savedAtMs: 5,
        contents: 'unsaved',
      }),
      listen: async () => () => {},
    })
    await expect(readNoteRecovery('finance/secure/bank.md', 3)).rejects.toThrow()
  })

  it('creates a note through the generation-pinned no-clobber boundary', async () => {
    const invoke = vi.fn(async () => ({ kind: 'created', modifiedMs: 1_234 }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })

    try {
      await expect(
        createNoteIfAbsent('notes/business-ideas.md', '# Business ideas\n', 7),
      ).resolves.toEqual({ kind: 'created', modifiedMs: 1_234 })
      expect(invoke).toHaveBeenCalledWith('note_create', {
        path: 'notes/business-ideas.md',
        contents: '# Business ideas\n',
        generation: 7,
      })
      expect(ownWrites).toEqual(['notes/business-ideas.md'])
    } finally {
      unlisten()
    }
  })

  it('propagates a note-create rejection without echoing a local write', async () => {
    // The failure side of the generation pin: a stale-generation bridge
    // rejection reaches the caller, and nothing pretends a file was written.
    const invoke = vi.fn(async () => {
      throw { kind: 'io', message: 'the graph changed since this command was issued; dropping it' }
    })
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })

    try {
      await expect(
        createNoteIfAbsent('notes/business-ideas.md', '# Business ideas\n', 6),
      ).rejects.toMatchObject({ kind: 'io' })
      expect(ownWrites).toEqual([])
    } finally {
      unlisten()
    }
  })

  it('returns a note-create collision without echoing a local write', async () => {
    const invoke = vi.fn(async () => ({ kind: 'collision' }))
    setBridge({ invoke, listen: async () => () => {} })
    const ownWrites: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      ownWrites.push(path)
    })

    try {
      await expect(
        createNoteIfAbsent('notes/business-ideas.md', '# Replacement\n', 7),
      ).resolves.toEqual({ kind: 'collision' })
      expect(ownWrites).toEqual([])
    } finally {
      unlisten()
    }
  })

  it('opens assets through the generation-pinned native command', async () => {
    const invoke = vi.fn(async () => null)
    setBridge({ invoke, listen: async () => () => {} })

    await openAsset('assets/cat.png', 7)

    expect(invoke).toHaveBeenCalledWith('asset_open', {
      path: 'assets/cat.png',
      generation: 7,
    })
  })

  it('imports Reflect V1 zips through the generation-pinned native command', async () => {
    const invoke = vi.fn(async () => ({
      importedFiles: 2,
      skippedFiles: 0,
      downloadedAssets: 0,
      failedAssetDownloads: 0,
      renamedFiles: 0,
      mergedFiles: 0,
      changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
    }))
    setBridge({ invoke, listen: async () => () => {} })
    const summary = await importReflectV1Zip('/tmp/reflect-v1.zip', 7)

    expect(invoke).toHaveBeenCalledWith('graph_import_reflect_v1_zip', {
      path: '/tmp/reflect-v1.zip',
      generation: 7,
    })
    expect(summary).toEqual({
      importedFiles: 2,
      skippedFiles: 0,
      downloadedAssets: 0,
      failedAssetDownloads: 0,
      renamedFiles: 0,
      mergedFiles: 0,
      changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
    })
  })

  it('surfaces validated import progress ticks and drops malformed ones', async () => {
    let emit: ((payload: unknown) => void) | null = null
    setBridge({
      invoke: async () => null,
      listen: async (event, handler) => {
        expect(event).toBe(IMPORT_PROGRESS_EVENT)
        emit = handler
        return () => {}
      },
    })
    const seen: unknown[] = []
    await subscribeImportProgress((progress) => {
      seen.push(progress)
    })
    if (emit === null) {
      throw new Error('expected the subscription to register a listener')
    }
    const publish: (payload: unknown) => void = emit

    publish({ stage: 'downloading', done: 1, total: 4 })
    publish({ stage: 'launching', done: 1, total: 4 })

    expect(seen).toEqual([{ stage: 'downloading', done: 1, total: 4 }])
  })

  it('cancels the running import through the native command', async () => {
    const invoke = vi.fn(async () => null)
    setBridge({ invoke, listen: async () => () => {} })

    await cancelReflectV1Import()

    expect(invoke).toHaveBeenCalledWith('graph_import_cancel', {})
  })

  it('marks completed import files as this device’s own writes', () => {
    const seen: string[] = []
    const unlisten = subscribeOwnWrites((path) => {
      seen.push(path)
    })
    try {
      markReflectV1ImportOwnWrites({
        importedFiles: 2,
        skippedFiles: 0,
        downloadedAssets: 0,
        failedAssetDownloads: 0,
        renamedFiles: 0,
        mergedFiles: 0,
        changedPaths: ['notes/a.md', 'daily/2026-07-04.md'],
      })

      expect(seen).toEqual(['notes/a.md', 'daily/2026-07-04.md'])
    } finally {
      unlisten()
    }
  })
})
