import { describe, expect, it, vi } from 'vitest'
import { foldGraphPath, type IndexedNote } from '@reflect/core'
import { createDevBridge } from '@/dev/dev-bridge.ts'
import { createDevFileStore } from '@/dev/dev-file-store.ts'
import { createDevIndexDb } from '@/dev/dev-index-db.ts'

/**
 * The dev bridge's `index_reconcile_scan` mirrors the native scan in
 * `src-tauri/src/db/scan.rs`; the mobile boot path calls it on every open,
 * so a drifted stand-in would rot the `?platform=ios` harness loudly.
 */

function projection(path: string, mtime: number, fileHash: string): IndexedNote {
  return {
    path,
    id: null,
    title: path,
    titleKey: path,
    pathKey: foldGraphPath(path),
    kind: 'note',
    dailyDate: null,
    isPrivate: false,
    isPinned: false,
    pinnedOrder: null,
    hasConflict: false,
    hasContent: true,
    bodyChars: 0,
    gistUrl: null,
    gistStale: false,
    fileHash,
    mtime,
    text: 'body',
    assetText: '',
    preview: 'body',
    links: [],
    tags: [],
    aliases: [],
    claims: [],
    emails: [],
    assets: [],
    tasks: [],
  }
}

describe('dev bridge index_reconcile_scan', () => {
  it('classifies candidates and orphans like the native scan', async () => {
    const files = createDevFileStore({ 'notes/settled.md': '# Settled' })
    const index = await createDevIndexDb()
    const bridge = createDevBridge({ files, index })

    // The seeded file's row matches its listed mtime and has settled.
    const settledMtime = files.list()[0]!.modifiedMs
    index.applyNote(projection('notes/settled.md', settledMtime, 'settled-hash'))
    // A row whose file is gone is an orphan.
    index.applyNote(projection('notes/gone.md', 1_000, 'gone-hash'))
    // A file with no row is an arrival candidate (fresh mtime, so it would be
    // a candidate on both grounds).
    files.write('notes/new.md', '# New')

    const scan = (await bridge.invoke('index_reconcile_scan', { generation: 1 })) as {
      total: number
      candidates: Array<{ path: string; storedHash: string | null }>
      orphans: Array<{ path: string; storedHash: string }>
    }

    expect(scan.total).toBe(2)
    expect(scan.candidates.map((candidate) => candidate.path)).toEqual(['notes/new.md'])
    expect(scan.candidates[0]!.storedHash).toBeNull()
    expect(scan.orphans).toEqual([
      { path: 'notes/gone.md', storedMtime: 1_000, storedHash: 'gone-hash' },
    ])
  })
})

describe('dev bridge desktop boot surface', () => {
  it('answers the desktop chooser and workspace queries with honest stand-ins', async () => {
    const files = createDevFileStore({
      'notes/one.md': '# One',
      'notes/two.md': '# Two',
    })
    const bridge = createDevBridge({
      files,
      index: await createDevIndexDb(),
    })

    const recents = (await bridge.invoke('recent_graphs', {})) as Array<Record<string, unknown>>
    expect(recents).toHaveLength(1)
    expect(recents[0]).toMatchObject({ root: '/dev-graph', name: 'Dev Graph' })
    expect(recents[0]!['openedMs']).toEqual(expect.any(Number))

    await expect(bridge.invoke('icloud_status', {})).resolves.toEqual({
      available: false,
      documentsRoot: null,
      existingGraphRoots: [],
    })
    await expect(bridge.invoke('embed_status', {})).resolves.toEqual({
      status: 'failed',
      message: 'embeddings are unavailable in browser dev',
    })
    await expect(bridge.invoke('vault_scan_stats', { generation: 1 })).resolves.toEqual({
      notes: 2,
      attachments: 0,
      skipped: 0,
    })
    await expect(bridge.invoke('list_attachments', { generation: 1 })).resolves.toEqual([])
  })
})

describe('dev bridge background task parity', () => {
  it('reports native background assertions as unavailable and accepts cleanup', async () => {
    const bridge = createDevBridge({
      files: createDevFileStore({}),
      index: await createDevIndexDb(),
    })

    await expect(bridge.invoke('background_task_begin', {})).resolves.toBeNull()
    await expect(
      bridge.invoke('background_task_end', { token: 'already-expired' }),
    ).resolves.toBeNull()
  })
})

