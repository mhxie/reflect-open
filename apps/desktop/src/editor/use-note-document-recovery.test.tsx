import { setBridge, type NoteRecovery } from '@reflect/core'
import { afterEach, expect, it, vi } from 'vitest'
import { renderHook } from 'vitest-browser-react'
import { z } from 'zod'
import { flushOpenDocuments } from './open-documents.ts'
import { useNoteDocument } from './use-note-document.ts'

vi.mock('@reflect/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@reflect/core')>()),
  isLocalOnlyPath: (path: string) => path.startsWith('secure/'),
}))

const preserveSchema = z.object({
  path: z.literal('secure/note.md'),
  ownerId: z.string().regex(/^[a-f0-9]{32}$/),
  contents: z.string(),
  sourceRevision: z.string().nullable(),
  generation: z.literal(1),
})
const clearSchema = z.object({
  path: z.literal('secure/note.md'),
  ownerId: z.string(),
  token: z.string(),
  generation: z.literal(1),
})

afterEach(() => setBridge(null))

it('pins recovery ownership to the hook session and offers each closed window’s draft', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let disk = '# Hello\n'
  let blocked = true
  let version = 0
  const copies = new Map<string, NoteRecovery>()
  const clear = vi.fn<(args: z.infer<typeof clearSchema>) => void>()
  setBridge({
    invoke: async (command, args) => {
      if (command === 'note_read') return disk
      if (command === 'note_write') {
        if (blocked) throw { kind: 'traversal', message: 'local-only folder is unmounted' }
        const { contents, expectedContents } = z
          .object({
            contents: z.string(),
            expectedContents: z.string().nullable(),
          })
          .parse(args)
        expect(expectedContents).toBe(disk)
        disk = contents
        return null
      }
      if (command === 'note_recovery_write') {
        const { ownerId, contents, sourceRevision } = preserveSchema.parse(args)
        const copy: NoteRecovery = {
          ownerId,
          contents,
          sourceRevision,
          token: (++version).toString(16).padStart(32, '0'),
          savedAtMs: 5,
        }
        copies.delete(ownerId)
        copies.set(ownerId, copy)
        return copy
      }
      if (command === 'note_recovery_read') return [...copies.values()].at(-1) ?? null
      if (command === 'note_recovery_clear') {
        const identity = clearSchema.parse(args)
        clear(identity)
        if (copies.get(identity.ownerId)?.token === identity.token) copies.delete(identity.ownerId)
      }
      return null
    },
    listen: async () => () => {},
  })

  for (const contents of ['# A\n', '# B\n']) {
    const window = await renderHook(() => useNoteDocument('secure/note.md', 1))
    await vi.waitFor(() => expect(window.result.current.status).toBe('ready'))
    window.result.current.onEditorChange(contents)
    await flushOpenDocuments()
    await vi.waitFor(() => expect(window.result.current.saveBlocked).toBe(true))
    await window.unmount()
  }
  expect(copies.size).toBe(2)
  const [first, second] = [...copies.values()]
  expect(first?.ownerId).not.toBe(second?.ownerId)
  expect(first?.sourceRevision).toBe('# Hello\n')
  expect(second?.sourceRevision).toBe('# Hello\n')

  blocked = false
  const reopened = await renderHook(() => useNoteDocument('secure/note.md', 1))
  await vi.waitFor(() => expect(reopened.result.current.recovery).toEqual(second))
  reopened.result.current.restoreRecovery()
  await flushOpenDocuments()
  await vi.waitFor(() => expect(reopened.result.current.recovery).toEqual(first))
  // A was kept against the note B has since replaced, so restoring it parks
  // B as the conflict instead of silently overwriting it.
  reopened.result.current.restoreRecovery()
  await flushOpenDocuments()
  await vi.waitFor(() => expect(reopened.result.current.conflict).toBe('# B\n'))
  expect(disk).toBe('# B\n')
  reopened.result.current.keepMine()
  await flushOpenDocuments()
  await vi.waitFor(() => expect(disk).toBe('# A\n'))
  await vi.waitFor(() => expect(copies.size).toBe(0))
  expect(reopened.result.current.recovery).toBeNull()
  const cleared = clear.mock.calls.map(([identity]) => identity.token)
  expect(cleared[0]).toBe(second?.token)
  expect(cleared.at(-1)).toBe(first?.token)
  await reopened.unmount()
})
