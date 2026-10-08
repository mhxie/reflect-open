import { z } from 'zod'
import { call } from '../ipc/invoke.ts'

/**
 * Typed bindings for the Rust git primitives (Plan 12). The Rust layer is
 * remote-agnostic — URLs and a per-call {@link GitCredential}, nothing
 * GitHub-specific (that lives in `./github`). Policy (cadence, retries, product states) is
 * `./engine`'s job; these are the verbs it composes.
 */

/**
 * An HTTPS sign-in for one remote operation: basic auth, presented once by
 * the Rust layer and never written anywhere. GitHub's shape is
 * `githubCredential(token)` in `./github-auth`.
 */
export interface GitCredential {
  username: string
  secret: string
}

/** Snapshot of the graph's backup repository (cheap — no working-tree scan). */
export const gitStatusSchema = z.object({
  initialized: z.boolean(),
  branch: z.string().nullable(),
  remoteUrl: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
  inProgress: z.boolean(),
})
export type GitStatus = z.infer<typeof gitStatusSchema>

/** The tracked note's latest local Git commit, abbreviated uniquely, or no version. */
export const gitNoteVersionSchema = z
  .string()
  .regex(/^[0-9a-f]{4,40}$/)
  .nullable()
export type GitNoteVersion = z.infer<typeof gitNoteVersionSchema>

/** A file excluded from backup by the size guardrail (GitHub hard-fails >100 MB). */
export const skippedFileSchema = z.object({
  path: z.string(),
  size: z.number(),
})
export type SkippedFile = z.infer<typeof skippedFileSchema>

export const commitOutcomeSchema = z.object({
  /** False when the tree already matched HEAD — nothing new to back up. */
  committed: z.boolean(),
  /** The new commit, or `null` when `committed` is false. */
  sha: z.string().nullable(),
  /** Unpushed local commits (vs the last fetch) — the engine's skip-push gate. */
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

/** A file a merge rewrote on disk — same shape as the watcher's FileChange. */
export const changedFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['upsert', 'remove']),
  /** Last-modified time (epoch ms; upserts only) — real mtime for the reindex. */
  modifiedMs: z.number().optional(),
})
export type ChangedFile = z.infer<typeof changedFileSchema>

/**
 * One of this device's entries a pull moved out of a path it wrote, so the
 * other device's file could take the path: `to` is `name (this device).ext`.
 */
export const displacedFileSchema = z.object({
  /** Where the entry was, spelled as on disk (the path the index knows). */
  from: z.string(),
  /** Where it is now. */
  to: z.string(),
  /** The moved note is locked (or its frontmatter can't be read). */
  keptOut: z.boolean(),
  /** It was tracked: its uncommitted bytes differed from the last commit. */
  tracked: z.boolean(),
  /** The incoming note carries another frontmatter id: a different note took the path. */
  differentNote: z.boolean().default(false),
})
export type DisplacedFile = z.infer<typeof displacedFileSchema>

export const mergeOutcomeSchema = z.object({
  /**
   * `deferred`: a save raced the cycle's commit, so the pull wrote nothing;
   * the engine commits and pulls again.
   */
  kind: z.enum(['upToDate', 'fastForward', 'merged', 'mergedWithConflicts', 'deferred']),
  conflictedPaths: z.array(z.string()),
  /**
   * Every file the merge changed. The caller reindexes these directly —
   * pulls must not depend on the file watcher being up (on launch it may
   * not be yet) to keep the index in step with the notes.
   */
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
export type MergeOutcome = z.infer<typeof mergeOutcomeSchema>

export const pushOutcomeSchema = z.object({
  pushed: z.boolean(),
  nonFastForward: z.boolean(),
  rejectionMessage: z.string().nullable(),
})
export type PushOutcome = z.infer<typeof pushOutcomeSchema>

/** Snapshot the backup repository (cheap, no network). */
export async function gitStatus(generation: number): Promise<GitStatus> {
  return await call('git_status', { generation }, gitStatusSchema)
}

/**
 * Read the latest commit for the note tracked at this literal graph-relative path. This is
 * local history metadata; it does not report whether the note was uploaded.
 */
export async function gitNoteVersion(path: string, generation: number): Promise<GitNoteVersion> {
  return await call('git_note_version', { path, generation }, gitNoteVersionSchema)
}

/**
 * Initialize (or adopt) the graph repository; `remoteUrl` points `origin` at
 * the backup remote and `branch` aligns the local branch with the remote's
 * default (an existing repo on `master` must not end up shadowed by a
 * parallel local `main`). Idempotent.
 */
export async function gitSetup(
  remoteUrl: string | null,
  branch: string | null,
  generation: number,
): Promise<GitStatus> {
  return await call('git_setup', { remoteUrl, branch, generation }, gitStatusSchema)
}

/**
 * Stop backing this graph up: drop the `origin` remote. The repository and
 * its history stay; the machine-level GitHub credential is untouched.
 */
export async function gitDisconnect(generation: number): Promise<GitStatus> {
  return await call('git_disconnect', { generation }, gitStatusSchema)
}

/**
 * Clone a backup repository into an absolute `path` (restore on a fresh
 * machine — runs before any graph is open). Refuses non-empty destinations.
 */
export async function gitClone(
  url: string,
  path: string,
  credential: GitCredential | null,
): Promise<void> {
  await call('git_clone', { url, path, credential }, z.null())
}

/**
 * Commit every pending change (no-op when the tree is clean). `fallbackMessage`
 * is used only when Rust cannot derive a clearer subject from staged paths.
 */
export async function gitCommitAll(
  fallbackMessage: string,
  generation: number,
): Promise<CommitOutcome> {
  return await call('git_commit_all', { message: fallbackMessage, generation }, commitOutcomeSchema)
}

/** Fetch `origin`; returns ahead/behind for the current branch. */
export async function gitFetch(
  credential: GitCredential | null,
  generation: number,
): Promise<RemoteDelta> {
  return await call('git_fetch', { credential, generation }, remoteDeltaSchema)
}

/**
 * Merge the fetched remote branch. Conflicts are committed into the notes as
 * labeled markers — the repo is never left mid-merge, and the indexer turns
 * the markers into `Needs review` flags. Uncommitted bytes in the pull's way
 * move aside (`displaced`, each also broadcast on `note:displaced`); a save
 * that raced the cycle's commit comes back `deferred`.
 */
export async function gitMergeRemote(generation: number): Promise<MergeOutcome> {
  return await call('git_merge_remote', { generation }, mergeOutcomeSchema)
}

/** Push to `origin`; rejections come back as data, not thrown errors. */
export async function gitPush(
  credential: GitCredential | null,
  generation: number,
): Promise<PushOutcome> {
  return await call('git_push', { credential, generation }, pushOutcomeSchema)
}
