import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import {
  createTestClockService,
  createTestFileChangeService,
  createTestIpcBridgeService,
  createTestNoteFileService,
  type TestIpcBridgeService,
} from '../testing/index.ts'
import type { FileChange } from '../indexing/file-change-service.ts'
import { createNoteFileService } from './note-file-service.ts'

function setup(ipc: TestIpcBridgeService = createTestIpcBridgeService()) {
  const fileChanges = createTestFileChangeService()
  const clock = createTestClockService({ now: 9_000 })
  return { ipc, fileChanges, noteFile: createNoteFileService({ ipc, clock, fileChanges }) }
}

describe('createNoteFileService', () => {
  it('reads through the optionally pinned commands', async () => {
    const { ipc, noteFile } = setup(
      createTestIpcBridgeService({
        commands: {
          note_read: () => '# A\n',
          note_read_local: () => ({ kind: 'evicted' }),
          note_exists: () => true,
        },
      }),
    )

    await expect(noteFile.read('notes/a.md', 4)).resolves.toBe('# A\n')
    await expect(noteFile.readLocal('notes/a.md', 4)).resolves.toEqual({ kind: 'evicted' })
    await expect(noteFile.exists('notes/a.md')).resolves.toBe(true)
    expect(ipc.calls()).toEqual([
      { command: 'note_read', args: { path: 'notes/a.md', generation: 4 } },
      { command: 'note_read_local', args: { path: 'notes/a.md', generation: 4 } },
      { command: 'note_exists', args: { path: 'notes/a.md' } },
    ])
  })

  it('reports a write as an own write', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_write', () => ({ modifiedMs: 1_234, merged: null }))

    await expect(noteFile.write('notes/a.md', 'new', 7, 'old')).resolves.toEqual({ merged: null })

    expect(ipc.calls()).toEqual([
      {
        command: 'note_write',
        args: {
          path: 'notes/a.md',
          contents: 'new',
          generation: 7,
          checkContents: true,
          expectedContents: 'old',
        },
      },
    ])
    expect(fileChanges.ownWrites()).toEqual([['notes/a.md']])
  })

  it('returns the merged text of a checked write that merged with the disk', async () => {
    const { ipc, noteFile } = setup()
    ipc.onCommand('note_write', () => ({
      modifiedMs: 1_234,
      merged: 'a\nB\nc',
    }))

    await expect(noteFile.write('notes/a.md', 'a\nB', 7, 'a\nb')).resolves.toEqual({
      merged: 'a\nB\nc',
    })
  })

  it('sends `expectedContents` for a checked write and does not report a rejected one', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_write', () => {
      throw new AppError('io', 'Note changed on disk; reload before retrying')
    })

    await expect(noteFile.write('notes/a.md', 'new', 7, null)).rejects.toMatchObject({
      kind: 'io',
    })

    expect(ipc.calls()[0]?.args).toEqual({
      path: 'notes/a.md',
      contents: 'new',
      generation: 7,
      checkContents: true,
      expectedContents: null,
    })
    expect(fileChanges.ownWrites()).toEqual([])
  })

  it('creates a note through the generation-pinned no-clobber command', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_create', () => ({ kind: 'created', modifiedMs: 1_234 }))

    await expect(noteFile.create('notes/ideas.md', '# Ideas\n', 7)).resolves.toEqual({
      kind: 'created',
      modifiedMs: 1_234,
    })

    expect(ipc.calls()).toEqual([
      {
        command: 'note_create',
        args: { path: 'notes/ideas.md', contents: '# Ideas\n', generation: 7 },
      },
    ])
    expect(fileChanges.ownWrites()).toEqual([['notes/ideas.md']])
  })

  it('returns a create collision as data without reporting a write', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_create', () => ({ kind: 'collision' }))

    await expect(noteFile.create('notes/ideas.md', '# Other\n', 7)).resolves.toEqual({
      kind: 'collision',
    })
    expect(fileChanges.ownWrites()).toEqual([])
  })

  it('propagates a create rejection without reporting a write', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_create', () => {
      throw new AppError('io', 'the graph changed since this command was issued; dropping it')
    })

    await expect(noteFile.create('notes/ideas.md', '# Ideas\n', 6)).rejects.toMatchObject({
      kind: 'io',
    })
    expect(fileChanges.ownWrites()).toEqual([])
  })

  it('reports a delete as an own remove', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_delete', () => ({ trashed: 'system' }))
    const batches: unknown[] = []
    fileChanges.subscribe((batch) => {
      batches.push(batch)
    })

    await expect(noteFile.delete('notes/a.md', 7)).resolves.toEqual({ trashed: 'system' })

    expect(ipc.calls()).toEqual([
      { command: 'note_delete', args: { path: 'notes/a.md', generation: 7 } },
    ])
    expect(fileChanges.ownWrites()).toEqual([['notes/a.md']])
    expect(batches).toEqual([])
  })

  it('validates the listings', async () => {
    const entry = { path: 'notes/a.md', size: 2, modifiedMs: 5 }
    const { ipc, noteFile } = setup(
      createTestIpcBridgeService({
        commands: {
          list_files: () => [entry],
          list_attachments: () => [],
          dir_list: () => [entry],
          vault_scan_stats: () => ({ notes: 1, attachments: 0, skipped: 2 }),
        },
      }),
    )

    await expect(noteFile.listNotes(3)).resolves.toEqual([entry])
    await expect(noteFile.listAttachments(3)).resolves.toEqual([])
    await expect(noteFile.listDir('notes', 3)).resolves.toEqual([entry])
    await expect(noteFile.vaultScanStats(3)).resolves.toEqual({
      notes: 1,
      attachments: 0,
      skipped: 2,
    })
    expect(ipc.calls()[2]).toEqual({ command: 'dir_list', args: { dir: 'notes', generation: 3 } })

    ipc.onCommand('list_files', () => [{ path: 'notes/a.md' }])
    await expect(noteFile.listNotes(3)).rejects.toMatchObject({ kind: 'parse' })
  })

  it('keeps where an external attachment is and refuses an unknown answer', async () => {
    const offline = {
      path: 'research/big.pdf',
      size: 9,
      modifiedMs: 5,
      placeholder: true,
      external: 'offline',
    }
    const { ipc, noteFile } = setup(
      createTestIpcBridgeService({ commands: { list_attachments: () => [offline] } }),
    )

    await expect(noteFile.listAttachments(3)).resolves.toEqual([offline])
    ipc.onCommand('list_attachments', () => [{ ...offline, external: 'elsewhere' }])
    await expect(noteFile.listAttachments(3)).rejects.toMatchObject({ kind: 'parse' })
  })
})
describe('fork note reads and writes', () => {
  it('sends the sharing mark and keeps the local-only verdict of a local read', async () => {
    const { ipc, noteFile } = setup(
      createTestIpcBridgeService({
        commands: {
          note_read_local: () => ({ kind: 'content', content: '# A\n', localOnly: true }),
        },
      }),
    )

    await expect(noteFile.readLocal('notes/a.md', 4, { sharing: true })).resolves.toEqual({
      kind: 'content',
      content: '# A\n',
      localOnly: true,
    })
    expect(ipc.calls()).toEqual([
      { command: 'note_read_local', args: { path: 'notes/a.md', generation: 4, sharing: true } },
    ])
  })

  it('rejects a local read whose content lacks the local-only verdict', async () => {
    const { noteFile } = setup(
      createTestIpcBridgeService({
        commands: { note_read_local: () => ({ kind: 'content', content: '# A\n' }) },
      }),
    )

    await expect(noteFile.readLocal('notes/a.md', 4)).rejects.toMatchObject({ kind: 'parse' })
  })

  it('reads shareable and on-device notes through their own commands', async () => {
    const { ipc, noteFile } = setup(
      createTestIpcBridgeService({
        commands: {
          note_read_shareable: () => ({ kind: 'localOnly' }),
          note_read_for_device: () => ({ content: '# Bank\n', localOnly: true }),
        },
      }),
    )

    await expect(noteFile.readShareable('finance/secure/bank.md', 2)).resolves.toEqual({
      kind: 'localOnly',
    })
    await expect(noteFile.readForDevice('finance/secure/bank.md', 2)).resolves.toEqual({
      content: '# Bank\n',
      localOnly: true,
    })
    expect(ipc.calls().map((call) => call.command)).toEqual([
      'note_read_shareable',
      'note_read_for_device',
    ])
  })

  it('reports a write that keeps the modification time as one to re-read', async () => {
    const { ipc, fileChanges, noteFile } = setup()
    ipc.onCommand('note_write_keep_modified', () => 1_000)

    await noteFile.writeKeepingModified('notes/a.md', 'summarized', 7, 'plain')

    expect(ipc.calls()).toEqual([
      {
        command: 'note_write_keep_modified',
        args: {
          path: 'notes/a.md',
          contents: 'summarized',
          generation: 7,
          expectedContents: 'plain',
        },
      },
    ])
    expect(fileChanges.ownWrites()).toEqual([['notes/a.md']])
  })

  it('echoes a write that keeps the modification time even without own-write echoes', async () => {
    const ipc = createTestIpcBridgeService()
    ipc.onCommand('note_write_keep_modified', () => 1_000)
    const fileChanges = createTestFileChangeService({ echoOwnWrites: false })
    const noteFile = createNoteFileService({ ipc, clock: createTestClockService(), fileChanges })
    const seen: FileChange[][] = []
    fileChanges.subscribe(({ changes }) => {
      seen.push([...changes])
    })

    await noteFile.writeKeepingModified('notes/a.md', 'summarized', 7, 'plain')

    expect(seen).toEqual([
      [{ path: 'notes/a.md', kind: 'upsert', reread: true, modifiedMs: 1_000 }],
    ])
  })

  it('reports which trash took a deleted note', async () => {
    const { ipc, noteFile } = setup()
    ipc.onCommand('note_delete', () => ({ trashed: 'graph' }))

    await expect(noteFile.delete('finance/secure/bank.md', 7)).resolves.toEqual({
      trashed: 'graph',
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
    const { ipc, noteFile } = setup(
      createTestIpcBridgeService({
        commands: {
          note_recovery_write: () => kept,
          note_recovery_read: () => kept,
          note_recovery_clear: () => null,
        },
      }),
    )

    await expect(
      noteFile.writeRecovery(
        'finance/secure/bank.md',
        kept.contents,
        kept.ownerId,
        kept.sourceRevision,
        3,
      ),
    ).resolves.toEqual(kept)
    await expect(noteFile.readRecovery('finance/secure/bank.md', 3)).resolves.toEqual(kept)
    await noteFile.clearRecovery('finance/secure/bank.md', kept.ownerId, kept.token, 3)

    expect(ipc.calls()).toEqual([
      {
        command: 'note_recovery_write',
        args: {
          path: 'finance/secure/bank.md',
          contents: kept.contents,
          ownerId: kept.ownerId,
          sourceRevision: kept.sourceRevision,
          generation: 3,
        },
      },
      {
        command: 'note_recovery_read',
        args: { path: 'finance/secure/bank.md', generation: 3 },
      },
      {
        command: 'note_recovery_clear',
        args: {
          path: 'finance/secure/bank.md',
          ownerId: kept.ownerId,
          token: kept.token,
          generation: 3,
        },
      },
    ])
  })

  it('reads no kept text as null', async () => {
    const { noteFile } = setup(
      createTestIpcBridgeService({ commands: { note_recovery_read: () => null } }),
    )

    await expect(noteFile.readRecovery('finance/secure/bank.md', 3)).resolves.toBeNull()
  })

  it('rejects recovery receipts without a valid ownership token', async () => {
    const { noteFile } = setup(
      createTestIpcBridgeService({
        commands: {
          note_recovery_read: () => ({
            ownerId: 'a'.repeat(32),
            token: '../other',
            sourceRevision: null,
            savedAtMs: 5,
            contents: 'unsaved',
          }),
        },
      }),
    )

    await expect(noteFile.readRecovery('finance/secure/bank.md', 3)).rejects.toMatchObject({
      kind: 'parse',
    })
  })
})

describe('createTestNoteFileService', () => {
  it('keeps files in memory and records writes', async () => {
    const noteFile = createTestNoteFileService({ files: { 'notes/a.md': 'old' } })

    await noteFile.write('notes/a.md', 'new', 1, 'old')
    await expect(noteFile.write('notes/a.md', 'newer', 1, 'old')).rejects.toMatchObject({
      kind: 'io',
    })
    await expect(noteFile.create('notes/a.md', 'other', 1)).resolves.toEqual({
      kind: 'collision',
    })
    await noteFile.delete('notes/a.md', 1)

    expect(noteFile.getWrites('notes/a.md')).toEqual(['new'])
    expect(noteFile.trashed()).toEqual(['notes/a.md'])
    expect(noteFile.files().size).toBe(0)
  })

  it('reports evicted notes and rejects other generations', async () => {
    const noteFile = createTestNoteFileService({
      files: { 'notes/a.md': 'a' },
      evicted: ['notes/a.md'],
      generation: 2,
    })

    await expect(noteFile.readLocal('notes/a.md', 2)).resolves.toEqual({ kind: 'evicted' })
    await expect(noteFile.listNotes(2)).resolves.toEqual([
      { path: 'notes/a.md', size: 1, modifiedMs: 0, placeholder: true },
    ])
    await expect(noteFile.read('notes/a.md', 1)).rejects.toMatchObject({ kind: 'io' })
  })
})

/**
 * A note file service over a bridge answering `invoke` and a file-change fake with the given echo setting.
 */
function installEcho(
  echoOwnWrites: boolean,
  invoke: (command: string) => unknown = (command) => {
    return command === 'note_write' ? { modifiedMs: null, merged: null } : null
  },
) {
  const ipc = createTestIpcBridgeService()
  ipc.onCommand('note_write', () => invoke('note_write'))
  ipc.onCommand('note_delete', () => invoke('note_delete') ?? { trashed: 'system' })
  const fileChanges = createTestFileChangeService({ echoOwnWrites })
  const noteFile = createNoteFileService({ ipc, clock: createTestClockService(), fileChanges })
  return { noteFile, fileChanges }
}

describe('local write echo (Plan 19, decision 5)', () => {
  it('emits an upsert to file-change subscribers after a note write', async () => {
    const { noteFile, fileChanges } = installEcho(true)
    const seen: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      seen.push([...changes])
    })

    await noteFile.write('daily/2026-06-12.md', 'hello', 1, null)

    // The platform reported no mtime: the echo carries the clock's time.
    expect(seen).toEqual([[{ path: 'daily/2026-06-12.md', kind: 'upsert', modifiedMs: 0 }]])
    unlisten()
  })

  it('emits a remove after a delete', async () => {
    const { noteFile, fileChanges } = installEcho(true)
    const seen: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      seen.push([...changes])
    })

    await noteFile.delete('notes/gone.md', 1)

    expect(seen).toEqual([[{ path: 'notes/gone.md', kind: 'remove' }]])
    unlisten()
  })

  it('stamps the echo with the on-disk mtime the write returned', async () => {
    // The reconcile's read-free skip compares the stored row's mtime against
    // the file listing — only the write's own on-disk stamp can ever match.
    const { noteFile, fileChanges } = installEcho(true, (command) => {
      return command === 'note_write' ? { modifiedMs: 1_234, merged: null } : null
    })
    const seen: FileChange[][] = []
    const unlisten = fileChanges.subscribe(({ changes }) => {
      seen.push([...changes])
    })

    await noteFile.write('notes/a.md', 'hello', 1, null)

    expect(seen).toEqual([[{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1_234 }]])
    unlisten()
  })

  it('stays silent when disabled (the desktop default — the watcher covers it)', async () => {
    const { noteFile, fileChanges } = installEcho(false)
    const handler = vi.fn()
    const unlisten = fileChanges.subscribe(handler)

    await noteFile.write('daily/2026-06-12.md', 'hello', 1, null)

    expect(handler).not.toHaveBeenCalled()
    unlisten()
  })

  it('does not emit when the write itself fails', async () => {
    const { noteFile, fileChanges } = installEcho(true, () => {
      throw new Error('disk full')
    })
    const handler = vi.fn()
    const unlisten = fileChanges.subscribe(handler)

    await expect(noteFile.write('daily/2026-06-12.md', 'hello', 1, null)).rejects.toThrow()

    expect(handler).not.toHaveBeenCalled()
    unlisten()
  })
})
