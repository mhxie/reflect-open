import { describe, expect, it } from 'vitest'
import { createTestIpcBridgeService } from '../testing/ipc.ts'
import { createGitRepositoryService } from './git-repository-service.ts'
const STATUS = {
  initialized: true,
  branch: 'main',
  remoteUrl: 'https://github.com/a/b.git',
  ahead: 0,
  behind: 0,
}
const CRED = { username: 'x-access-token', secret: 'tok' }

describe('createGitRepositoryService', () => {
  it('sends each method to its command with the generation', async () => {
    const ipc = createTestIpcBridgeService({
      commands: {
        git_status: () => STATUS,
        git_note_version: () => 'abc123d',
        git_setup: () => STATUS,
        git_disconnect: () => ({ ...STATUS, remoteUrl: null }),
        git_commit_all: () => ({ committed: true, sha: 'abc', ahead: 1, skippedLargeFiles: [] }),
        git_fetch: () => ({ ahead: 1, behind: 2 }),
        git_remote_head: () => ({ remoteOid: 'abc', trackingOid: null, defaultBranch: 'main' }),
        git_push: () => ({ pushed: true, nonFastForward: false, rejectionMessage: null }),
        git_pull: () => ({
          committed: true,
          ahead: 1,
          skippedLargeFiles: [],
          kind: 'merged',
          reviewPaths: ['a (conflict 2026-10-16 08-05-31 a1b2c3d4).json'],
          changedFiles: [{ path: 'a.md', kind: 'upsert', modifiedMs: null }],
          frozenPaths: [],
          displaced: [],
        }),
      },
    })
    const git = createGitRepositoryService({ ipc })

    await expect(git.status(3)).resolves.toEqual(STATUS)
    await expect(git.noteVersion('notes/a.md', 3)).resolves.toBe('abc123d')
    await git.setup('https://github.com/a/b.git', 'main', 3)
    await expect(git.disconnect(3)).resolves.toMatchObject({ remoteUrl: null })
    await expect(git.commitAll('Update notes', 3)).resolves.toMatchObject({ sha: 'abc' })
    await expect(git.fetch(CRED, 3)).resolves.toEqual({ ahead: 1, behind: 2 })
    await expect(git.remoteHead(CRED, 3)).resolves.toEqual({
      remoteOid: 'abc',
      trackingOid: null,
      defaultBranch: 'main',
    })
    await expect(git.push(null, 3)).resolves.toMatchObject({ pushed: true })
    await expect(git.pull('Update notes', 3)).resolves.toEqual({
      committed: true,
      ahead: 1,
      skippedLargeFiles: [],
      kind: 'merged',
      reviewPaths: ['a (conflict 2026-10-16 08-05-31 a1b2c3d4).json'],
      changedFiles: [{ path: 'a.md', kind: 'upsert', modifiedMs: null }],
      frozenPaths: [],
      displaced: [],
    })

    expect(ipc.calls()).toEqual([
      { command: 'git_status', args: { generation: 3 } },
      { command: 'git_note_version', args: { path: 'notes/a.md', generation: 3 } },
      {
        command: 'git_setup',
        args: { remoteUrl: 'https://github.com/a/b.git', branch: 'main', generation: 3 },
      },
      { command: 'git_disconnect', args: { generation: 3 } },
      { command: 'git_commit_all', args: { message: 'Update notes', generation: 3 } },
      { command: 'git_fetch', args: { credential: CRED, generation: 3 } },
      { command: 'git_remote_head', args: { url: null, credential: CRED, generation: 3 } },
      { command: 'git_push', args: { credential: null, generation: 3 } },
      { command: 'git_pull', args: { message: 'Update notes', generation: 3 } },
    ])
  })

  it('rejects a malformed response with a parse error', async () => {
    const ipc = createTestIpcBridgeService({ commands: { git_fetch: () => ({ ahead: 'x' }) } })
    const git = createGitRepositoryService({ ipc })

    await expect(git.fetch(null, 1)).rejects.toMatchObject({ kind: 'parse' })
  })

  it('reads a note’s version as a short hex id, or none for an untracked note', async () => {
    const versions: unknown[] = [null, 'not-a-sha']
    const ipc = createTestIpcBridgeService({
      commands: { git_note_version: () => versions.shift() },
    })
    const git = createGitRepositoryService({ ipc })

    await expect(git.noteVersion('notes/new.md', 3)).resolves.toBeNull()
    await expect(git.noteVersion('notes/a.md', 3)).rejects.toMatchObject({ kind: 'parse' })
  })

  it('reads a pull’s frozen and displaced entries, and an answer that has none', async () => {
    const displaced = {
      from: 'daily/2026-10-04.md',
      to: 'daily/2026-10-04 (this device).md',
      keptOut: false,
      tracked: true,
    }
    const pulled = { committed: false, ahead: 0, skippedLargeFiles: [], reviewPaths: [] }
    const outcomes: unknown[] = [
      { ...pulled, kind: 'merged', changedFiles: [] },
      {
        ...pulled,
        kind: 'fastForward',
        changedFiles: [{ path: displaced.to, kind: 'upsert', modifiedMs: 2 }],
        frozenPaths: ['finance/secure/remote.md'],
        displaced: [displaced],
      },
      { ...pulled, kind: 'deferred', changedFiles: [] },
    ]
    const ipc = createTestIpcBridgeService({
      commands: { git_pull: () => outcomes.shift() },
    })
    const git = createGitRepositoryService({ ipc })

    await expect(git.pull('Update notes', 3)).resolves.toEqual({
      ...pulled,
      kind: 'merged',
      changedFiles: [],
      frozenPaths: [],
      displaced: [],
    })
    await expect(git.pull('Update notes', 3)).resolves.toMatchObject({
      frozenPaths: ['finance/secure/remote.md'],
      displaced: [{ ...displaced, differentNote: false }],
    })
    await expect(git.pull('Update notes', 3)).resolves.toMatchObject({ kind: 'deferred' })
  })
})
