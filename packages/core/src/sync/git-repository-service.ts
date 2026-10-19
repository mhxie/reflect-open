import { z } from 'zod'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'

/**
 * An HTTPS sign-in for one remote operation: basic auth, presented once by
 * the Rust layer and never written anywhere. GitHub's shape is
 * `githubCredential(token)` in `./github-auth`.
 */
export interface GitCredential {
  username: string
  secret: string
}

/**
 * Snapshot of the graph's backup repository (cheap — no working-tree scan).
 */
export const gitStatusSchema = z.object({
  initialized: z.boolean(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
})
export type GitStatus = z.infer<typeof gitStatusSchema>

/**
 * The tracked note's latest local Git commit, abbreviated uniquely, or no version.
 */
export const gitNoteVersionSchema = z
  .string()
  .regex(/^[0-9a-f]{4,40}$/)
  .nullable()
export type GitNoteVersion = z.infer<typeof gitNoteVersionSchema>

/**
 * A file excluded from backup by the size guardrail (GitHub hard-fails >100 MB).
 */
export const skippedFileSchema = z.object({
  path: z.string(),
  size: z.number(),
})
export type SkippedFile = z.infer<typeof skippedFileSchema>

/**
 * A file a merge rewrote on disk, same shape as the watcher's FileChange.
 */
export const changedFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['upsert', 'remove']),
  /** Last-modified time in epoch ms; `null` for a removed file. */
  modifiedMs: z.number().nullable(),
})
export type ChangedFile = z.infer<typeof changedFileSchema>

export const commitOutcomeSchema = z.object({
  /**
   * False when the tree already matched HEAD — nothing new to back up.
   */
  committed: z.boolean(),
  /**
   * The new commit, or `null` when `committed` is false.
   */
  sha: z.string().nullable(),
  /**
   * Unpushed local commits (vs the last fetch) — the engine's skip-push gate.
   */
  ahead: z.number(),
  skippedLargeFiles: z.array(skippedFileSchema),
})
export type CommitOutcome = z.infer<typeof commitOutcomeSchema>

/**
 * Where the current branch stands relative to the just-fetched remote branch:
 * `ahead` = local commits the remote lacks (a push is due), `behind` = remote
 * commits not yet merged locally (a merge is due).
 */
export const remoteDeltaSchema = z.object({
  ahead: z.number(),
  behind: z.number(),
})
export type RemoteDelta = z.infer<typeof remoteDeltaSchema>

/**
 * Where `origin` says the current branch is (`remoteOid`, `null` when the
 * remote has no such branch) next to the last-fetched tracking ref.
 */
export const remoteTipSchema = z.object({
  remoteOid: z.string().nullable(),
  trackingOid: z.string().nullable(),
})
export type RemoteTip = z.infer<typeof remoteTipSchema>

/**
 * One of this device's entries a pull moved out of a path it wrote, so the
 * other device's file could take the path: `to` is `name (this device).ext`.
 */
export const displacedFileSchema = z.object({
  /**
   * Where the entry was, spelled as on disk (the path the index knows).
   */
  from: z.string(),
  /**
   * Where it is now.
   */
  to: z.string(),
  /**
   * The moved note is locked (or its frontmatter can't be read).
   */
  keptOut: z.boolean(),
  /**
   * It was tracked: its uncommitted bytes differed from the last commit.
   */
  tracked: z.boolean(),
  /**
   * The incoming note carries another frontmatter id: a different note took the path.
   */
  differentNote: z.boolean().default(false),
})
export type DisplacedFile = z.infer<typeof displacedFileSchema>

export const pullOutcomeSchema = z.object({
  /** True when the pull committed local changes before it merged. */
  committed: z.boolean(),
  /** Unpushed local commits after the merge. */
  ahead: z.number(),
  skippedLargeFiles: z.array(skippedFileSchema),
  /**
   * `deferred`: a file changed from outside the app after the pull's commit,
   * so the pull wrote nothing; the engine pulls again.
   */
  kind: z.enum(['upToDate', 'fastForward', 'merged', 'deferred']),
  /** Graph-relative paths of the conflict copies the merge wrote. */
  reviewPaths: z.array(z.string()),
  /** Every file the merge changed on disk. */
  changedFiles: z.array(changedFileSchema),
  /**
   * Another device's changes inside this graph's local-only folders: kept in
   * history, never written on this device (the folders stay frozen).
   */
  frozenPaths: z.array(z.string()).default([]),
  /**
   * This device's entries the pull moved aside instead of overwriting.
   * Their new paths are in `changedFiles` too.
   */
  displaced: z.array(displacedFileSchema).default([]),
})
export type PullOutcome = z.infer<typeof pullOutcomeSchema>

export const pushOutcomeSchema = z.object({
  pushed: z.boolean(),
  nonFastForward: z.boolean(),
  rejectionMessage: z.string().nullable(),
})
export type PushOutcome = z.infer<typeof pushOutcomeSchema>

