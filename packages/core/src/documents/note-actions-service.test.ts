import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../errors.ts'
import type { NoteFileService } from '../graph/note-file-service.ts'
import { createTestClockService } from '../testing/clock.ts'
import { createPathService, createPosixPathTransport } from '../ports/path-service.ts'
import type { IndexLifecycleService } from '../indexing/index-lifecycle-service.ts'
import {
  createIndexQueryService,
  type IndexQueryService,
  type PinnedNote,
} from '../indexing/index-query-service.ts'
import { createTestDatabaseService } from '../testing/database.ts'
import { createTestIndexLifecycleService } from '../testing/index-lifecycle.ts'
import { createTestNoteSession, type TestNoteSessionOptions } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import {
  createTestGraphSessionService,
  type TestGraphSessionService,
  type TestOpenGraph,
} from '../testing/graph-session.ts'
import { createTestIdService } from '../testing/id.ts'
import { parseNote } from '../markdown/extract.ts'
import { createTestNoteFileService, overrideNoteFileService } from '../testing/graph.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import { createTestProgressPort } from '../testing/ports.ts'
import {
  canTrashNote,
  createNoteActionsService,
  hasUnreadableLock,
  KEPT_IN_GRAPH_TRASH,
} from './note-actions-service.ts'
import { createNoteDocumentService } from './note-document-service.ts'
import { createNoteRowService, type NoteRowService } from './note-row-service.ts'
import { createNoteSessionService } from './note-session-service.ts'
import type { NoteSession, NoteSessionSnapshot } from './note-session-types.ts'
import { createOpenDocumentsService } from './open-documents-service.ts'

const ULID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/

/**
 * A test graph session with the graph at `/g` of generation 3 (index generation 8) open.
 */
function createTestGraph(graph?: Partial<TestOpenGraph>): TestGraphSessionService {
  return createTestGraphSessionService({
    graph: { root: '/g', generation: 3, indexGeneration: 8, ...graph },
  })
}

/**
 * An index lifecycle whose `indexNote` only records its calls into `log`.
 */
function recordingIndexLifecycle(
  log: { path: string; generation: number }[],
): IndexLifecycleService {
  const indexLifecycle = createTestIndexLifecycleService()
  vi.spyOn(indexLifecycle, 'indexNote').mockImplementation((path, indexOptions) => {
    log.push({ path, generation: indexOptions.generation })
    return Promise.resolve()
  })
  return indexLifecycle
}

/**
 * An index lifecycle whose `indexNote` runs `indexNote`.
 */
function indexLifecycleWith(indexNote: () => Promise<void>): IndexLifecycleService {
  const indexLifecycle = createTestIndexLifecycleService()
  vi.spyOn(indexLifecycle, 'indexNote').mockImplementation(indexNote)
  return indexLifecycle
}

/**
 * The real service; without `indexLifecycle`, an indexer that only records its calls.
 */
function createNoteActions(deps: {
  noteFile: NoteFileService
  sessions: readonly NoteSession[]
  progress?: ReturnType<typeof createTestProgressPort>
  indexLifecycle?: IndexLifecycleService
  indexQuery?: IndexQueryService
  noteRows?: NoteRowService
  graph?: TestGraphSessionService
}) {
  const { noteFile } = deps
  const graph = deps.graph ?? createTestGraph()
  const openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
  for (const session of deps.sessions) {
    openDocuments.register({ session })
  }
  const indexLog: { path: string; generation: number }[] = []
  const service = createNoteActionsService({
    noteDocuments: createNoteDocumentService({
      openDocuments,
      noteFile,
      graphSession: createTestGraphSessionService({ graph: { generation: 3 } }),
    }),
    noteFile,
    openDocuments,
    indexLifecycle: deps.indexLifecycle ?? recordingIndexLifecycle(indexLog),
    indexQuery:
      deps.indexQuery ?? createIndexQueryService({ database: createTestDatabaseService() }),
    noteRows: deps.noteRows ?? createNoteRowService({ graphSession: graph }),
    progress: deps.progress ?? createTestProgressPort(),
    path: createPathService({ transport: createPosixPathTransport('/home/test') }),
    id: createTestIdService(),
    graphSession: graph,
  })
  return { actions: Object.assign(service, { indexed: () => [...indexLog] }), openDocuments }
}

function setup(options?: {
  files?: Readonly<Record<string, string>>
  session?: TestNoteSessionOptions
  /**
   * Wraps the in-memory files, e.g. to make a call fail.
   */
  wrapNoteFile?: (files: NoteFileService) => NoteFileService
  indexNote?: () => Promise<void>
  /**
   * The pinned shelf the index lists.
   */
  pinned?: readonly PinnedNote[] | (() => Promise<PinnedNote[]>)
  /**
   * The open graph's fields over the default `/g` (e.g. its local-only folders).
   */
  graph?: Partial<TestOpenGraph>
}) {
  const files = createTestNoteFileService(
    options?.files === undefined ? {} : { files: options.files },
  )
  const session = options?.session === undefined ? null : createTestNoteSession(options.session)
  const progress = createTestProgressPort()
  const graph = createTestGraph(options?.graph)
  const noteRows = createNoteRowService({ graphSession: graph })
  const pinned = options?.pinned ?? []
  const indexQuery = createIndexQueryService({ database: createTestDatabaseService() })
  vi.spyOn(indexQuery, 'getPinnedNotes').mockImplementation(
    typeof pinned === 'function' ? pinned : () => Promise.resolve([...pinned]),
  )
  const { actions, openDocuments } = createNoteActions({
    noteFile: options?.wrapNoteFile?.(files) ?? files,
    sessions: session === null ? [] : [session],
    progress,
    noteRows,
    graph,
    indexQuery,
    ...(options?.indexNote === undefined
      ? {}
      : { indexLifecycle: indexLifecycleWith(options.indexNote) }),
  })
  return { actions, files, session, openDocuments, progress, noteRows, graph }
}

function shelfNote(path: string, pinnedOrder: number | null): PinnedNote {
  return { path, title: path, dailyDate: null, pinnedOrder }
}

function failing(method: 'read' | 'write' | 'delete', error: unknown) {
  return (files: NoteFileService): NoteFileService =>
    overrideNoteFileService(files, {
      [method]: () =>
        Promise.try(() => {
          throw error
        }),
    })
}

