import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReflectError } from '../errors.ts'
import { createTestClockService, type TestClockService } from '../testing/clock.ts'
import { createTestGitRepositoryService, type TestGitRepositoryService } from '../testing/sync.ts'
import {
  createSyncEngineFactory,
  isSyncError,
  type SyncEngine,
  type SyncEngineOptions,
  type SyncStatus,
} from './engine.ts'
import type {
  CommitOutcome,
  DisplacedFile,
  MergeOutcome,
  PushOutcome,
  RemoteDelta,
  SkippedFile,
} from './git-repository-service.ts'

let clock: TestClockService
let activeGit: TestGitRepositoryService

beforeEach(() => {
  clock = createTestClockService()
  activeGit = createTestGitRepositoryService()
})

/**
 * An engine over the git fake of the last {@link fakeGit} call and the test clock.
 */
function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  return createSyncEngineFactory({ git: activeGit, clock }).create(options)
}

/**
 * Let every promise chain that is already runnable settle.
 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Move the clock by `ms`, running the timers that come due, then settle.
 */
async function advance(ms: number): Promise<void> {
  await clock.advance(ms)
  await flush()
}

/**
 * Run every scheduled timer, however far away, then settle.
 */
async function runAllTimers(): Promise<void> {
  await flush()
  while (clock.pendingTimers() > 0) {
    await clock.advance(60_000)
    await flush()
  }
}

const CRED = { username: 'x-access-token', secret: 'tok' }
const CLEAN_COMMIT: CommitOutcome = { committed: false, sha: null, ahead: 0, skippedLargeFiles: [] }
const COMMITTED: CommitOutcome = { committed: true, sha: 'abc', ahead: 1, skippedLargeFiles: [] }
const PUSHED: PushOutcome = { pushed: true, nonFastForward: false, rejectionMessage: null }
const NON_FAST_FORWARD: PushOutcome = {
  pushed: false,
  nonFastForward: true,
  rejectionMessage: 'fetch first',
}
const MERGED: MergeOutcome = {
  kind: 'merged',
  conflictedPaths: [],
  changedFiles: [],
  frozenPaths: [],
  displaced: [],
}
const DEFERRED: MergeOutcome = { ...MERGED, kind: 'deferred' }
const DELTA = { ahead: 1, behind: 0 }

/**
 * A git fake that commits, reports a delta, merges and pushes; every call recorded.
 */
function fakeGit(): TestGitRepositoryService {
  const git = createTestGitRepositoryService()
  git.onCommitAll(() => COMMITTED)
  git.onFetch(() => DELTA)
  git.onMergeRemote(() => MERGED)
  activeGit = git
  return git
}

function methodsOf(git: TestGitRepositoryService): string[] {
  return git.calls().map((call) => call.method)
}

