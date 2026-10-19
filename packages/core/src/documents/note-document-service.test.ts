import { describe, expect, it } from 'vitest'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { createTestNoteSession, type TestNoteSessionOptions } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import {
  createTestNoteFileService,
  overrideNoteFileService,
  type TestNoteFileService,
  type TestNoteFileServiceOptions,
} from '../testing/graph.ts'
import { createNoteDocumentService, NoteBusyError } from './note-document-service.ts'
import { createTestGraphSessionService, type TestOpenGraph } from '../testing/graph-session.ts'
import { createOpenDocumentsService } from './open-documents-service.ts'

function setup(options?: {
  files?: TestNoteFileServiceOptions['files']
  generation?: number
  session?: Omit<TestNoteSessionOptions, 'path'> & { path?: string }
  graph?: TestOpenGraph
  /**
   * Wraps the file double, e.g. to interleave a concurrent change with a write.
   */
  noteFile?: (files: TestNoteFileService) => NoteFileService
}) {
  const files = createTestNoteFileService({
    ...(options?.files === undefined ? {} : { files: options.files }),
    ...(options?.generation === undefined ? {} : { generation: options.generation }),
  })
  const session =
    options?.session === undefined
      ? null
      : createTestNoteSession({ path: 'notes/a.md', ...options.session })
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  if (session !== null) {
    openDocuments.register({ session })
  }
  const noteDocuments = createNoteDocumentService({
    openDocuments,
    noteFile: options?.noteFile?.(files) ?? files,
    graphSession: createTestGraphSessionService({ graph: { generation: 3, ...options?.graph } }),
  })
  return { noteDocuments, noteFile: files, session, openDocuments }
}

/**
 * A file double whose first write runs `before` first: a concurrent change
 * landing between the read and the checked write.
 */
function interleaveFirstWrite(
  before: (files: TestNoteFileService) => void | Promise<void>,
): (files: TestNoteFileService) => NoteFileService {
  return (files) => {
    let first = true
    return overrideNoteFileService(files, {
      write: async (path, contents, generation, expectedContents) => {
        if (first) {
          first = false
          await before(files)
        }
        return await files.write(path, contents, generation, expectedContents)
      },
    })
  }
}

describe('readSource', () => {
  it("reads the open session's loaded buffer, not disk", async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# disk\n' },
      session: { content: '# live\n' },
    })
    await expect(noteDocuments.readSource('notes/a.md')).resolves.toBe('# live\n')
  })

  it('falls back to disk while the session is still loading (liveContent null)', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# disk\n' },
      session: { content: '', loaded: false },
    })
    await expect(noteDocuments.readSource('notes/a.md')).resolves.toBe('# disk\n')
  })

  it('reads disk when no session is open', async () => {
    const { noteDocuments } = setup({ files: { 'notes/a.md': '# disk\n' } })
    await expect(noteDocuments.readSource('notes/a.md')).resolves.toBe('# disk\n')
  })

  it('reads a missing file as an empty note', async () => {
    const { noteDocuments } = setup()
    await expect(noteDocuments.readSource('notes/a.md')).resolves.toBe('')
  })
})