/**
 * The Rust git primitives for the open graph's repository. The Rust layer is
 * remote-agnostic: URLs and a per-call {@link GitCredential}, nothing
 * GitHub-specific. Every method is pinned to the graph `generation` it was
 * issued for, so a command that lands after a graph switch fails instead of
 * touching the wrong repository.
 */
export interface GitRepositoryService {
  /**
   * Snapshot the backup repository (cheap, no network).
   */
  status(generation: number): Promise<GitStatus>
  /**
   * Read the latest commit for the note tracked at this literal graph-relative
   * path, abbreviated uniquely (`null` when no commit tracks it). This is
   * local history metadata; it does not report whether the note was uploaded.
   */
  noteVersion(path: string, generation: number): Promise<GitNoteVersion>
  /**
   * Initialize (or adopt) the graph repository; `remoteUrl` points `origin` at
   * the backup remote and `branch` aligns the local branch with the remote's
   * default (an existing repo on `master` must not end up shadowed by a
   * parallel local `main`). Idempotent.
   */
  setup(remoteUrl: string | null, branch: string | null, generation: number): Promise<GitStatus>
  /**
   * Stop backing this graph up: drop the `origin` remote. The repository and
   * its history stay; the machine-level credential is untouched.
   */
  disconnect(generation: number): Promise<GitStatus>
  /**
   * Commit every pending change (no-op when the tree is clean). `fallbackMessage`
   * is used only when Rust cannot derive a clearer subject from staged paths.
   */
  commitAll(fallbackMessage: string, generation: number): Promise<CommitOutcome>
  /**
   * Fetch `origin`; returns ahead/behind for the current branch.
   */
  fetch(credential: GitCredential | null, generation: number): Promise<RemoteDelta>
  /**
   * Ask `origin` for the current branch tip without fetching.
   */
  remoteHead(credential: GitCredential | null, generation: number): Promise<RemoteTip>
  /**
   * Push to `origin`; rejections come back as data, not thrown errors.
   */
  push(credential: GitCredential | null, generation: number): Promise<PushOutcome>
  /**
   * Commit local changes, then merge the fetched remote branch, under one
   * graph lock. Text conflicts are committed as merged text and other
   * conflicts keep a copy: the repo is never left mid-merge. Uncommitted
   * bytes in the pull's way move aside (`displaced`, each also broadcast on
   * `note:displaced`), another device's changes inside a local-only folder
   * stay out of the tree (`frozenPaths`), and a write from outside the app
   * that raced the commit comes back `deferred` with nothing written.
   */
  pull(fallbackMessage: string, generation: number): Promise<PullOutcome>
}

export interface GitRepositoryServiceDeps {
  readonly ipc: IpcBridgeService
}

class GitRepositoryServiceImpl implements GitRepositoryService {
  readonly #deps: GitRepositoryServiceDeps

  constructor(deps: GitRepositoryServiceDeps) {
    this.#deps = deps
  }

  status(generation: number): Promise<GitStatus> {
    return this.#deps.ipc.call('git_status', { generation }, gitStatusSchema)
  }

  noteVersion(path: string, generation: number): Promise<GitNoteVersion> {
    return this.#deps.ipc.call('git_note_version', { path, generation }, gitNoteVersionSchema)
  }

  setup(remoteUrl: string | null, branch: string | null, generation: number): Promise<GitStatus> {
    return this.#deps.ipc.call('git_setup', { remoteUrl, branch, generation }, gitStatusSchema)
  }

  disconnect(generation: number): Promise<GitStatus> {
    return this.#deps.ipc.call('git_disconnect', { generation }, gitStatusSchema)
  }

  commitAll(fallbackMessage: string, generation: number): Promise<CommitOutcome> {
    return this.#deps.ipc.call(
      'git_commit_all',
      { message: fallbackMessage, generation },
      commitOutcomeSchema,
    )
  }

  fetch(credential: GitCredential | null, generation: number): Promise<RemoteDelta> {
    return this.#deps.ipc.call('git_fetch', { credential, generation }, remoteDeltaSchema)
  }

  remoteHead(credential: GitCredential | null, generation: number): Promise<RemoteTip> {
    return this.#deps.ipc.call('git_remote_head', { credential, generation }, remoteTipSchema)
  }

  push(credential: GitCredential | null, generation: number): Promise<PushOutcome> {
    return this.#deps.ipc.call('git_push', { credential, generation }, pushOutcomeSchema)
  }

  pull(fallbackMessage: string, generation: number): Promise<PullOutcome> {
    return this.#deps.ipc.call(
      'git_pull',
      { message: fallbackMessage, generation },
      pullOutcomeSchema,
    )
  }
}

export function createGitRepositoryService(deps: GitRepositoryServiceDeps): GitRepositoryService {
  return new GitRepositoryServiceImpl(deps)
}
