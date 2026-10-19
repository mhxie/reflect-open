import { expect, it, vi } from 'vitest'
import { createLocalOnlyFolders, ReflectError, type NoteRecovery } from '@reflect/core'
import {
  createTestCoreServices,
  createTestNoteFileService,
  overrideNoteFileService,
} from '@reflect/core/testing'
import { renderHookInApp } from '@/test-utils/render-in-app.tsx'
import { useNoteDocument } from './use-note-document.ts'

const NOTE = 'secure/note.md'

/**
 * A note in the editable local-only folder `secure`, whose writes fail while
 * `blocked()` (the folder is unmounted) and whose kept unsaved text lives one
 * copy per owner, the newest offered first, the way the Rust store keeps it.
 */
function recoveryStore(blocked: () => boolean) {
  const inner = createTestNoteFileService({
    files: { [NOTE]: '# Hello\n' },
    localOnly: createLocalOnlyFolders(['secure'], ['secure']),
  })
  const copies = new Map<string, NoteRecovery>()
  const cleared: string[] = []
  let version = 0
  const noteFile = overrideNoteFileService(inner, {
    async write(path, contents, generation, expectedContents) {
      if (blocked()) {
        throw new ReflectError('traversal', 'local-only folder is unmounted')
      }
      return await inner.write(path, contents, generation, expectedContents)
    },
    async writeRecovery(path, contents, ownerId, sourceRevision, generation) {
      expect({ path, generation }).toEqual({ path: NOTE, generation: 1 })
      expect(ownerId).toMatch(/^[a-f0-9]{32}$/)
      version += 1
      const copy: NoteRecovery = {
        ownerId,
        contents,
        sourceRevision,
        token: version.toString(16).padStart(32, '0'),
        savedAtMs: 5,
      }
      copies.delete(ownerId)
      copies.set(ownerId, copy)
      return copy
    },
    async readRecovery() {
      return [...copies.values()].at(-1) ?? null
    },
    async clearRecovery(path, ownerId, token) {
      expect(path).toBe(NOTE)
      cleared.push(token)
      if (copies.get(ownerId)?.token === token) copies.delete(ownerId)
    },
  })
  return { noteFile, copies, cleared, disk: () => inner.files().get(NOTE) }
}

it('pins recovery ownership to the hook session and offers each closed window’s draft', async () => {
  let blocked = true
  const store = recoveryStore(() => blocked)
  const app = createTestCoreServices({ noteFile: store.noteFile })
  const graph = {
    generation: 1,
    localOnlyFolders: ['secure'],
    localOnlyEditableFolders: ['secure'],
  }

  for (const contents of ['# A\n', '# B\n']) {
    const window = await renderHookInApp(() => useNoteDocument(NOTE), { app, graph })
    await vi.waitFor(() => expect(window.result.current.status).toBe('ready'))
    window.result.current.onEditorChange(contents)
    await app.openDocuments.flushAll()
    await vi.waitFor(() => expect(window.result.current.saveBlocked).toBe(true))
    await window.unmount()
  }
  expect(store.copies.size).toBe(2)
  const [first, second] = [...store.copies.values()]
  expect(first?.ownerId).not.toBe(second?.ownerId)
  expect(first?.sourceRevision).toBe('# Hello\n')
  expect(second?.sourceRevision).toBe('# Hello\n')

  blocked = false
  const reopened = await renderHookInApp(() => useNoteDocument(NOTE), { app, graph })
  await vi.waitFor(() => expect(reopened.result.current.recovery).toEqual(second))
  reopened.result.current.restoreRecovery()
  await app.openDocuments.flushAll()
  await vi.waitFor(() => expect(reopened.result.current.recovery).toEqual(first))
  // A was kept against the note B has since replaced, so restoring it parks
  // B as the conflict instead of silently overwriting it.
  reopened.result.current.restoreRecovery()
  await app.openDocuments.flushAll()
  await vi.waitFor(() => expect(reopened.result.current.conflict).toBe('# B\n'))
  expect(store.disk()).toBe('# B\n')
  reopened.result.current.keepMine()
  await app.openDocuments.flushAll()
  await vi.waitFor(() => expect(store.disk()).toBe('# A\n'))
  await vi.waitFor(() => expect(store.copies.size).toBe(0))
  expect(reopened.result.current.recovery).toBeNull()
  expect(store.cleared[0]).toBe(second?.token)
  expect(store.cleared.at(-1)).toBe(first?.token)
})