describe('dev bridge on-device transport', () => {
  it('says model servers on this Mac need the desktop app instead of reaching them', async () => {
    const bridge = createDevBridge({
      files: createDevFileStore({}),
      index: await createDevIndexDb(),
    })

    for (const command of ['on_device_http_send', 'on_device_http_read', 'on_device_http_cancel']) {
      await expect(
        bridge.invoke(command, { requestId: 'request-1' }),
        command,
      ).rejects.toMatchObject({
        kind: 'unsupported',
        message: expect.stringContaining('needs the desktop app'),
      })
    }
  })
})

describe('dev bridge note_create parity', () => {
  it('claims a free path and returns its persisted modified time', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_234)
    try {
      const files = createDevFileStore({})
      const bridge = createDevBridge({
        files,
        index: await createDevIndexDb(),
      })

      await expect(
        bridge.invoke('note_create', {
          path: 'notes/business-ideas.md',
          contents: '# Business ideas\n',
          generation: 1,
        }),
      ).resolves.toEqual({ kind: 'created', modifiedMs: 1_234 })
      expect(files.read('notes/business-ideas.md')).toBe('# Business ideas\n')
      expect(files.list()[0]?.modifiedMs).toBe(1_234)
    } finally {
      now.mockRestore()
    }
  })

  it('reports a collision without replacing the existing file', async () => {
    const files = createDevFileStore({
      'notes/business-ideas.md': '# Original\n',
    })
    const originalModifiedMs = files.list()[0]!.modifiedMs
    const bridge = createDevBridge({
      files,
      index: await createDevIndexDb(),
    })

    await expect(
      bridge.invoke('note_create', {
        path: 'notes/business-ideas.md',
        contents: '# Replacement\n',
        generation: 1,
      }),
    ).resolves.toEqual({ kind: 'collision' })
    expect(files.read('notes/business-ideas.md')).toBe('# Original\n')
    expect(files.list()[0]!.modifiedMs).toBe(originalModifiedMs)
  })

  it('rejects a stale generation before creating or replacing anything', async () => {
    const files = createDevFileStore({
      'notes/existing.md': '# Existing\n',
    })
    const bridge = createDevBridge({
      files,
      index: await createDevIndexDb(),
    })

    await expect(
      bridge.invoke('note_create', {
        path: 'notes/new.md',
        contents: '# New\n',
        generation: 0,
      }),
    ).rejects.toMatchObject({
      kind: 'io',
      message: 'the graph changed since this command was issued; dropping it',
    })
    expect(files.read('notes/new.md')).toBeNull()
    expect(files.read('notes/existing.md')).toBe('# Existing\n')
  })
})

describe('dev bridge note_write parity', () => {
  async function bridgeOver(initial: Record<string, string>) {
    const files = createDevFileStore(initial)
    return { files, bridge: createDevBridge({ files, index: await createDevIndexDb() }) }
  }

  it('refuses a write that names no contents to replace', async () => {
    const { files, bridge } = await bridgeOver({ 'notes/plan.md': '# Plan\n' })

    for (const check of [{}, { checkContents: false, expectedContents: '# Plan\n' }]) {
      await expect(
        bridge.invoke('note_write', { path: 'notes/plan.md', contents: '# New\n', ...check }),
      ).rejects.toMatchObject({ kind: 'parse' })
    }
    expect(files.read('notes/plan.md')).toBe('# Plan\n')
  })

  it('writes only over the contents the caller names', async () => {
    const { files, bridge } = await bridgeOver({ 'notes/plan.md': '# Plan\n' })
    const write = (path: string, expectedContents: string | null) =>
      bridge.invoke('note_write', {
        path,
        contents: '# New\n',
        checkContents: true,
        expectedContents,
      })

    await expect(write('notes/plan.md', '# Stale\n')).rejects.toMatchObject({
      kind: 'io',
      message: 'Note changed on disk; reload before retrying',
    })
    await expect(write('notes/plan.md', null)).rejects.toMatchObject({ kind: 'io' })
    expect(files.read('notes/plan.md')).toBe('# Plan\n')

    await write('notes/plan.md', '# Plan\n')
    await write('notes/fresh.md', null)
    expect(files.read('notes/plan.md')).toBe('# New\n')
    expect(files.read('notes/fresh.md')).toBe('# New\n')
  })
})