describe('togglePinned', () => {
  it('pins an unpinned note after the highest order on the shelf', async () => {
    const { actions, files, noteRows } = setup({
      files: { 'notes/a.md': '# A\n' },
      pinned: [shelfNote('notes/b.md', 2048)],
    })

    await expect(actions.togglePinned('notes/a.md')).resolves.toEqual({
      status: 'done',
      pinned: true,
      pinOrder: 3072,
    })

    expect(files.writes()).toEqual([
      { path: 'notes/a.md', contents: '---\npinned: 3072\n---\n\n# A\n', generation: 3 },
    ])
    expect(noteRows.getOverlay('notes/a.md')).toEqual({ isPinned: true, pinnedOrder: 3072 })
  })

  it('writes a bare `pinned: true` when the shelf cannot be read', async () => {
    const { actions, files, noteRows } = setup({
      files: { 'notes/a.md': '# A\n' },
      pinned: () => Promise.reject(new Error('index closed')),
    })

    await expect(actions.togglePinned('notes/a.md')).resolves.toEqual({
      status: 'done',
      pinned: true,
      pinOrder: null,
    })

    expect(files.getWrites('notes/a.md')).toEqual(['---\npinned: true\n---\n\n# A\n'])
    expect(noteRows.getOverlay('notes/a.md')).toEqual({ isPinned: true, pinnedOrder: null })
  })

  it('gives two quick pins distinct orders through the overlay', async () => {
    const { actions, files } = setup({
      files: { 'notes/a.md': '# A\n', 'notes/b.md': '# B\n' },
      pinned: [shelfNote('notes/c.md', 1024)],
    })

    await Promise.all([actions.togglePinned('notes/a.md'), actions.togglePinned('notes/b.md')])

    expect(files.getWrites('notes/a.md')).toEqual(['---\npinned: 2048\n---\n\n# A\n'])
    expect(files.getWrites('notes/b.md')).toEqual(['---\npinned: 3072\n---\n\n# B\n'])
  })

  it('unpins a pinned note by removing the key, whatever the shelf says', async () => {
    const { actions, files, noteRows } = setup({
      files: { 'notes/a.md': '---\npinned: true\n---\n# A\n' },
    })

    await expect(actions.togglePinned('notes/a.md')).resolves.toEqual({
      status: 'done',
      pinned: false,
      pinOrder: null,
    })

    expect(files.getWrites('notes/a.md')).toEqual(['# A\n'])
    // The shelf predicted a pin; the note's frontmatter corrected it.
    expect(noteRows.getOverlay('notes/a.md')).toEqual({ isPinned: false })
  })

  it('records the predicted pin before the note is read', async () => {
    const { actions, noteRows, files } = setup({ files: { 'notes/a.md': '# A\n' } })
    const read = vi.spyOn(files, 'read')
    let overlayAtRead: unknown = 'unread'
    read.mockImplementationOnce(async (...args) => {
      overlayAtRead = noteRows.getOverlay('notes/a.md')
      read.mockRestore()
      return await files.read(...args)
    })

    await actions.togglePinned('notes/a.md')

    expect(overlayAtRead).toEqual({ isPinned: true, pinnedOrder: 1024 })
  })

  it('treats an explicit order, including 0, as pinned', async () => {
    // `pinned: 0` is falsy in JS; a truthiness check would re-pin instead.
    const { actions, files } = setup({ files: { 'notes/a.md': '---\npinned: 0\n---\n# A\n' } })

    const outcome = await actions.togglePinned('notes/a.md')

    expect(outcome).toMatchObject({ status: 'done', pinned: false })
    expect(files.getWrites('notes/a.md')).toEqual(['# A\n'])
  })

  it('routes through the live session, which owns landing the patch', async () => {
    const { actions, files, session } = setup({
      session: { path: 'notes/a.md', content: '---\npinned: 2\n---\n# A\n' },
    })

    await actions.togglePinned('notes/a.md')

    expect(session?.getCalls('commitFrontmatter')).toEqual([[{ pinned: false }]])
    expect(files.writes()).toEqual([])
  })

  it('pins a not-yet-created note by creating its file (the lazy contract)', async () => {
    // A pane session that is still loading: `liveContent` is null, the session
    // cannot take the patch, and the file does not exist. A missing note reads
    // as empty, and the pin write is what creates it.
    const { actions, files } = setup({
      session: { path: 'daily/2026-06-10.md', loaded: false, accepts: false },
      pinned: () => Promise.reject(new Error('index closed')),
    })

    await actions.togglePinned('daily/2026-06-10.md')

    expect(files.getWrites('daily/2026-06-10.md')).toEqual(['---\npinned: true\n---\n\n'])
  })

  it('answers a second call while the first is in flight with the first result', async () => {
    const gate = Promise.withResolvers<PinnedNote[]>()
    const getPinnedNotes = vi.fn(() => gate.promise)
    const { actions, files } = setup({ files: { 'notes/a.md': '# A\n' }, pinned: getPinnedNotes })
    const first = actions.togglePinned('notes/a.md')

    const second = actions.togglePinned('notes/a.md')
    const unpin = actions.unpin('notes/a.md')
    expect(getPinnedNotes).toHaveBeenCalledOnce()

    gate.resolve([shelfNote('notes/b.md', 1024)])
    const done = { status: 'done', pinned: true, pinOrder: 2048 }
    await expect(first).resolves.toEqual(done)
    await expect(second).resolves.toEqual(done)
    await expect(unpin).resolves.toEqual(done)
    expect(files.writes()).toHaveLength(1)
  })

  it('does not dedupe across notes or generations', async () => {
    const gate = Promise.withResolvers<PinnedNote[]>()
    let calls = 0
    const { actions, graph } = setup({
      files: { 'notes/a.md': '# A\n', 'notes/b.md': '# B\n' },
      pinned: async () => {
        calls += 1
        return calls === 1 ? await gate.promise : []
      },
    })
    const first = actions.togglePinned('notes/a.md')

    await expect(actions.togglePinned('notes/b.md')).resolves.toMatchObject({ status: 'done' })
    graph.setGraph({ root: '/g', generation: 4 })
    await expect(actions.togglePinned('notes/a.md')).resolves.toMatchObject({ status: 'done' })

    gate.resolve([])
    await first
  })

  it('reports a failure through progress, drops its overlay, and accepts a retry', async () => {
    let fail = true
    const { actions, files, progress, noteRows } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          read: async (...args) => {
            if (fail) {
              throw new AppError('io', 'disk on fire')
            }
            return await inner.read(...args)
          },
        }),
    })

    await expect(actions.togglePinned('notes/a.md')).resolves.toEqual({ status: 'failed' })
    expect(files.writes()).toEqual([])
    expect(noteRows.getOverlay('notes/a.md')).toBeNull()
    expect(progress.snapshot()).toMatchObject([
      { label: 'Updating pin', status: 'failed', message: 'disk on fire' },
    ])

    fail = false
    await expect(actions.togglePinned('notes/a.md')).resolves.toMatchObject({ status: 'done' })
  })

  it("keeps another action's overlay when it fails", async () => {
    const { actions, noteRows } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: failing('write', new Error('disk full')),
    })
    noteRows.setOverlay('notes/a.md', 3, { gistUrl: 'https://gist.github.com/alex/g1' })

    await expect(actions.togglePinned('notes/a.md')).resolves.toEqual({ status: 'failed' })

    expect(noteRows.getOverlay('notes/a.md')).toEqual({
      gistUrl: 'https://gist.github.com/alex/g1',
    })
  })

  it('re-applies the pin to a concurrent change instead of clobbering it', async () => {
    let first = true
    const { actions, files } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          write: async (...args) => {
            if (first) {
              first = false
              files.set('notes/a.md', '# A\n\nsynced\n')
            }
            return await inner.write(...args)
          },
        }),
    })

    await expect(actions.togglePinned('notes/a.md')).resolves.toMatchObject({ status: 'done' })

    expect(files.files().get('notes/a.md')).toBe('---\npinned: 1024\n---\n\n# A\n\nsynced\n')
  })
})

