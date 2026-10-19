import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestClockService } from '../testing/clock.ts'
import { createTestNoteSession } from '../testing/documents.ts'
import { createTestFileChangeService } from '../testing/file-change.ts'
import { createTestNoteFileService } from '../testing/graph.ts'
import { createTestGraphSessionService } from '../testing/graph-session.ts'
import { createTestIdService } from '../testing/id.ts'
import { createTestLoggerService } from '../testing/logger.ts'
import {
  createDocumentBinding,
  type BindFactories,
  type DocumentBinding,
  type DocumentCoordinator,
} from './document-binding.ts'
import {
  createNoteSessionService,
  type NoteSession,
  type NoteSessionSnapshot,
} from './note-session-service.ts'
import { createOpenDocumentsService, type OpenDocumentsService } from './open-documents-service.ts'

/**
 * The create/adopt/teardown/hand-off protocol, driven directly — the React
 * hook is a thin adapter over this. The hand-off cases mirror what a rename
 * does at runtime: retarget the live session, then either an adopting bind
 * lands (the route followed) or none does (the pane unmounted).
 */

function fakeSession(path: string) {
  const session = createTestNoteSession({ path })
  const flush = vi.spyOn(session, 'flush')
  const dispose = vi.spyOn(session, 'dispose')
  return { session, flush, dispose }
}

function fakeCoordinator() {
  const settle = vi.fn()
  const dispose = vi.fn()
  const coordinator: DocumentCoordinator = {
    settle,
    settled: () => {},
    dispose,
  }
  return { coordinator, settle, dispose }
}

function factories(session: NoteSession, coordinator: DocumentCoordinator | null): BindFactories {
  return { session: () => session, coordinator: () => coordinator }
}

let openDocuments: OpenDocumentsService

beforeEach(() => {
  openDocuments = createOpenDocumentsService({ fileChanges: createTestFileChangeService() })
})

function createBinding(): DocumentBinding {
  return createDocumentBinding({ openDocuments })
}

const microtasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('createDocumentBinding', () => {
  it('creates on first bind, registers, and counts the epoch', () => {
    const binding = createBinding()
    const { session } = fakeSession('notes/a.md')
    const bound = binding.bind('notes/a.md', factories(session, null))

    expect(bound.created).toBe(true)
    expect(binding.session()).toBe(session)
    expect(binding.epoch()).toBe(1)
    expect(openDocuments.sessionFor('notes/a.md')).toBe(session)
    binding.unbind('notes/a.md')
    expect(openDocuments.sessionFor('notes/a.md')).toBeNull()
  })

  it('a same-path rebind recreates (io bindings are taken at construction)', () => {
    const binding = createBinding()
    const first = fakeSession('notes/a.md')
    binding.bind('notes/a.md', factories(first.session, null))
    binding.unbind('notes/a.md')
    expect(first.dispose).toHaveBeenCalled()

    const second = fakeSession('notes/a.md')
    const rebound = binding.bind('notes/a.md', factories(second.session, null))
    expect(rebound.created).toBe(true)
    expect(rebound.session).toBe(second.session)
    expect(binding.epoch()).toBe(2)
    binding.unbind('notes/a.md')
  })

  it('adopts a retargeted session when the next bind lands on its new path', async () => {
    const binding = createBinding()
    const moved = fakeSession('notes/a.md')
    const { coordinator } = fakeCoordinator()
    binding.bind('notes/a.md', factories(moved.session, coordinator))

    moved.session.retarget('notes/renamed.md') // what moveNoteCarryingSession does
    binding.unbind('notes/a.md') // route follows → React cleanup for the old path
    const spare = fakeSession('notes/renamed.md')
    const adopted = binding.bind('notes/renamed.md', factories(spare.session, null))

    expect(adopted.created).toBe(false)
    expect(adopted.session).toBe(moved.session)
    expect(adopted.coordinator).toBe(coordinator)
    expect(binding.epoch()).toBe(1) // no remount: the editor keeps its cursor
    await microtasks()
    expect(moved.dispose).not.toHaveBeenCalled() // the hand-off cancelled teardown

    binding.unbind('notes/renamed.md')
    expect(moved.dispose).toHaveBeenCalled()
  })

  it('tears a retargeted session down when nothing adopts it (real unmount)', async () => {
    const binding = createBinding()
    const moved = fakeSession('notes/a.md')
    const { coordinator, settle } = fakeCoordinator()
    binding.bind('notes/a.md', factories(moved.session, coordinator))

    moved.session.retarget('notes/renamed.md')
    binding.unbind('notes/a.md') // unmount: no bind follows
    expect(moved.dispose).not.toHaveBeenCalled() // deferred — not torn down inline

    await microtasks()
    expect(moved.dispose).toHaveBeenCalled()
    expect(moved.flush).toHaveBeenCalled()
    expect(settle).toHaveBeenCalled() // a pending rename still settles
  })

  it('holds the note a render shows: its bound path, or a rename target being followed', () => {
    const binding = createBinding()
    expect(binding.holds('notes/a.md')).toBe(false) // nothing bound yet

    const moved = fakeSession('notes/a.md')
    binding.bind('notes/a.md', factories(moved.session, null))
    expect(binding.holds('notes/a.md')).toBe(true)
    // A pane that navigated renders once before its effect rebinds: the live
    // session is still the previous note's.
    expect(binding.holds('notes/b.md')).toBe(false)

    // A rename retargets the session before the route follows: both the old
    // route path and the new one show this same note.
    moved.session.retarget('notes/renamed.md')
    expect(binding.holds('notes/a.md')).toBe(true)
    expect(binding.holds('notes/renamed.md')).toBe(true)
    expect(binding.holds('notes/b.md')).toBe(false)

    binding.unbind('notes/a.md')
    binding.bind('notes/renamed.md', factories(fakeSession('notes/renamed.md').session, null))
    expect(binding.holds('notes/renamed.md')).toBe(true)
    expect(binding.holds('notes/a.md')).toBe(false)

    binding.unbind('notes/renamed.md')
    expect(binding.holds('notes/renamed.md')).toBe(false) // torn down
  })

  it('a normal unbind settles the coordinator after the final flush', async () => {
    const binding = createBinding()
    const { session, dispose } = fakeSession('notes/a.md')
    const { coordinator, settle } = fakeCoordinator()
    binding.bind('notes/a.md', factories(session, coordinator))

    binding.unbind('notes/a.md')
    expect(dispose).toHaveBeenCalled()
    await microtasks()
    expect(settle).toHaveBeenCalledTimes(1)
  })

  it('a displaced session handed off flushes to the copy, never to the old path', async () => {
    const from = 'daily/2026-10-04.md'
    const to = 'daily/2026-10-04 (this device).md'
    // The double refuses a write whose expected bytes the file no longer holds.
    const noteFile = createTestNoteFileService({ files: { [from]: '# Today\n' } })
    const snapshots: NoteSessionSnapshot[] = []
    const session = createNoteSessionService({
      noteFile,
      clock: createTestClockService(), // the debounced save never fires on its own
      logger: createTestLoggerService(),
      graphSession: createTestGraphSessionService({ graph: { generation: 1 } }),
      id: createTestIdService(),
    }).create({
      path: from,
      classify: () => 'exact',
      onSnapshot: (snapshot) => {
        snapshots.push(snapshot)
      },
      applyContent: () => {},
    })
    const binding = createBinding()
    binding.bind(from, factories(session, null))
    session.load()
    await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe('ready'))
    session.editorChanged('# Today\n\nunsaved\n')

    // The pull: this device's bytes move to the copy, the phone's take `from`.
    noteFile.set(to, '# Today\n')
    noteFile.set(from, '# From the phone\n')
    expect(session.followDisplacement(to, '# From the phone\n', false)).toBe(true)
    binding.unbind(from) // the pane unmounts before any adopting bind

    await vi.waitFor(() => expect(noteFile.writes().map((write) => write.path)).toEqual([to]))
    expect(noteFile.files().get(to)).toBe('# Today\n\nunsaved\n')
    expect(noteFile.files().get(from)).toBe('# From the phone\n')
  })
})
