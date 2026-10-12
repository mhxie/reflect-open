import { afterEach, describe, expect, it, vi } from 'vitest'
import { setBridge } from '../ipc/bridge.ts'
import { deleteNote, writeNote, writeNoteKeepingModified } from '../graph/commands.ts'
import type { NoteDeleteOutcome } from '../graph/schemas.ts'
import { subscribeFileChanges, type FileChange } from './file-changes.ts'
import { setLocalWriteEcho } from './local-write-echo.ts'

afterEach(() => {
  setLocalWriteEcho(false)
  setBridge(null)
})

function fakeBridge(trashed: NoteDeleteOutcome['trashed'] = 'system') {
  setBridge({
    invoke: async (command) => (command === 'note_delete' ? { trashed } : null),
    listen: async () => () => {},
  })
}

describe('local write echo (Plan 19, decision 5)', () => {
  it('emits an upsert to file-change subscribers after a note write', async () => {
    fakeBridge()
    setLocalWriteEcho(true)
    const seen: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => {
      seen.push(changes)
    })

    await writeNote('daily/2026-06-12.md', 'hello', 1, null)

    expect(seen).toHaveLength(1)
    expect(seen[0]![0]).toMatchObject({ path: 'daily/2026-06-12.md', kind: 'upsert' })
    expect(seen[0]![0]!.modifiedMs).toBeTypeOf('number')
    unlisten()
  })

  it.each(['system', 'graph'] as const)(
    'emits a remove after a delete into %s trash',
    async (trashed) => {
      fakeBridge(trashed)
      setLocalWriteEcho(true)
      const seen: FileChange[][] = []
      const unlisten = await subscribeFileChanges((changes) => {
        seen.push(changes)
      })

      await expect(deleteNote('notes/gone.md', 1)).resolves.toEqual({ trashed })

      expect(seen).toEqual([[{ path: 'notes/gone.md', kind: 'remove' }]])
      unlisten()
    },
  )

  it('stamps the echo with the on-disk mtime the write returned', async () => {
    // The reconcile's read-free skip compares the stored row's mtime against
    // the file listing — only the write's own on-disk stamp can ever match.
    setBridge({
      invoke: async (command) => (command === 'note_write' ? 1_234 : null),
      listen: async () => () => {},
    })
    setLocalWriteEcho(true)
    const seen: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => {
      seen.push(changes)
    })

    await writeNote('notes/a.md', 'hello', 1, null)

    expect(seen).toEqual([[{ path: 'notes/a.md', kind: 'upsert', modifiedMs: 1_234 }]])
    unlisten()
  })

  it('stays silent when disabled (the desktop default — the watcher covers it)', async () => {
    fakeBridge()
    const handler = vi.fn()
    const unlisten = await subscribeFileChanges(handler)

    await writeNote('daily/2026-06-12.md', 'hello', 1, null)

    expect(handler).not.toHaveBeenCalled()
    unlisten()
  })

  it('echoes a write that kept its mtime on desktop too, marked for a reread', async () => {
    // The watcher reports this write with the mtime the index already holds,
    // which reads as "unchanged": only the echo gets the summary indexed.
    let kept: number | null = 1_000
    setBridge({
      invoke: async (command) => (command === 'note_write_keep_modified' ? kept : null),
      listen: async () => () => {},
    })
    const seen: FileChange[][] = []
    const unlisten = await subscribeFileChanges((changes) => {
      seen.push(changes)
    })

    await writeNoteKeepingModified('notes/a.md', 'summarized', 1, 'before')
    kept = null
    await writeNoteKeepingModified('notes/b.md', 'summarized', 1, 'before')

    expect(seen).toEqual([
      [{ path: 'notes/a.md', kind: 'upsert', reread: true, modifiedMs: 1_000 }],
      [{ path: 'notes/b.md', kind: 'upsert', reread: true }],
    ])
    unlisten()
  })

  it('does not emit when the write itself fails', async () => {
    setBridge({
      invoke: async () => {
        throw new Error('disk full')
      },
      listen: async () => () => {},
    })
    setLocalWriteEcho(true)
    const handler = vi.fn()
    const unlisten = await subscribeFileChanges(handler)

    await expect(writeNote('daily/2026-06-12.md', 'hello', 1, null)).rejects.toThrow()

    expect(handler).not.toHaveBeenCalled()
    unlisten()
  })
})