describe('pinning a note in a read-only local-only folder', () => {
  it('changes nothing: no optimistic pin, no read, no write, no report', async () => {
    const { actions, files, noteRows, progress } = setup({
      files: { 'finance/secure/a.md': '# A\n' },
      graph: { localOnlyFolders: ['finance'] },
    })

    await expect(actions.togglePinned('finance/secure/a.md')).resolves.toEqual({
      status: 'skipped',
    })
    await expect(actions.unpin('finance/secure/a.md')).resolves.toEqual({ status: 'skipped' })

    expect(noteRows.getOverlay('finance/secure/a.md')).toBeNull()
    expect(files.getReads()).toEqual([])
    expect(files.writes()).toEqual([])
    expect(progress.getAll()).toEqual([])
  })

  it('pins a note in an editable local-only folder', async () => {
    const { actions, files } = setup({
      files: { 'finance/secure/a.md': '# A\n' },
      graph: { localOnlyFolders: ['finance'], localOnlyEditableFolders: ['finance'] },
    })

    await expect(actions.togglePinned('finance/secure/a.md')).resolves.toMatchObject({
      status: 'done',
      pinned: true,
    })
    expect(files.getWrites('finance/secure/a.md')).toEqual(['---\npinned: 1024\n---\n\n# A\n'])
  })
})

describe('unpin', () => {
  it('unpins directly without reading the current pin state', async () => {
    const { actions, session, noteRows } = setup({
      session: { path: 'notes/a.md', content: '---\npinned: 2\n---\n# A\n' },
    })
    const liveContent = vi.spyOn(session!, 'liveContent')

    await expect(actions.unpin('notes/a.md')).resolves.toEqual({
      status: 'done',
      pinned: false,
      pinOrder: null,
    })

    expect(noteRows.getOverlay('notes/a.md')).toEqual({ isPinned: false })
    expect(liveContent).not.toHaveBeenCalled()
    expect(session?.getCalls('commitFrontmatter')).toEqual([[{ pinned: false }]])
  })

  it('unpins on disk by removing the key', async () => {
    const { actions, files } = setup({ files: { 'notes/a.md': '---\npinned: true\n---\n# A\n' } })

    await actions.unpin('notes/a.md')

    expect(files.getWrites('notes/a.md')).toEqual(['# A\n'])
  })
})

describe('reorderPinned', () => {
  it('writes each valid order and returns what it wrote', async () => {
    const { actions, files } = setup({ files: { 'notes/a.md': '# A\n', 'notes/c.md': '# C\n' } })

    await expect(
      actions.reorderPinned([
        { path: 'notes/c.md', pinnedOrder: 1024 },
        { path: 'notes/a.md', pinnedOrder: 1536 },
        { path: 'notes/b.md', pinnedOrder: null },
        { path: 'notes/d.md', pinnedOrder: -1 },
      ]),
    ).resolves.toEqual([
      { path: 'notes/c.md', pinOrder: 1024 },
      { path: 'notes/a.md', pinOrder: 1536 },
    ])

    expect(files.getWrites('notes/c.md')).toEqual(['---\npinned: 1024\n---\n\n# C\n'])
    expect(files.getWrites('notes/a.md')).toEqual(['---\npinned: 1536\n---\n\n# A\n'])
    expect(files.getWrites('notes/b.md')).toEqual([])
    expect(files.getWrites('notes/d.md')).toEqual([])
  })

  it('records the orders at once and writes one reorder after another', async () => {
    const gate = Promise.withResolvers<void>()
    const { actions, files, noteRows } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          write: async (...args) => {
            await gate.promise
            return await inner.write(...args)
          },
        }),
    })

    const first = actions.reorderPinned([{ path: 'notes/a.md', pinnedOrder: 1024 }])
    const second = actions.reorderPinned([{ path: 'notes/a.md', pinnedOrder: 2048 }])
    expect(noteRows.getOverlay('notes/a.md')).toEqual({ pinnedOrder: 2048 })

    gate.resolve()
    await Promise.all([first, second])
    expect(files.getWrites('notes/a.md')).toEqual([
      '---\npinned: 1024\n---\n\n# A\n',
      '---\npinned: 2048\n---\n\n# A\n',
    ])
  })

  it('routes open notes through their sessions', async () => {
    const { actions, files, session } = setup({ session: { path: 'notes/a.md', content: '# A\n' } })

    await actions.reorderPinned([{ path: 'notes/a.md', pinnedOrder: 1024 }])

    expect(session?.getCalls('commitFrontmatter')).toEqual([[{ pinned: 1024 }]])
    expect(files.writes()).toEqual([])
  })

  it('rejects and drops its overlay when a write fails', async () => {
    const { actions, noteRows } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: failing('write', new Error('disk full')),
    })

    await expect(
      actions.reorderPinned([{ path: 'notes/a.md', pinnedOrder: 1024 }]),
    ).rejects.toThrow('disk full')
    expect(noteRows.getOverlay('notes/a.md')).toBeNull()
    // A failed reorder does not block the next one.
    await expect(
      actions.reorderPinned([{ path: 'notes/a.md', pinnedOrder: 2048 }]),
    ).rejects.toThrow('disk full')
  })
})