describe('createSyncEngineFactory', () => {
  it('debounces edits into one commit→push cycle pinned to the generation', async () => {
    const git = fakeGit()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 7,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 100,
      maxWaitMs: 1000,
    })

    engine.noteChanged()
    engine.noteChanged() // coalesces into the same cycle
    await advance(99)
    expect(git.calls()).toHaveLength(0)
    await advance(1)
    await runAllTimers()

    expect(git.calls()).toEqual([
      { method: 'commitAll', args: ['Update notes', 7] },
      { method: 'push', args: [CRED, 7] },
    ])
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('keeps deferring while edits continue, but never past maxWaitMs', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => null,
      idleMs: 100,
      maxWaitMs: 250,
    })

    // An edit every 80ms keeps resetting the idle window…
    engine.noteChanged()
    await advance(80)
    engine.noteChanged()
    await advance(80)
    engine.noteChanged()
    expect(git.calls()).toHaveLength(0)
    // …but the 250ms ceiling forces the cycle anyway.
    await advance(100)
    await runAllTimers()
    expect(methodsOf(git)).toContain('commitAll')
    engine.stop()
  })

  it('recovers from a non-fast-forward push by fetch+merge+retry', async () => {
    let pushes = 0
    const git = fakeGit()
    git.onPush(() => {
      pushes += 1
      return pushes === 1 ? NON_FAST_FORWARD : PUSHED
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(methodsOf(git)).toEqual([
      'commitAll',
      'push',
      'fetch',
      'commitAll',
      'mergeRemote',
      'push',
    ])
    expect(statuses.at(-1)?.state).toBe('idle')
    engine.stop()
  })

  it('maps a thrown ReflectError from token refresh to offline / auth states', async () => {
    // getGithubToken throws ReflectError (an Error subclass) for transient
    // refresh failures — the engine must read it like any AppError, or the
    // offline/auth UX silently degrades to a generic error.
    for (const [kind, expected] of [
      ['network', { state: 'offline' }],
      ['auth', { state: 'error', errorKind: 'auth' }],
    ] as const) {
      fakeGit()
      const statuses: SyncStatus[] = []
      const engine = createSyncEngine({
        generation: 1,
        getCredential: async () => {
          throw new ReflectError(kind, 'refresh failed')
        },
        onStatus: (status) => {
          statuses.push(status)
        },
        idleMs: 10,
      })
      engine.noteChanged()
      await runAllTimers()
      expect(statuses.at(-1)).toMatchObject(expected)
      engine.stop()
    }
  })

  it('maps a network failure to the offline state', async () => {
    const git = fakeGit()
    git.onPush(() => {
      throw { kind: 'network', message: 'could not resolve github.com' }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(statuses.at(-1)?.state).toBe('offline')
    engine.stop()
  })

  it('maps an auth failure to an auth error state', async () => {
    const git = fakeGit()
    git.onPush(() => {
      throw { kind: 'auth', message: 'token rejected' }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    engine.stop()
  })

  it('commitNow joins the single-flight queue and never touches the network', async () => {
    const gate: { release: () => void } = { release: () => {} }
    const git = fakeGit()
    git.onMergeRemote(() => {
      return new Promise((resolve) => {
        gate.release = () => resolve(MERGED)
      })
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    const full = engine.syncNow()
    await vi.waitFor(() => expect(methodsOf(git)).toContain('mergeRemote'))
    const flushed = engine.commitNow()
    await Promise.resolve()
    // The pull is mid-merge (a full cycle commits before its fetch and again
    // before its merge): the flush commit waits instead of interleaving.
    expect(methodsOf(git).filter((method) => method === 'commitAll')).toHaveLength(2)

    gate.release()
    await full
    await flushed
    const commands = methodsOf(git)
    expect(commands.filter((method) => method === 'commitAll')).toHaveLength(3)
    expect(commands.lastIndexOf('commitAll')).toBeGreaterThan(commands.indexOf('push'))
    engine.stop()
  })

  it('a flush queued behind a sync still commits when the app hides meanwhile', async () => {
    // Visible: a sync is mid-merge and another syncNow queues a full
    // follow-up. The app goes to the background and the flush joins that
    // follow-up. The gate must not swallow the commit the flush is owed.
    const gate: { release: () => void } = { release: () => {} }
    const git = fakeGit()
    git.onMergeRemote(() => {
      return new Promise((resolve) => {
        gate.release = () => resolve(MERGED)
      })
    })
    let canStartCycle = true
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      canStartCycle: () => canStartCycle,
    })
    const first = engine.syncNow()
    await vi.waitFor(() => expect(methodsOf(git)).toContain('mergeRemote'))
    const second = engine.syncNow()
    canStartCycle = false
    const flushed = engine.commitNow()
    gate.release()
    await first
    await flushed
    await second
    const commands = methodsOf(git)
    // The running sync stopped at the gate after its merge, and the queued
    // full follow-up ran as the commit the flush was owed: no push, and the
    // sync's two commits (before its fetch and its merge) plus the flush's.
    expect(commands.filter((method) => method === 'push')).toHaveLength(0)
    expect(commands.filter((method) => method === 'commitAll')).toHaveLength(3)
    expect(commands.lastIndexOf('commitAll')).toBeGreaterThan(commands.indexOf('mergeRemote'))
    engine.stop()
  })

  it('a queued flush commits before the follow-up resolves its credential', async () => {
    // The follow-up starts visible, so it runs as a full sync; the app hides
    // while the credential is being resolved. The commit has already landed.
    const gate: { release: () => void } = { release: () => {} }
    const git = fakeGit()
    git.onMergeRemote(() => {
      return new Promise((resolve) => {
        gate.release = () => resolve(MERGED)
      })
    })
    const credentialGate = Promise.withResolvers<void>()
    let credentials = 0
    let canStartCycle = true
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => {
        credentials += 1
        if (credentials === 2) {
          await credentialGate.promise
        }
        return CRED
      },
      canStartCycle: () => canStartCycle,
    })
    const first = engine.syncNow()
    await vi.waitFor(() => expect(methodsOf(git)).toContain('mergeRemote'))
    const second = engine.syncNow()
    const flushed = engine.commitNow()
    gate.release()
    await first
    // The follow-up is running: its commit landed before it asked for a credential
    // (after the first sync's commits before its fetch and its merge).
    await vi.waitFor(() => expect(credentials).toBe(2))
    expect(methodsOf(git).filter((method) => method === 'commitAll')).toHaveLength(3)
    canStartCycle = false
    credentialGate.resolve()
    await flushed
    await second
    expect(methodsOf(git).filter((method) => method === 'push')).toHaveLength(1) // the first sync only
    engine.stop()
  })

  it('requests queued behind a running cycle merge into one follow-up that does their union', async () => {
    const gate: { release: () => void } = { release: () => {} }
    const git = fakeGit()
    git.onMergeRemote(() => {
      return new Promise((resolve) => {
        gate.release = () => resolve(MERGED)
      })
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })
    const first = engine.syncNow()
    await vi.waitFor(() => expect(methodsOf(git)).toContain('mergeRemote'))
    engine.noteChanged() // the debounce asks for a push
    await advance(10)
    const flushed = engine.commitNow() // the flush asks for a commit
    gate.release()
    await first
    await flushed
    // One follow-up: its commit, then the push the debounce asked for; no
    // fetch, because nobody asked to pull.
    expect(methodsOf(git)).toEqual([
      'commitAll',
      'fetch',
      'commitAll',
      'mergeRemote',
      'push',
      'commitAll',
      'push',
    ])
    engine.stop()
  })

  it('commitNow runs even when the owner gates cycles (the hidden-app flush)', async () => {
    // iOS fires the background flush after the document is hidden, exactly
    // when canStartCycle says no to network cycles.
    const git = fakeGit()
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      canStartCycle: () => false,
    })
    await engine.commitNow()
    expect(methodsOf(git)).toEqual(['commitAll'])
    await engine.syncNow()
    expect(methodsOf(git)).toEqual(['commitAll']) // still gated
    engine.stop()
  })

  it('after an auth failure, edits commit locally and skip the network until a resume', async () => {
    // A rejected sign-in (or an ssh agent with no key) does not fix itself
    // between keystrokes: per-edit retries would only repeat the error and
    // the reconnect prompt. Local history keeps accumulating meanwhile.
    let pushes = 0
    const git = fakeGit()
    git.onPush(() => {
      pushes += 1
      throw { kind: 'auth', message: 'token rejected' }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()
    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    const emitted = statuses.length

    engine.noteChanged()
    await runAllTimers()
    expect(methodsOf(git).filter((method) => method === 'commitAll')).toHaveLength(2)
    expect(pushes).toBe(1)
    expect(statuses).toHaveLength(emitted) // the auth error stays on screen

    await engine.syncNow() // focus / online / manual: try the network again
    expect(pushes).toBe(2)
    engine.stop()
  })

  it('surfaces a non-divergence rejection (e.g. push protection) as an error', async () => {
    const git = fakeGit()
    git.onPush(() => {
      return {
        pushed: false,
        nonFastForward: false,
        rejectionMessage: 'GH013: secret detected in notes/keys.md',
      }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    const last = statuses.at(-1)
    if (last === undefined || !isSyncError(last)) {
      throw new Error(`expected an error status, got ${JSON.stringify(last)}`)
    }
    expect(last.errorKind).toBe('rejected')
    expect(last.message).toContain('GH013')
    engine.stop()
  })

  it('gives up after repeated non-fast-forward rounds instead of looping forever', async () => {
    const git = fakeGit()
    git.onPush(() => {
      return NON_FAST_FORWARD
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(git.calls().filter((call) => call.method === 'push')).toHaveLength(3)
    expect(statuses.at(-1)?.state).toBe('error')
    engine.stop()
  })

  it('shows a paused pull once and neither pushes nor retries on its own', async () => {
    // Rust pauses a pull that would join a history the graph has not accepted.
    const paused =
      'Sync paused: the backup’s history starts from a commit this graph has not accepted.'
    const git = fakeGit()
    git.onMergeRemote(() => {
      throw new ReflectError('io', paused)
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
    })

    await engine.syncNow()
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote'])
    expect(statuses).toEqual([
      { state: 'syncing' },
      { state: 'error', errorKind: 'other', message: paused },
    ])
    engine.stop()
  })

  it('shows a push the backend refuses to send once, without the pull-and-retry loop', async () => {
    // Rust refuses to upload a history the graph has not accepted, as data.
    const refused =
      'Sync paused: this graph’s history starts from a commit the backup does not have.'
    const git = fakeGit()
    git.onPush(() => ({ pushed: false, nonFastForward: false, rejectionMessage: refused }))
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll', 'push'])
    expect(statuses).toEqual([
      { state: 'syncing' },
      { state: 'error', errorKind: 'rejected', message: refused },
    ])
    engine.stop()
  })

  it('shows the pull’s pause when a debounced push against a separate history must pull first', async () => {
    // Rust reports a push that shares no history with the backup as
    // non-fast-forward before uploading anything, so the edit's push-only
    // cycle pulls, and the pull's pause (not a push refusal) is what shows.
    const paused =
      'Sync paused: the backup brings in history that starts from a commit this graph has not accepted.'
    const git = fakeGit()
    git.onPush(() => NON_FAST_FORWARD)
    git.onMergeRemote(() => {
      throw new ReflectError('io', paused)
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll', 'push', 'fetch', 'commitAll', 'mergeRemote'])
    expect(statuses).toEqual([
      { state: 'syncing' },
      { state: 'error', errorKind: 'other', message: paused },
    ])
    engine.stop()
  })

  it('preserves the full-cycle mode when syncNow lands mid-cycle', async () => {
    const pushGate: { resolve: ((value: PushOutcome) => void) | null } = { resolve: null }
    const git = fakeGit()
    git.onPush(() => {
      if (pushGate.resolve === null) {
        return new Promise((resolve) => {
          pushGate.resolve = resolve
        })
      }
      return PUSHED
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })

    engine.noteChanged()
    await advance(10)
    expect(methodsOf(git)).toEqual(['commitAll', 'push'])

    // A focus/manual sync arrives mid-cycle: its fetch+merge must not be
    // downgraded to a push-only follow-up.
    void engine.syncNow()
    pushGate.resolve?.(PUSHED)
    await runAllTimers()

    expect(methodsOf(git)).toEqual([
      'commitAll',
      'push',
      'commitAll',
      'fetch',
      'commitAll',
      'mergeRemote',
      'push',
    ])
    engine.stop()
  })

  it('hands merge-changed files to the reindex callback', async () => {
    const git = fakeGit()
    git.onMergeRemote(() => ({
      kind: 'merged',
      conflictedPaths: [],
      changedFiles: [
        { path: 'notes/from-b.md', kind: 'upsert' },
        { path: 'notes/gone.md', kind: 'remove' },
      ],
      frozenPaths: [],
      displaced: [],
    }))
    const batches: Array<Array<{ path: string }>> = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onRemoteChanges: (changes) => {
        batches.push(changes)
      },
    })

    await engine.syncNow()

    expect(batches).toEqual([
      [
        { path: 'notes/from-b.md', kind: 'upsert' },
        { path: 'notes/gone.md', kind: 'remove' },
      ],
    ])
    engine.stop()
  })

  it('continues through push while remote-change handling runs, then waits before idle', async () => {
    const git = fakeGit()
    git.onMergeRemote(() => ({
      kind: 'merged',
      conflictedPaths: [],
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
      frozenPaths: [],
      displaced: [],
    }))
    const remoteChangesGate = Promise.withResolvers<void>()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: () => remoteChangesGate.promise,
    })

    const syncing = engine.syncNow()
    await advance(0)

    // The projection is still gated, but the merge's Markdown has already
    // continued through the durable Git push. Only the idle boundary waits.
    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    remoteChangesGate.resolve()
    await syncing

    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('starts every remote-change callback immediately while repeated Git convergence continues', async () => {
    let mergeCount = 0
    let pushCount = 0
    const git = fakeGit()
    git.onMergeRemote(() => {
      mergeCount += 1
      return {
        kind: 'merged',
        conflictedPaths: [],
        changedFiles: [{ path: `notes/remote-${mergeCount}.md`, kind: 'upsert' }],
        frozenPaths: [],
        displaced: [],
      }
    })
    git.onPush(() => {
      pushCount += 1
      return pushCount === 1 ? NON_FAST_FORWARD : PUSHED
    })
    const firstBatchGate = Promise.withResolvers<void>()
    const started: string[] = []
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: (changes) => {
        started.push(changes[0]!.path)
        if (started.length === 1) {
          return firstBatchGate.promise
        }
      },
    })

    const syncing = engine.syncNow()
    await advance(0)

    expect(methodsOf(git)).toEqual([
      'commitAll',
      'fetch',
      'commitAll',
      'mergeRemote',
      'push',
      'fetch',
      'commitAll',
      'mergeRemote',
      'push',
    ])
    // Both merges notify synchronously even though the first returned task is
    // still gated. Their async work can overlap; only idle waits for both.
    expect(started).toEqual(['notes/remote-1.md', 'notes/remote-2.md'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    firstBatchGate.resolve()
    await syncing

    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('finishes async remote-change handling before applying a suppression gate', async () => {
    const git = fakeGit()
    git.onMergeRemote(() => ({
      kind: 'merged',
      conflictedPaths: [],
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
      frozenPaths: [],
      displaced: [],
    }))
    const remoteChangesGate = Promise.withResolvers<void>()
    const statuses: SyncStatus[] = []
    let canStartCycle = true
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      canStartCycle: () => canStartCycle,
      onRemoteChanges: () => remoteChangesGate.promise,
    })

    const syncing = engine.syncNow()
    await advance(0)
    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote', 'push'])

    canStartCycle = false
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
    remoteChangesGate.resolve()
    await syncing

    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('surfaces an async remote-change failure only after the push finishes', async () => {
    const pushGate = Promise.withResolvers<PushOutcome>()
    const git = fakeGit()
    git.onMergeRemote(() => {
      return {
        kind: 'merged',
        conflictedPaths: [],
        changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
        frozenPaths: [],
        displaced: [],
      }
    })
    git.onPush(() => {
      return pushGate.promise
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: async () => {
        throw new Error('remote index failed')
      },
    })

    const syncing = engine.syncNow()
    await advance(0)

    // The projection has already rejected, but that failure must not strand
    // the merged Markdown before its required push.
    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    pushGate.resolve(PUSHED)
    await syncing

    expect(statuses.at(-1)).toMatchObject({
      state: 'error',
      errorKind: 'other',
      message: 'remote index failed',
    })
    engine.stop()
  })

  it('stop while merge is in flight never starts its remote-change callback', async () => {
    const mergeGate = Promise.withResolvers<MergeOutcome>()
    const git = fakeGit()
    git.onMergeRemote(() => {
      return mergeGate.promise
    })
    const remoteChanges = vi.fn()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: remoteChanges,
    })

    const syncing = engine.syncNow()
    await advance(0)
    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote'])

    engine.stop()
    mergeGate.resolve({
      kind: 'merged',
      conflictedPaths: [],
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
      frozenPaths: [],
      displaced: [],
    })
    await syncing

    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote'])
    expect(remoteChanges).not.toHaveBeenCalled()
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('stop after a remote-change task starts emits no later status or Git work', async () => {
    const git = fakeGit()
    git.onMergeRemote(() => ({
      kind: 'merged',
      conflictedPaths: [],
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
      frozenPaths: [],
      displaced: [],
    }))
    const remoteChangesGate = Promise.withResolvers<void>()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: () => remoteChangesGate.promise,
    })

    const syncing = engine.syncNow()
    await advance(0)
    const commandsBeforeStop = methodsOf(git)
    expect(commandsBeforeStop).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])

    engine.stop()
    remoteChangesGate.resolve()
    await syncing

    expect(methodsOf(git)).toEqual(commandsBeforeStop)
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('stop from a synchronous remote-change callback prevents the later push', async () => {
    const git = fakeGit()
    git.onMergeRemote(() => ({
      kind: 'merged',
      conflictedPaths: [],
      changedFiles: [{ path: 'notes/from-remote.md', kind: 'upsert' }],
      frozenPaths: [],
      displaced: [],
    }))
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      onRemoteChanges: () => engine.stop(),
    })

    await engine.syncNow()

    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('syncNow pulls and merges even with nothing to push (launch/focus)', async () => {
    const git = fakeGit()
    git.onCommitAll(() => CLEAN_COMMIT)
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    await engine.syncNow()

    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote', 'push'])
    engine.stop()
  })

  it('reports files withheld by the size guardrail', async () => {
    const git = fakeGit()
    git.onCommitAll(() => ({
      committed: true,
      sha: 'abc',
      ahead: 1,
      skippedLargeFiles: [{ path: 'assets/movie.mp4', size: 200_000_000 }],
    }))
    const skipped: Array<{ path: string }[]> = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onLargeFilesSkipped: (files) => {
        skipped.push(files)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    expect(skipped).toEqual([[{ path: 'assets/movie.mp4', size: 200_000_000 }]])
    engine.stop()
  })

  it('reports remote changes a pull left frozen in local-only folders', async () => {
    const git = fakeGit()
    git.onMergeRemote(() => ({
      kind: 'fastForward',
      conflictedPaths: [],
      changedFiles: [{ path: 'notes/a.md', kind: 'upsert' }],
      frozenPaths: ['finance/secure/remote.md'],
      displaced: [],
    }))
    const frozen: string[][] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onLocalOnlyChangesSkipped: (paths) => {
        frozen.push(paths)
      },
    })

    await engine.syncNow()

    expect(frozen).toEqual([['finance/secure/remote.md']])
    engine.stop()
  })

  it('stays quiet when a pull froze nothing (control)', async () => {
    fakeGit()
    const onLocalOnlyChangesSkipped = vi.fn()
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onLocalOnlyChangesSkipped,
    })

    await engine.syncNow()

    expect(onLocalOnlyChangesSkipped).not.toHaveBeenCalled()
    engine.stop()
  })

  it('runs one cycle at a time and schedules a follow-up for mid-cycle edits', async () => {
    const pushGate: { resolve: ((value: PushOutcome) => void) | null } = { resolve: null }
    const git = fakeGit()
    git.onPush(() => {
      return new Promise((resolve) => {
        pushGate.resolve = resolve
      })
    })
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      idleMs: 10,
    })

    engine.noteChanged()
    await advance(10)
    expect(methodsOf(git)).toEqual(['commitAll', 'push'])

    engine.noteChanged() // lands mid-cycle: must not start a second commit
    await advance(50)
    expect(methodsOf(git)).toEqual(['commitAll', 'push'])

    pushGate.resolve?.(PUSHED)
    await runAllTimers()
    // The mid-cycle edit got its own follow-up cycle.
    expect(methodsOf(git)).toEqual(['commitAll', 'push', 'commitAll', 'push'])
    engine.stop()
  })

  it('skips the push when a debounced pass finds nothing committed and nothing ahead', async () => {
    // The watcher re-reports a pull's own writes; the resulting cycle must
    // not buy a network round-trip for them.
    const git = fakeGit()
    git.onCommitAll(() => CLEAN_COMMIT)
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })

    engine.noteChanged()
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll'])
    engine.stop()
  })

  it('skips the push when a launch pull finds both sides already in step', async () => {
    const git = fakeGit()
    git.onCommitAll(() => {
      return CLEAN_COMMIT
    })
    git.onFetch(() => {
      return { ahead: 0, behind: 0 }
    })
    git.onMergeRemote(() => {
      return { ...MERGED, kind: 'upToDate' }
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    await engine.syncNow()

    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote'])
    engine.stop()
  })

  it('a full sync cancels a pending debounced pass instead of double-running', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      idleMs: 100,
    })

    engine.noteChanged() // schedules a debounced pass…
    await engine.syncNow() // …which this full cycle already covers
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote', 'push'])
    engine.stop()
  })

  it('localOnly commits and never touches the network — even for a full sync', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => null,
      localOnly: true,
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()
    await engine.syncNow()

    expect(methodsOf(git)).toEqual(['commitAll', 'commitAll'])
    engine.stop()
  })

  it('stop() cancels pending work', async () => {
    const git = fakeGit()
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, idleMs: 10 })

    engine.noteChanged()
    engine.stop()
    await runAllTimers()

    expect(git.calls()).toHaveLength(0)
  })

  it('passes a missing credential through as null (Rust owns the failure)', async () => {
    // The engine has no null-credential special case on purpose: only the remote
    // knows whether it needs auth. A push refused for a missing credential
    // must still land on the reconnect affordance.
    const git = fakeGit()
    git.onPush(() => {
      throw { kind: 'auth', message: 'authentication required' }
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => null,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await runAllTimers()

    const push = git.calls().find((call) => call.method === 'push')
    expect(push?.args[0]).toBeNull()
    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'auth' })
    engine.stop()
  })

  it('ignores edits arriving after stop() — the abort is sticky', async () => {
    const git = fakeGit()
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.stop()
    engine.noteChanged()
    await engine.syncNow()
    await runAllTimers()

    expect(git.calls()).toHaveLength(0)
    expect(statuses).toHaveLength(0)
  })

  it('serializes concurrent syncNow calls into one cycle plus one follow-up', async () => {
    const pushGates: Array<(value: PushOutcome) => void> = []
    const git = fakeGit()
    git.onPush(() => {
      return new Promise((resolve) => {
        pushGates.push(resolve)
      })
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    const first = engine.syncNow()
    const second = engine.syncNow()
    const third = engine.syncNow()
    await runAllTimers()
    // Only the first cycle has started; the others coalesced, not interleaved.
    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote', 'push'])

    pushGates.shift()?.(PUSHED)
    await runAllTimers()
    pushGates.shift()?.(PUSHED)
    await runAllTimers()
    await Promise.all([first, second, third])

    // The two queued requests collapsed into a single full follow-up cycle.
    expect(methodsOf(git)).toEqual([
      'commitAll',
      'fetch',
      'commitAll',
      'mergeRemote',
      'push',
      'commitAll',
      'fetch',
      'commitAll',
      'mergeRemote',
      'push',
    ])
    engine.stop()
  })

  it('stops at the next command boundary when cycles become suppressed', async () => {
    let canStartCycle = true
    const fetchGate = Promise.withResolvers<RemoteDelta>()
    const git = fakeGit()
    git.onFetch(() => {
      return fetchGate.promise
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      canStartCycle: () => canStartCycle,
    })

    const syncing = engine.syncNow()
    await advance(0)
    expect(methodsOf(git)).toEqual(['commitAll', 'fetch'])

    canStartCycle = false
    fetchGate.resolve(DELTA)
    await syncing

    // Fetch began while allowed, but merge/push must not start after the
    // lifecycle becomes hidden. Suppression is an idle pause, not an error.
    expect(methodsOf(git)).toEqual(['commitAll', 'fetch'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing', 'idle'])
    engine.stop()
  })

  it('stop() mid-cycle issues no further commands and emits no further status', async () => {
    const pushGate = Promise.withResolvers<PushOutcome>()
    const git = fakeGit()
    git.onPush(() => {
      return pushGate.promise
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
      idleMs: 10,
    })

    engine.noteChanged()
    await advance(10)
    expect(methodsOf(git)).toEqual(['commitAll', 'push'])

    // Disconnect/teardown while the push is in flight: the resolution would
    // normally trigger fetch+merge+retry (non-fast-forward) and a status
    // emission — a stopped engine must do neither.
    engine.stop()
    pushGate.resolve(NON_FAST_FORWARD)
    await runAllTimers()

    expect(methodsOf(git)).toEqual(['commitAll', 'push'])
    expect(statuses.map((status) => status.state)).toEqual(['syncing'])
  })

  it('commits before every merge, the push-retry merge included', async () => {
    let pushes = 0
    const git = fakeGit()
    git.onPush(() => {
      pushes += 1
      return pushes === 1 ? NON_FAST_FORWARD : PUSHED
    })
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    await engine.syncNow()

    // Saves made while a fetch was on the network are committed before the
    // merge that follows it, so a pull meets as few uncommitted bytes as
    // possible.
    const commands = methodsOf(git)
    for (const [position, command] of commands.entries()) {
      if (command === 'mergeRemote') {
        expect(commands[position - 1]).toBe('commitAll')
      }
    }
    expect(commands.filter((command) => command === 'mergeRemote')).toHaveLength(2)
    engine.stop()
  })

  it('retries a deferred pull with a fresh commit, at most twice per cycle', async () => {
    const git = fakeGit()
    git.onMergeRemote(() => DEFERRED)
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
    })

    await engine.syncNow()

    expect(methodsOf(git)).toEqual([
      'commitAll',
      'fetch',
      'commitAll',
      'mergeRemote',
      'commitAll',
      'mergeRemote',
      'commitAll',
      'mergeRemote',
    ])
    expect(statuses.at(-1)).toMatchObject({ state: 'error', errorKind: 'other' })
    engine.stop()
  })

  it('carries on once a deferred pull lands on its retry', async () => {
    let merges = 0
    const git = fakeGit()
    git.onMergeRemote(() => {
      merges += 1
      return merges === 1 ? DEFERRED : MERGED
    })
    const statuses: SyncStatus[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onStatus: (status) => {
        statuses.push(status)
      },
    })

    await engine.syncNow()

    expect(methodsOf(git)).toEqual([
      'commitAll',
      'fetch',
      'commitAll',
      'mergeRemote',
      'commitAll',
      'mergeRemote',
      'push',
    ])
    expect(statuses.at(-1)).toEqual({ state: 'idle' })
    engine.stop()
  })

  it('hands displaced pairs over before the pull’s changed files', async () => {
    const displaced: DisplacedFile = {
      from: 'daily/2026-10-04.md',
      to: 'daily/2026-10-04 (this device).md',
      keptOut: false,
      tracked: false,
      differentNote: false,
    }
    const git = fakeGit()
    git.onMergeRemote(() => ({
      kind: 'fastForward',
      conflictedPaths: [],
      changedFiles: [
        { path: displaced.from, kind: 'upsert' },
        { path: displaced.to, kind: 'upsert' },
      ],
      frozenPaths: [],
      displaced: [displaced],
    }))
    const order: string[] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onDisplaced: (pairs) => {
        order.push(`displaced:${pairs.map((pair) => pair.to).join(',')}`)
      },
      onRemoteChanges: (changes) => {
        order.push(`changes:${changes.length}`)
      },
    })

    await engine.syncNow()

    expect(order).toEqual(['displaced:daily/2026-10-04 (this device).md', 'changes:2'])
    engine.stop()
  })

  it('stays quiet about displacement when a pull moved nothing (control)', async () => {
    fakeGit()
    const onDisplaced = vi.fn()
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED, onDisplaced })

    await engine.syncNow()

    expect(onDisplaced).not.toHaveBeenCalled()
    engine.stop()
  })

  it('reports a withheld file once per cycle, however many commits it makes', async () => {
    const git = fakeGit()
    git.onCommitAll(() => ({
      committed: true,
      sha: 'abc',
      ahead: 1,
      skippedLargeFiles: [{ path: 'assets/movie.mp4', size: 200_000_000 }],
    }))
    const skipped: SkippedFile[][] = []
    const engine = createSyncEngine({
      generation: 1,
      getCredential: async () => CRED,
      onLargeFilesSkipped: (files) => {
        skipped.push(files)
      },
    })

    await engine.syncNow()

    expect(methodsOf(git).filter((method) => method === 'commitAll')).toHaveLength(2)
    expect(skipped).toEqual([[{ path: 'assets/movie.mp4', size: 200_000_000 }]])
    engine.stop()
  })

  it('pushes what the commit after the fetch recorded, even on a clean fast-forward', async () => {
    let commits = 0
    const git = fakeGit()
    git.onCommitAll(() => {
      commits += 1
      return commits === 1 ? CLEAN_COMMIT : COMMITTED
    })
    git.onFetch(() => ({ ahead: 0, behind: 1 }))
    git.onMergeRemote(() => ({ ...MERGED, kind: 'fastForward' }))
    const engine = createSyncEngine({ generation: 1, getCredential: async () => CRED })

    await engine.syncNow()

    expect(methodsOf(git)).toEqual(['commitAll', 'fetch', 'commitAll', 'mergeRemote', 'push'])
    engine.stop()
  })
})
