import { expect, it, vi } from 'vitest'
import { AppError, createLocalOnlyFolders, type NoteRecovery } from '@reflect/core'
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
 * `bases` holds the revision each landed write named.
 */
function recoveryStore(blocked: () => boolean) {
  const inner = createTestNoteFileService({
    files: { [NOTE]: '# Hello\n' },
    localOnly: createLocalOnlyFolders(['secure'], ['secure']),
  })
  const copies = new Map<string, NoteRecovery>()
  const cleared: string[] = []
  const bases: (string | null | undefined)[] = []
  let version = 0
  const noteFile = overrideNoteFileService(inner, {
    async write(path, contents, generation, expectedContents) {
      if (blocked()) {
        throw new AppError('traversal', 'local-only folder is unmounted')
      }
      const result = await inner.write(path, contents, generation, expectedContents)
      bases.push(expectedContents)
      return result
    },
    writeRecovery: (path, contents, ownerId, sourceRevision, generation) =>
      Promise.try(() => {
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
      }),
    readRecovery: () => Promise.resolve([...copies.values()].at(-1) ?? null),
    clearRecovery: (path, ownerId, token) =>
      Promise.try(() => {
        expect(path).toBe(NOTE)
        cleared.push(token)
        if (copies.get(ownerId)?.token === token) copies.delete(ownerId)
      }),
  })
  return {
    noteFile,
    copies,
    cleared,
    bases,
    disk: () => inner.files().get(NOTE),
    mergeNextWrite: (content: string) => inner.mergeNextWrite(NOTE, content),
  }
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
  expect(store.disk()).toBe('# B\n')
  // A was kept against the note B has since replaced, so restoring it names
  // that older revision as the write's base: the file merges A into B
  // instead of silently overwriting it.
  store.mergeNextWrite('# A\n\n# B\n')
  reopened.result.current.restoreRecovery()
  await app.openDocuments.flushAll()
  await vi.waitFor(() => expect(store.disk()).toBe('# A\n\n# B\n'))
  expect(store.bases.at(-1)).toBe('# Hello\n')
  await vi.waitFor(() => expect(store.copies.size).toBe(0))
  await vi.waitFor(() => expect(reopened.result.current.recovery).toBeNull())
  expect(store.cleared[0]).toBe(second?.token)
  expect(store.cleared.at(-1)).toBe(first?.token)
})