describe('togglePrivate', () => {
  it('marks a note private and returns the new state', async () => {
    const { actions, files, noteRows } = setup({ files: { 'notes/a.md': '# A\n' } })

    await expect(actions.togglePrivate('notes/a.md')).resolves.toEqual({
      status: 'done',
      isPrivate: true,
      changed: true,
    })
    expect(noteRows.getOverlay('notes/a.md')).toEqual({ isPrivate: true })

    expect(files.writes()).toEqual([
      { path: 'notes/a.md', contents: '---\nprivate: true\n---\n\n# A\n', generation: 3 },
    ])
  })

  it('un-marks by removing the key, honouring the YAML 1.1-style `private: yes`', async () => {
    // A 1.2 loader reads `yes` as a string; the schema's coercion still
    // honours it, so the toggle must too: re-marking would be a silent no-op.
    const { actions, files } = setup({
      files: { 'notes/a.md': '---\nprivate: yes\n---\n# A\n' },
    })

    await expect(actions.togglePrivate('notes/a.md')).resolves.toEqual({
      status: 'done',
      isPrivate: false,
      changed: true,
    })

    expect(files.getWrites('notes/a.md')).toEqual(['# A\n'])
  })

  it('replaces an explicit `private: false` with `private: true` when toggling on', async () => {
    const { actions, files } = setup({ files: { 'notes/a.md': '---\nprivate: false\n---\n# A\n' } })

    await actions.togglePrivate('notes/a.md')

    expect(files.getWrites('notes/a.md')).toEqual(['---\nprivate: true\n---\n\n# A\n'])
  })

  it('routes through the live session', async () => {
    const { actions, files, session } = setup({ session: { path: 'notes/a.md', content: '# A\n' } })

    await actions.togglePrivate('notes/a.md')

    expect(session?.getCalls('commitFrontmatter')).toEqual([[{ private: true }]])
    expect(files.writes()).toEqual([])
  })

  it('marks a not-yet-created note private by creating its file (the lazy contract)', async () => {
    const { actions, files } = setup({
      session: { path: 'daily/2026-06-10.md', loaded: false, accepts: false },
    })

    await actions.togglePrivate('daily/2026-06-10.md')

    expect(files.getWrites('daily/2026-06-10.md')).toEqual(['---\nprivate: true\n---\n\n'])
  })

  it('reads the note first, then shows the new state before the write lands', async () => {
    const overlaysAtRead: unknown[] = []
    let overlayAtWrite: unknown = 'unwritten'
    const { actions, noteRows, files } = setup({
      files: { 'notes/a.md': '---\nprivate: true\n---\n# A\n' },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          read: async (...args) => {
            overlaysAtRead.push(noteRows.getOverlay('notes/a.md'))
            return await inner.read(...args)
          },
          write: async (...args) => {
            overlayAtWrite = noteRows.getOverlay('notes/a.md')
            return await inner.write(...args)
          },
        }),
    })

    await actions.togglePrivate('notes/a.md')

    // Nothing predicted before the note was read: an unreadable lock never shows unlocked.
    expect(overlaysAtRead[0]).toBeNull()
    expect(overlayAtWrite).toEqual({ isPrivate: false })
    expect(files.getWrites('notes/a.md')).toEqual(['# A\n'])
  })

  it('re-applies the flag to a concurrent change instead of clobbering it', async () => {
    let first = true
    const { actions, files } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          write: async (...args) => {
            if (first) {
              first = false
              files.set('notes/a.md', '# A\n\nsynced\n')
            }
            return await inner.write(...args)
          },
        }),
    })

    await actions.togglePrivate('notes/a.md')

    expect(files.files().get('notes/a.md')).toBe('---\nprivate: true\n---\n\n# A\n\nsynced\n')
  })

  it('refuses to toggle a note whose frontmatter cannot be read, writing nothing', async () => {
    const sources = [
      '---\nprivate: maybe\n---\n# A\n',
      '---\nprivate: no\ntitle: [unclosed\n---\n# A\n',
      '\u{FEFF}---\nprivate: true\n---\n# A\n',
      // Locked by its `private:` line, but the YAML around it doesn't load.
      '---\nprivate: true\ntitle: [unclosed\n---\n# A\n',
    ]
    for (const source of sources) {
      const { actions, files, noteRows, progress } = setup({ files: { 'notes/a.md': source } })
      noteRows.setOverlay('notes/a.md', 3, { isPrivate: true })

      await expect(actions.togglePrivate('notes/a.md')).resolves.toEqual({ status: 'failed' })

      expect(files.writes()).toEqual([])
      expect(progress.snapshot()).toMatchObject([
        {
          label: 'Updating privacy',
          status: 'failed',
          message: expect.stringContaining("can't be read"),
        },
      ])
      // Never predicted unlocked, not even for a moment.
      expect(noteRows.getOverlay('notes/a.md')).toEqual({ isPrivate: true })
    }
  })

  it('leaves an open session with unreadable frontmatter untouched', async () => {
    const { actions, session, progress } = setup({
      session: { path: 'notes/a.md', content: '---\nprivate: maybe\n---\n# A\n' },
    })

    await actions.togglePrivate('notes/a.md')

    expect(session?.getCalls('commitFrontmatter')).toEqual([])
    expect(progress.snapshot()).toHaveLength(1)
  })

  it('locks an unopened note whose block sits behind a byte-order mark', async () => {
    const { actions, files, progress } = setup({
      files: { 'notes/a.md': '\u{FEFF}---\ntitle: Diary\n---\n\nsecret\n' },
    })

    await actions.togglePrivate('notes/a.md')

    expect(progress.getAll()).toEqual([])
    expect(files.getWrites('notes/a.md')).toEqual([
      '---\ntitle: Diary\nprivate: true\n---\n\nsecret\n',
    ])
  })

  it('skips a note in a local-only folder, private by its path, without a report', async () => {
    const { actions, files, noteRows, progress } = setup({
      files: { 'secure/a.md': '# A\n', 'archive/b.md': '# B\n' },
      graph: { localOnlyFolders: ['secure', 'archive'], localOnlyEditableFolders: ['secure'] },
    })

    await expect(actions.togglePrivate('secure/a.md')).resolves.toEqual({ status: 'skipped' })
    await expect(actions.togglePrivate('archive/b.md')).resolves.toEqual({ status: 'skipped' })

    expect(files.getReads()).toEqual([])
    expect(files.writes()).toEqual([])
    expect(noteRows.getOverlays().size).toBe(0)
    expect(progress.getAll()).toEqual([])
  })

  it('reports a read failure through progress and writes nothing', async () => {
    const { actions, files, progress } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: failing('read', { kind: 'io', message: 'disk on fire' }),
    })

    await expect(actions.togglePrivate('notes/a.md')).resolves.toEqual({ status: 'failed' })

    expect(files.writes()).toEqual([])
    expect(progress.snapshot()).toMatchObject([
      { label: 'Updating privacy', status: 'failed', message: 'disk on fire' },
    ])
  })

  it('answers a duplicate while in flight with the first result', async () => {
    const gate = Promise.withResolvers<void>()
    const { actions, files } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          read: async (...args) => {
            await gate.promise
            return await inner.read(...args)
          },
        }),
    })
    const first = actions.togglePrivate('notes/a.md')
    const second = actions.togglePrivate('notes/a.md')

    gate.resolve()
    const done = { status: 'done', isPrivate: true, changed: true }
    await expect(first).resolves.toEqual(done)
    await expect(second).resolves.toEqual(done)
    expect(files.writes()).toHaveLength(1)
  })

  it('is deduped apart from pin actions on the same note', async () => {
    const gate = Promise.withResolvers<PinnedNote[]>()
    const { actions } = setup({ files: { 'notes/a.md': '# A\n' }, pinned: () => gate.promise })
    const pin = actions.togglePinned('notes/a.md')

    await expect(actions.togglePrivate('notes/a.md')).resolves.toMatchObject({ status: 'done' })

    gate.resolve([])
    await pin
  })

  it('reports a failure through progress, drops its overlay, and accepts a retry', async () => {
    const { actions, progress, noteRows } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: failing('write', new Error('disk full')),
    })

    await expect(actions.togglePrivate('notes/a.md')).resolves.toEqual({ status: 'failed' })
    expect(noteRows.getOverlay('notes/a.md')).toBeNull()
    expect(progress.snapshot()).toMatchObject([
      { label: 'Updating privacy', status: 'failed', message: 'disk full' },
    ])
    await expect(actions.togglePrivate('notes/a.md')).resolves.toEqual({ status: 'failed' })
  })

  it('puts the note back byte for byte when its Undo sets the old flag', async () => {
    const { actions, files } = setup({ files: { 'notes/a.md': '# A\n' } })

    const outcome = await actions.togglePrivate('notes/a.md')
    expect(files.files().get('notes/a.md')).toBe('---\nprivate: true\n---\n\n# A\n')
    if (outcome.status !== 'done') {
      throw new Error('the toggle did not land')
    }

    await expect(actions.setNotesPrivate(['notes/a.md'], !outcome.isPrivate)).resolves.toEqual({
      changed: ['notes/a.md'],
      skipped: 0,
    })
    expect(files.files().get('notes/a.md')).toBe('# A\n')
  })
})