describe('commitFrontmatter', () => {
  it('lands the patch through the live session when it can take it', async () => {
    const { noteDocuments, noteFile, session } = setup({
      files: { 'notes/a.md': '# A\n' },
      session: { content: '# A\n' },
    })

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(session?.getCalls('commitFrontmatter')).toEqual([[{ pinned: true }]])
    expect(noteFile.writes()).toEqual([])
  })

  it('falls back to a disk patch when the session declines the patch', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': '# A\n' },
      session: { content: '# A\n', accepts: false },
    })

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(noteFile.writes()).toEqual([
      { path: 'notes/a.md', contents: '---\npinned: true\n---\n\n# A\n', generation: 3 },
    ])
  })

  it('patches disk directly when no session is open', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': '# A\n' } })

    await noteDocuments.commitFrontmatter('notes/a.md', { private: true }, 3)

    expect(noteFile.writes()).toEqual([
      { path: 'notes/a.md', contents: '---\nprivate: true\n---\n\n# A\n', generation: 3 },
    ])
  })

  it('writes nothing when the patch changes nothing', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': '---\npinned: true\n---\n\n# A\n' },
    })

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(noteFile.writes()).toEqual([])
  })

  it('creates a missing file from the patch', async () => {
    const { noteDocuments, noteFile } = setup()

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(noteFile.files().get('notes/a.md')).toContain('pinned: true')
  })

  it('re-applies the patch to a concurrent change instead of clobbering it', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': '# A\n' },
      noteFile: interleaveFirstWrite((files) => files.set('notes/a.md', '# A\n\nsynced line\n')),
    })

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(noteFile.files().get('notes/a.md')).toBe(
      '---\npinned: true\n---\n\n# A\n\nsynced line\n',
    )
  })

  it('surfaces the conflict after three refused writes', async () => {
    let version = 0
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': '# A\n' },
      noteFile: (files) =>
        overrideNoteFileService(files, {
          write: async (path, ...rest) => {
            version += 1
            files.set(path, `# A\n\nv${version}\n`)
            return await files.write(path, ...rest)
          },
        }),
    })

    await expect(
      noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3),
    ).rejects.toMatchObject({ kind: 'io', message: 'Note changed on disk; reload before retrying' })
    expect(version).toBe(3)
    expect(noteFile.writes()).toEqual([])
  })

  it('patches a file that appeared after the missing read, never replacing it with the stub', async () => {
    const { noteDocuments, noteFile } = setup({
      noteFile: interleaveFirstWrite((files) => files.set('notes/a.md', '# Pulled\n')),
    })

    await noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3)

    expect(noteFile.files().get('notes/a.md')).toBe('---\npinned: true\n---\n\n# Pulled\n')
  })

  it('fails rather than bring back a note deleted while the patch is in flight', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': '# A\n' },
      noteFile: interleaveFirstWrite(async (files) => {
        await files.delete('notes/a.md', 3)
      }),
    })

    await expect(
      noteDocuments.commitFrontmatter('notes/a.md', { pinned: true }, 3),
    ).rejects.toMatchObject({ kind: 'notFound' })
    expect(noteFile.files().has('notes/a.md')).toBe(false)
  })
})