describe('setNotesPrivate', () => {
  it('marks every listed note, skips ones already private, and undoes only its own changes', async () => {
    const { actions, files } = setup({
      files: {
        'notes/a.md': '# A\n',
        'notes/b.md': '---\nprivate: true\n---\n# B\n',
        'daily/2026-10-01.md': '- standup\n',
      },
    })

    const result = await actions.setNotesPrivate(
      ['notes/a.md', 'notes/b.md', 'daily/2026-10-01.md'],
      true,
    )

    expect(result).toEqual({ changed: ['notes/a.md', 'daily/2026-10-01.md'], skipped: 0 })
    expect(files.files().get('notes/a.md')).toContain('private: true')
    expect(files.files().get('daily/2026-10-01.md')).toContain('private: true')
    // Already private: its file keeps its bytes.
    expect(files.getWrites('notes/b.md')).toEqual([])

    await actions.setNotesPrivate(result.changed, false)
    expect(files.files().get('daily/2026-10-01.md')).toBe('- standup\n')
    expect(files.files().get('notes/a.md')).toBe('# A\n')
    expect(files.files().get('notes/b.md')).toBe('---\nprivate: true\n---\n# B\n')
  })

  it('counts unreadable, local-only and failed notes as skipped', async () => {
    const { actions, files, progress } = setup({
      files: {
        'notes/a.md': '---\nprivate: maybe\n---\n# A\n',
        'secure/b.md': '# B\n',
        'notes/c.md': '# C\n',
      },
      graph: { localOnlyFolders: ['secure'], localOnlyEditableFolders: ['secure'] },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          write: async (path, ...rest) => {
            if (path === 'notes/c.md') {
              throw new Error('disk full')
            }
            return await inner.write(path, ...rest)
          },
        }),
    })

    await expect(
      actions.setNotesPrivate(['notes/a.md', 'secure/b.md', 'notes/c.md'], true),
    ).resolves.toEqual({ changed: [], skipped: 3 })

    expect(files.writes()).toEqual([])
    expect(progress.snapshot()).toMatchObject([
      { label: 'Updating privacy', status: 'failed' },
      { label: 'Updating privacy', status: 'failed', message: 'disk full' },
    ])
  })

  it('skips a note whose privacy is being written right now', async () => {
    const gate = Promise.withResolvers<void>()
    const { actions, files } = setup({
      files: { 'notes/a.md': '# A\n' },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          write: async (...args) => {
            await gate.promise
            return await inner.write(...args)
          },
        }),
    })
    const toggle = actions.togglePrivate('notes/a.md')

    await expect(actions.setNotesPrivate(['notes/a.md'], false)).resolves.toEqual({
      changed: [],
      skipped: 1,
    })

    gate.resolve()
    await toggle
    expect(files.getWrites('notes/a.md')).toEqual(['---\nprivate: true\n---\n\n# A\n'])
  })

  it('writes nothing when no graph is open', async () => {
    const { actions, files, graph } = setup({ files: { 'notes/a.md': '# A\n' } })
    graph.setGraph(null)

    await expect(actions.setNotesPrivate(['notes/a.md'], true)).resolves.toEqual({
      changed: [],
      skipped: 1,
    })
    expect(files.writes()).toEqual([])
  })
})

describe('hasUnreadableLock', () => {
  const lockOf = (source: string): boolean =>
    hasUnreadableLock(parseNote({ path: 'notes/a.md', source }))

  it("freezes a locked note whose frontmatter can't be parsed", () => {
    expect(lockOf('---\nprivate: maybe\n---\n# A\n')).toBe(true)
    expect(lockOf('---\nprivate: true\ntitle: [unclosed\n---\n# A\n')).toBe(true)
  })

  it('leaves readable locks and unlocked notes alone, even with malformed YAML', () => {
    expect(lockOf('---\nprivate: true\n---\n# A\n')).toBe(false)
    // Not locked, so claiming "treated as locked" would be false.
    expect(lockOf('---\ntitle: [unclosed\n---\n# A\n')).toBe(false)
    expect(lockOf('# A\n')).toBe(false)
  })
})

/**
 * A session of a note with no file yet; `beforeWrite` runs before each write lands.
 */
function lazySession(
  files: NoteFileService,
  beforeWrite: () => Promise<void>,
): { readonly session: NoteSession; readonly snapshots: NoteSessionSnapshot[] } {
  const snapshots: NoteSessionSnapshot[] = []
  const noteFile = overrideNoteFileService(files, {
    write: async (...args) => {
      await beforeWrite()
      return await files.write(...args)
    },
  })
  const session = createNoteSessionService({
    noteFile,
    clock: createTestClockService(),
    logger: createTestLoggerService(),
    id: createTestIdService(),
    graphSession: createTestGraph(),
  }).create({
    path: 'notes/new.md',
    classify: () => 'exact',
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot)
    },
    applyContent: () => {},
    createIfMissing: true,
    missingSeed: '#\n',
    saveDebounceMs: 10,
  })
  return { session, snapshots }
}

describe('trash', () => {
  it('trashes a note with no open session and marks it trashed', async () => {
    const { actions, files, noteRows } = setup({ files: { 'notes/keep.md': '# Keep\n' } })

    await expect(actions.trash('notes/keep.md')).resolves.toEqual({
      succeeded: ['notes/keep.md'],
      failed: [],
      keptInGraph: [],
    })

    expect(files.trashed()).toEqual(['notes/keep.md'])
    expect(noteRows.getOverlay('notes/keep.md')).toEqual({ trashed: true })
  })

  it('says when the graph’s own trash kept a note the system Trash refused', async () => {
    const { actions } = setup({
      files: { 'secure/bank.md': '# Bank\n' },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          delete: async (path, generation) => {
            await inner.delete(path, generation)
            return { trashed: 'graph' }
          },
        }),
    })

    await expect(actions.trash('secure/bank.md')).resolves.toEqual({
      succeeded: ['secure/bank.md'],
      failed: [],
      keptInGraph: ['secure/bank.md'],
    })
  })

  it('trashes the file, then discards its open session so it cannot resurrect', async () => {
    const { actions, files, session } = setup({
      files: { 'notes/gone.md': '# Gone\n' },
      session: { path: 'notes/gone.md', content: '# Gone\n' },
    })
    const deleteFile = vi.spyOn(files, 'delete')

    await actions.trash('notes/gone.md')

    expect(deleteFile).toHaveBeenCalledWith('notes/gone.md', 3)
    // Discarded *after* the file is gone: otherwise a teardown flush could
    // re-create it.
    expect(session?.calls().map((call) => call.method)).toEqual(['prepareDelete', 'discard'])
  })

  it('discards a new note that has not reached disk without trashing a file', async () => {
    const { actions, files, session, noteRows } = setup({
      session: { path: 'notes/new.md', unpersisted: true },
    })
    const deleteFile = vi.spyOn(files, 'delete')

    await expect(actions.trash('notes/new.md')).resolves.toEqual({
      succeeded: ['notes/new.md'],
      failed: [],
      keptInGraph: [],
    })

    expect(deleteFile).not.toHaveBeenCalled()
    // The row leaves the list at once; the overlay retires when the index reports no row.
    expect(noteRows.getOverlay('notes/new.md')).toEqual({ trashed: true })
    expect(session?.getCalls('discard')).toHaveLength(1)
  })

  it('waits for a new note to load, then discards it without deleting a missing file', async () => {
    const files = createTestNoteFileService()
    const { session } = lazySession(files, async () => {})
    const { actions } = setupWith(files, session)
    const deleteFile = vi.spyOn(files, 'delete')
    const discard = vi.spyOn(session, 'discard')
    session.load()

    await actions.trash('notes/new.md')

    expect(deleteFile).not.toHaveBeenCalled()
    expect(discard).toHaveBeenCalledOnce()
  })

  it("waits for a new note's in-flight first write before deleting its file", async () => {
    const files = createTestNoteFileService()
    const writeStarted = Promise.withResolvers<void>()
    const allowWrite = Promise.withResolvers<void>()
    const { session, snapshots } = lazySession(files, async () => {
      writeStarted.resolve()
      await allowWrite.promise
    })
    const { actions } = setupWith(files, session)
    const deleteFile = vi.spyOn(files, 'delete')
    session.load()
    await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
    session.editorChanged('# Draft\n')
    const flush = session.flush()
    await writeStarted.promise

    const deletion = actions.trash('notes/new.md')
    await Promise.resolve()
    expect(deleteFile).not.toHaveBeenCalled()

    allowWrite.resolve()
    await Promise.all([flush, deletion])

    expect(deleteFile).toHaveBeenCalledWith('notes/new.md', 3)
    expect(files.trashed()).toEqual(['notes/new.md'])
    expect(files.files().has('notes/new.md')).toBe(false)
  })

  it('leaves the session intact and resumes persistence when the delete fails', async () => {
    const { actions, session, openDocuments, noteRows } = setup({
      session: { path: 'notes/gone.md', content: '# Gone\n' },
      wrapNoteFile: failing('delete', new Error('disk full')),
    })
    const sessionFor = vi.spyOn(openDocuments, 'sessionFor')

    const result = await actions.trash('notes/gone.md')

    expect(result.succeeded).toEqual([])
    expect(result.failed).toEqual([{ path: 'notes/gone.md', cause: new Error('disk full') }])
    // The session was never discarded: the screen stays editable.
    expect(session?.getCalls('discard')).toEqual([])
    expect(session?.getCalls('cancelDelete')).toHaveLength(1)
    expect(sessionFor).toHaveBeenCalledOnce()
    expect(noteRows.getOverlay('notes/gone.md')).toBeNull()
  })

  it('refuses a daily note and never touches disk or sessions', async () => {
    const { actions, files, openDocuments } = setup({ files: { 'daily/2026-06-15.md': '# Day\n' } })
    const sessionFor = vi.spyOn(openDocuments, 'sessionFor')

    const result = await actions.trash('daily/2026-06-15.md')

    expect(result.succeeded).toEqual([])
    expect(result.failed).toEqual([
      { path: 'daily/2026-06-15.md', cause: new Error('Daily notes cannot be deleted') },
    ])
    expect(files.trashed()).toEqual([])
    expect(sessionFor).not.toHaveBeenCalled()
  })

  it('shares the daily rule with `canTrash`', () => {
    const { actions } = setup()
    expect(actions.canTrash('daily/2026-06-15.md')).toBe(false)
    expect(actions.canTrash('notes/a.md')).toBe(true)
    expect(canTrashNote('daily/2026-06-15.md')).toBe(false)
  })
})