describe('commitSourceEdit', () => {
  const shout = (source: string): string => source.toUpperCase()

  it('applies the transform through the live session and leaves disk alone', async () => {
    const { noteDocuments, noteFile, session } = setup({
      files: { 'notes/a.md': 'disk\n' },
      session: { content: 'live\n', generation: 7 },
    })
    await noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 })
    expect(session!.content()).toBe('LIVE\n')
    expect(noteFile.writes()).toEqual([])
  })

  it('refuses with NoteBusyError when the session declines, without touching disk', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': 'disk\n' },
      session: { content: 'live\n', accepts: false, generation: 7 },
    })
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).rejects.toBeInstanceOf(NoteBusyError)
    expect(noteFile.writes()).toEqual([])
  })

  it('edits disk, not a session of another file generation', async () => {
    const { noteDocuments, noteFile, session } = setup({
      files: { 'notes/a.md': 'disk\n' },
      session: { content: 'live\n', generation: 8 },
    })
    await noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 })
    expect(session!.getCalls('commitSourceEdit')).toEqual([])
    expect(noteFile.writes()).toEqual([{ path: 'notes/a.md', contents: 'DISK\n', generation: 7 }])
  })

  it('reads, transforms and writes disk when no session is open', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'disk\n' } })
    await noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 })
    expect(noteFile.writes()).toEqual([{ path: 'notes/a.md', contents: 'DISK\n', generation: 7 }])
  })

  it('writes nothing when the transform changes nothing', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'disk\n' } })
    await noteDocuments.commitSourceEdit('notes/a.md', (source) => source, { generation: 7 })
    expect(noteFile.writes()).toEqual([])
  })

  it('re-applies the transform to a concurrent change instead of clobbering it', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': '+ [ ] do it\n' },
      noteFile: interleaveFirstWrite((files) =>
        files.set('notes/a.md', '+ [ ] do it\n+ [ ] synced\n'),
      ),
    })
    const toggleFirst = (source: string): string => source.replace('+ [ ]', '+ [x]')
    await noteDocuments.commitSourceEdit('notes/a.md', toggleFirst, { generation: 7 })
    expect(noteFile.files().get('notes/a.md')).toBe('+ [x] do it\n+ [ ] synced\n')
  })

  it('refuses every edit in a read-only local-only folder without reading or writing the note', async () => {
    const { noteDocuments, noteFile, session } = setup({
      files: { 'archive/bank.md': 'disk\n' },
      graph: { localOnlyFolders: ['archive'] },
      session: { path: 'archive/bank.md', content: 'live\n', generation: 7 },
    })
    await expect(
      noteDocuments.commitSourceEdit('archive/bank.md', shout, { generation: 7 }),
    ).rejects.toThrow(/read-only local-only/)
    expect(session!.getCalls('commitSourceEdit')).toEqual([])
    expect(noteFile.getReads()).toEqual([])
    expect(noteFile.writes()).toEqual([])
  })

  it('edits a note in an editable local-only folder, checked against what it read', async () => {
    const { noteDocuments, noteFile } = setup({
      files: { 'secure/bank.md': 'disk\n' },
      graph: { localOnlyFolders: ['secure'], localOnlyEditableFolders: ['secure'] },
      noteFile: interleaveFirstWrite((files) => files.set('secure/bank.md', 'newer\n')),
    })
    await noteDocuments.commitSourceEdit('secure/bank.md', shout, { generation: 7 })
    expect(noteFile.getWrites('secure/bank.md')).toEqual(['NEWER\n'])
  })

  it('rejects a missing note unless createIfMissing is set', async () => {
    const { noteDocuments, noteFile } = setup()
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 }),
    ).rejects.toMatchObject({ kind: 'notFound' })
    expect(noteFile.writes()).toEqual([])

    await noteDocuments.commitSourceEdit('notes/a.md', (source) => `${source}new\n`, {
      generation: 7,
      createIfMissing: true,
    })
    expect(noteFile.getWrites('notes/a.md')).toEqual(['new\n'])
  })

  it('propagates a transform error and writes nothing', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'disk\n' } })
    const fail = (): string => {
      throw new Error('stale')
    }
    await expect(
      noteDocuments.commitSourceEdit('notes/a.md', fail, { generation: 7 }),
    ).rejects.toThrow('stale')
    expect(noteFile.writes()).toEqual([])
  })

  it('serializes edits to one path, so the second reads what the first wrote', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'a' } })
    const append = (source: string): string => `${source}+`
    await Promise.all([
      noteDocuments.commitSourceEdit('notes/a.md', append, { generation: 7 }),
      noteDocuments.commitSourceEdit('notes/a.md', append, { generation: 7 }),
    ])
    expect(noteFile.getWrites('notes/a.md')).toEqual(['a+', 'a++'])
  })

  it('keeps the chain alive after a failed edit', async () => {
    const { noteDocuments, noteFile } = setup({ files: { 'notes/a.md': 'a' } })
    const fail = (): string => {
      throw new Error('stale')
    }
    const first = noteDocuments.commitSourceEdit('notes/a.md', fail, { generation: 7 })
    const second = noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 })
    await expect(first).rejects.toThrow('stale')
    await second
    expect(noteFile.getWrites('notes/a.md')).toEqual(['A'])
  })

  it('runs a new graph’s edit without waiting for the old graph’s same-path write', async () => {
    const firstWrite = Promise.withResolvers<void>()
    const { noteDocuments, noteFile } = setup({
      files: { 'notes/a.md': 'a' },
      noteFile: interleaveFirstWrite(() => firstWrite.promise),
    })
    const append = (source: string): string => `${source}+`
    const first = noteDocuments.commitSourceEdit('notes/a.md', append, { generation: 7 })
    try {
      await noteDocuments.commitSourceEdit('notes/a.md', append, { generation: 8 })
      expect(noteFile.writes()).toEqual([{ path: 'notes/a.md', contents: 'a+', generation: 8 }])
    } finally {
      firstWrite.resolve()
      await first.catch(() => undefined)
    }
  })

  it('never routes a queued edit into another graph’s same-path session', async () => {
    const firstWrite = Promise.withResolvers<void>()
    const { noteDocuments, noteFile, openDocuments } = setup({
      files: { 'notes/a.md': 'private text\n' },
      noteFile: interleaveFirstWrite(() => firstWrite.promise),
    })
    const first = noteDocuments.commitSourceEdit('notes/a.md', shout, { generation: 7 })
    const queued = noteDocuments.commitSourceEdit('notes/a.md', (source) => `${source}more\n`, {
      generation: 7,
    })
    // The next graph opens the same path while the old graph's edit is queued.
    const nextGraph = createTestNoteSession({
      path: 'notes/a.md',
      content: 'other graph\n',
      generation: 8,
    })
    openDocuments.register({ session: nextGraph })
    firstWrite.resolve()
    await first
    await queued
    expect(nextGraph.getCalls('commitSourceEdit')).toEqual([])
    expect(nextGraph.content()).toBe('other graph\n')
    expect(noteFile.getWrites('notes/a.md')).toEqual(['PRIVATE TEXT\n', 'PRIVATE TEXT\nmore\n'])
  })
})