describe('trashOne', () => {
  it('moves the note to the trash and says which trash took it', async () => {
    const { actions, files } = setup({ files: { 'notes/keep.md': '# Keep\n' } })

    await expect(actions.trashOne('notes/keep.md')).resolves.toEqual({ trashed: 'system' })

    expect(files.trashed()).toEqual(['notes/keep.md'])
  })

  it('resolves null for a note with no file yet, which is only discarded', async () => {
    const { actions } = setup({ session: { path: 'notes/new.md', unpersisted: true } })

    await expect(actions.trashOne('notes/new.md')).resolves.toBeNull()
  })

  it('rejects with the cause when the note cannot be trashed', async () => {
    const { actions, files } = setup({ files: { 'daily/2026-06-15.md': '# Day\n' } })

    await expect(actions.trashOne('daily/2026-06-15.md')).rejects.toThrow(
      'Daily notes cannot be deleted',
    )

    expect(files.trashed()).toEqual([])
  })
})

function setupWith(files: NoteFileService, session: NoteSession) {
  const { actions } = createNoteActions({ noteFile: files, sessions: [session] })
  return { actions }
}

describe('trashMany', () => {
  it('is a no-op for no paths', async () => {
    const { actions, progress } = setup()

    await expect(actions.trashMany([])).resolves.toEqual({
      succeeded: [],
      failed: [],
      keptInGraph: [],
    })

    expect(progress.getAll()).toEqual([])
  })

  it('trashes every note in order under one operation', async () => {
    const { actions, files, progress, noteRows } = setup({
      files: { 'notes/a.md': '# A\n', 'notes/b.md': '# B\n' },
    })

    await expect(actions.trashMany(['notes/a.md', 'notes/b.md'])).resolves.toEqual({
      succeeded: ['notes/a.md', 'notes/b.md'],
      failed: [],
      keptInGraph: [],
    })

    expect(files.trashed()).toEqual(['notes/a.md', 'notes/b.md'])
    expect([...noteRows.getOverlays().keys()]).toEqual(['notes/a.md', 'notes/b.md'])
    expect(progress.started()).toMatchObject([{ label: 'Trashing notes', ended: true }])
    expect(progress.getAll()).toEqual([])
  })

  it('says when the system Trash refused notes and the graph’s trash kept them', async () => {
    const graphTrash = (inner: NoteFileService): NoteFileService =>
      overrideNoteFileService(inner, {
        delete: async (path, generation) => {
          const outcome = await inner.delete(path, generation)
          return path.startsWith('secure/') ? { trashed: 'graph' } : outcome
        },
      })
    const one = setup({
      files: { 'notes/a.md': '# A\n', 'secure/bank.md': '# Bank\n' },
      wrapNoteFile: graphTrash,
    })

    await expect(one.actions.trashMany(['notes/a.md', 'secure/bank.md'])).resolves.toEqual({
      succeeded: ['notes/a.md', 'secure/bank.md'],
      failed: [],
      keptInGraph: ['secure/bank.md'],
    })
    expect(one.progress.snapshot()).toMatchObject([
      { label: 'Trashing notes', status: 'warning', message: KEPT_IN_GRAPH_TRASH },
    ])

    const two = setup({
      files: { 'secure/a.md': '# A\n', 'secure/b.md': '# B\n' },
      wrapNoteFile: graphTrash,
    })
    await two.actions.trashMany(['secure/a.md', 'secure/b.md'])
    expect(two.progress.snapshot()).toMatchObject([
      {
        label: 'Trashing notes',
        status: 'warning',
        message: 'Moved to .reflect/trash in this graph: 2 notes',
      },
    ])
  })

  it('keeps going past a failure and fails the operation with the last error', async () => {
    const { actions, files, progress, noteRows } = setup({
      files: { 'notes/a.md': '# A\n', 'notes/b.md': '# B\n', 'notes/c.md': '# C\n' },
      wrapNoteFile: (inner) =>
        overrideNoteFileService(inner, {
          delete: async (path, generation) => {
            if (path === 'notes/b.md') {
              throw new Error('locked')
            }
            return await inner.delete(path, generation)
          },
        }),
    })
    const result = await actions.trashMany([
      'notes/a.md',
      'notes/b.md',
      'daily/2026-06-15.md',
      'notes/c.md',
    ])

    expect(result.succeeded).toEqual(['notes/a.md', 'notes/c.md'])
    expect(result.failed.map((failure) => failure.path)).toEqual([
      'notes/b.md',
      'daily/2026-06-15.md',
    ])
    expect(files.trashed()).toEqual(['notes/a.md', 'notes/c.md'])
    // A note that failed stays listed.
    expect([...noteRows.getOverlays().keys()]).toEqual(['notes/a.md', 'notes/c.md'])
    expect(progress.snapshot()).toMatchObject([
      { label: 'Trashing notes', status: 'failed', message: 'Daily notes cannot be deleted' },
    ])
  })
})

describe('deepLinkFor', () => {
  it('addresses a daily note by date, touching nothing', async () => {
    const { actions, files } = setup()

    await expect(actions.deepLinkFor('daily/2026-07-01.md')).resolves.toBe(
      'reflect://daily/2026-07-01',
    )

    expect(files.getReads()).toEqual([])
    expect(files.writes()).toEqual([])
  })

  it('addresses an impossible-date daily file like a plain note (mints an id)', async () => {
    // The router opens daily/2026-02-31.md as a plain note; a date-form link
    // would be one the parser rejects.
    const { actions, files } = setup({ files: { 'daily/2026-02-31.md': '# Not a real day\n' } })

    const url = await actions.deepLinkFor('daily/2026-02-31.md')

    expect(url.startsWith('reflect://note/')).toBe(true)
    expect(files.writes()).toHaveLength(1)
  })

  it('uses the existing frontmatter id without writing or reindexing', async () => {
    const { actions, files } = setup({
      files: { 'notes/a.md': '---\nid: 01hzy3v9k2m4n6p8q0r2s4t6vw\n---\n# A\n' },
    })

    await expect(actions.deepLinkFor('notes/a.md')).resolves.toBe(
      'reflect://note/01hzy3v9k2m4n6p8q0r2s4t6vw',
    )

    expect(files.writes()).toEqual([])
    expect(actions.indexed()).toEqual([])
  })

  it('treats a blank frontmatter id as absent and mints a real one', async () => {
    const { actions, files } = setup({ files: { 'notes/a.md': '---\nid: ""\n---\n# A\n' } })

    const url = await actions.deepLinkFor('notes/a.md')

    expect(url.replace('reflect://note/', '')).toMatch(ULID_RE)
    expect(files.writes()).toHaveLength(1)
  })

  it('mints a ULID id on first use, lands it on disk, and indexes it immediately', async () => {
    const { actions, files } = setup({ files: { 'notes/a.md': '# A\n' } })

    const url = await actions.deepLinkFor('notes/a.md')

    const id = url.replace('reflect://note/', '')
    expect(id).toMatch(ULID_RE)
    expect(files.writes()).toMatchObject([{ path: 'notes/a.md', generation: 3 }])
    const source = files.files().get('notes/a.md') ?? ''
    expect(parseNote({ path: 'notes/a.md', source }).frontmatter.id).toBe(id)
    expect(source.endsWith('---\n\n# A\n')).toBe(true)
    // The index trails local writes by a watcher debounce; without this the
    // just-copied link answers "Note not found" until the reindex.
    expect(actions.indexed()).toEqual([{ path: 'notes/a.md', generation: 8 }])
  })

  it('skips the immediate reindex when the index failed to open', async () => {
    const { actions, files, graph } = setup({ files: { 'notes/a.md': '# A\n' } })
    graph.setGraph({ root: '/g', generation: 3, indexGeneration: null })

    const url = await actions.deepLinkFor('notes/a.md')

    expect(url.startsWith('reflect://note/')).toBe(true)
    expect(files.writes()).toMatchObject([{ path: 'notes/a.md', generation: 3 }])
    expect(actions.indexed()).toEqual([])
  })

  it('still returns the link when the immediate reindex fails', async () => {
    const { actions } = setup({
      files: { 'notes/a.md': '# A\n' },
      indexNote: () => Promise.reject(new Error('index busy')),
    })

    const url = await actions.deepLinkFor('notes/a.md')

    expect(url.startsWith('reflect://note/')).toBe(true)
  })

  it('mints through the live session when one owns the note', async () => {
    const { actions, files, session } = setup({ session: { path: 'notes/a.md', content: '# A\n' } })

    const url = await actions.deepLinkFor('notes/a.md')

    const id = url.replace('reflect://note/', '')
    expect(session?.getCalls('commitFrontmatter')).toEqual([[{ id }]])
    expect(files.writes()).toEqual([])
  })
})

describe('absolutePathFor', () => {
  it('joins the graph root and the path in the host syntax', async () => {
    const { actions } = setup()

    await expect(actions.absolutePathFor('notes/a.md')).resolves.toBe('/g/notes/a.md')
  })

  it('rejects when no graph is open', async () => {
    const { actions, graph } = setup()
    graph.setGraph(null)

    await expect(actions.absolutePathFor('notes/a.md')).rejects.toThrow('No graph is open.')
  })
})

describe('with no graph open', () => {
  it('fails the toggles without a report and writes nothing', async () => {
    const { actions, files, progress, graph } = setup({ files: { 'notes/a.md': '# A\n' } })
    graph.setGraph(null)

    await expect(actions.togglePinned('notes/a.md')).resolves.toEqual({ status: 'failed' })
    await expect(actions.unpin('notes/a.md')).resolves.toEqual({ status: 'failed' })
    await expect(actions.togglePrivate('notes/a.md')).resolves.toEqual({ status: 'failed' })
    await expect(
      actions.reorderPinned([{ path: 'notes/a.md', pinnedOrder: 1024 }]),
    ).resolves.toEqual([])

    expect(files.writes()).toEqual([])
    expect(progress.getAll()).toEqual([])
  })

  it('rejects a trash and fails a batch trash with the reason', async () => {
    const { actions, files, progress, graph } = setup({ files: { 'notes/a.md': '# A\n' } })
    graph.setGraph(null)

    await expect(actions.trashOne('notes/a.md')).rejects.toThrow('No graph is open.')
    const result = await actions.trashMany(['notes/a.md'])

    expect(result.succeeded).toEqual([])
    expect(result.failed.map((failure) => failure.path)).toEqual(['notes/a.md'])
    expect(files.trashed()).toEqual([])
    expect(progress.snapshot()).toMatchObject([
      { label: 'Trashing notes', status: 'failed', message: 'No graph is open.' },
    ])
  })
})