describe('readExisting', () => {
  it('reads the live buffer of an open, ready session', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# On disk' },
      generation: 7,
      session: { content: '# Live', generation: 7 },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 7)).resolves.toBe('# Live')
  })

  it('preserves an authoritative empty live buffer', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# On disk' },
      generation: 7,
      session: { content: '', generation: 7 },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 7)).resolves.toBe('')
  })

  it('refuses a stale live buffer when its generation-pinned file is gone', async () => {
    const { noteDocuments } = setup({
      generation: 7,
      session: { content: '# Stale', generation: 7 },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 7)).rejects.toMatchObject({
      kind: 'notFound',
    })
  })

  it('refuses a live buffer when the read is pinned to another generation', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# On disk' },
      generation: 7,
      session: { content: '# Live', generation: 7 },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 8)).rejects.toBeDefined()
  })

  it('reads disk, not the live buffer of another generation’s session', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# On disk' },
      session: { content: '# Other graph', generation: 8 },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 7)).resolves.toBe('# On disk')
  })

  it('falls back to a generation-pinned disk read while the session is loading', async () => {
    const { noteDocuments } = setup({
      files: { 'notes/a.md': '# On disk' },
      generation: 7,
      session: { content: '', loaded: false, generation: 7 },
    })

    await expect(noteDocuments.readExisting('notes/a.md', 7)).resolves.toBe('# On disk')
    await expect(noteDocuments.readExisting('notes/a.md', 8)).rejects.toBeDefined()
  })
})

describe('isOstensiblyEmpty', () => {
  const { noteDocuments } = setup()

  it('treats blank and frontmatter-only notes as empty', () => {
    expect(noteDocuments.isOstensiblyEmpty('')).toBe(true)
    expect(noteDocuments.isOstensiblyEmpty('\n  \n')).toBe(true)
    expect(noteDocuments.isOstensiblyEmpty('---\npinned: true\n---\n')).toBe(true)
  })

  it('treats plain empty bullets as empty', () => {
    expect(noteDocuments.isOstensiblyEmpty('- ')).toBe(true)
    expect(noteDocuments.isOstensiblyEmpty('  *\n\n+   \n')).toBe(true)
  })

  it('treats bullet content as authored content', () => {
    expect(noteDocuments.isOstensiblyEmpty('- groceries\n')).toBe(false)
  })
})
