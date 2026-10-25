//! Git backup/sync primitives (Plan 12) with no Tauri in them.
//!
//! Rust owns the *capabilities* — init/adopt, commit, fetch, merge, push —
//! while the sync **policy** (debounce cadence, retry loop, product states,
//! GitHub specifics) lives in `@reflect/core` `sync/`. Nothing here is
//! GitHub-specific: remotes are URLs, and an HTTPS sign-in arrives per call
//! as a [`GitCredential`] presented through a callback (never embedded in
//! the URL, so never on disk).
//!
//! Every operation takes the graph root and runs on the caller's thread:
//! network fetches and pushes take seconds, so the shell runs them on a
//! blocking pool, and pins the root to the graph generation the frontend
//! received when it opened the graph. [`run_with_lock_retry`] wraps an
//! operation with the one retry after clearing a stale `.lock` file.
//!
//! What a graph's backup may do comes in from the shell: its local-only
//! folders (never committed, never written by a pull), the history roots it
//! accepts (a pull or push that would join any other pauses), and its file
//! size limit (see [`PullPolicy`]).

mod commit;
mod commit_message;
mod displace;
#[cfg(test)]
mod fault;
mod history_roots;
mod locks;
mod merge;
mod note_version;
mod paths;
mod remote;
mod repo;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

use std::path::Path;

use reflect_graph_paths::LocalOnlyFolders;
use serde::Serialize;

use reflect_types::AppResult;

pub use self::commit::{CommitOutcome, SkippedFile};
pub use self::displace::DisplacedFile;
pub use self::history_roots::SETTINGS_KEY as ACCEPTED_HISTORY_ROOTS_SETTINGS_KEY;
pub use self::merge::{ChangeKind, ChangedFile, MergeKind, PullPolicy};
pub use self::remote::{GitCredential, PushOutcome, RemoteDelta, RemoteTip};

/// GitHub rejects files over 100 MB, failing the whole push; stop just under.
/// The default backup size limit, and the highest a graph may set.
pub const MAX_FILE_BYTES: u64 = 95 * 1024 * 1024;

/// Snapshot of the graph's backup repository for the UI and the sync engine.
/// Deliberately cheap — refs and config only, no working-tree scan.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Whether the graph has a repository at all (backup set up).
    pub initialized: bool,
    pub branch: Option<String>,
    pub remote_url: Option<String>,
    /// Commits ahead/behind the last-fetched remote branch (no network).
    pub ahead: usize,
    pub behind: usize,
}

pub fn status(root: &Path) -> AppResult<GitStatus> {
    if !root.join(".git").exists() {
        return Ok(GitStatus {
            initialized: false,
            branch: None,
            remote_url: None,
            ahead: 0,
            behind: 0,
        });
    }
    let repo = repo::open_existing(root)?;
    let branch = repo::current_branch(&repo).ok();
    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|remote| remote.url().ok().map(str::to_string));
    let delta = remote::local_delta(&repo).unwrap_or(RemoteDelta {
        ahead: 0,
        behind: 0,
    });
    Ok(GitStatus {
        initialized: true,
        branch,
        remote_url,
        ahead: delta.ahead,
        behind: delta.behind,
    })
}

/// Stop backing this graph up: drop the `origin` remote. The repository and
/// its history stay intact (reconnecting re-adds a remote); the machine-level
/// GitHub credential is untouched — other graphs keep syncing.
pub fn disconnect(root: &Path) -> AppResult<GitStatus> {
    let repo = repo::open_existing(root)?;
    if repo.find_remote("origin").is_ok() {
        repo.remote_delete("origin")?;
    }
    drop(repo);
    status(root)
}

pub fn setup(
    root: &Path,
    remote_url: Option<String>,
    branch: Option<String>,
) -> AppResult<GitStatus> {
    let repo = repo::open_or_init(root)?;
    repo::ensure_gitignore_defaults(root)?;
    if let Some(url) = remote_url {
        if repo.find_remote("origin").is_ok() {
            repo.remote_set_url("origin", &url)?;
        } else {
            repo.remote("origin", &url)?;
        }
    }
    if let Some(branch) = branch {
        repo::align_branch(&repo, &branch)?;
    }
    drop(repo);
    status(root)
}

/// What one pull did: the commit of local changes, then the merge of the
/// fetched remote branch.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
    /// Whether local changes were committed before the merge.
    pub committed: bool,
    /// Commits the local branch is ahead of the last-fetched remote after the
    /// merge (no network).
    pub ahead: usize,
    pub skipped_large_files: Vec<SkippedFile>,
    pub kind: MergeKind,
    /// Graph-relative paths of the conflict copies the merge wrote.
    pub review_paths: Vec<String>,
    /// Every file the merge changed on disk.
    pub changed_files: Vec<ChangedFile>,
    /// The other device's changes inside this graph's local-only folders:
    /// recorded in history, never written here.
    pub frozen_paths: Vec<String>,
    /// This device's entries the merge moved out of the paths it wrote (the
    /// bytes the commit withheld), and where each went.
    pub displaced: Vec<DisplacedFile>,
}

/// Commit local changes and merge the fetched remote branch under one graph
/// lock, so no write lands between the commit and the checkout. The bytes the
/// commit withholds (an oversized edit, an untracked entry) move aside before
/// the checkout writes their paths; `displaced` receives every entry the pull
/// left moved, whatever the result, for the caller to announce. Before the
/// lock is let go, the graph's record of displaced revisions is replaced with
/// the notes in `displaced`: a retry passes its earlier attempts' entries back
/// in, so the record covers every move the caller announces (see `displace`).
/// A merge that would join a history root the graph has not accepted pauses
/// after the commit, which stays local: the push is guarded the same way.
pub fn pull_all(
    root: &Path,
    message: &str,
    policy: &PullPolicy<'_>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<PullOutcome> {
    reflect_graph_io::with_graph_lock(root, || {
        let pulled = pull_locked(root, message, policy, displaced);
        displace::record_revisions(root, displaced);
        pulled
    })
}

/// [`pull_all`]'s body. The caller holds the graph lock.
fn pull_locked(
    root: &Path,
    message: &str,
    policy: &PullPolicy<'_>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<PullOutcome> {
    #[cfg(test)]
    fault::trip(fault::FaultPoint::BeforeCommit)?;
    let commit = commit::commit_locked(root, message, policy.max_file_bytes, policy.local_only)?;
    let merge = merge::merge_locked(root, policy, displaced)?;
    let ahead = commit::ahead_of_remote(&repo::open_existing(root)?);
    Ok(PullOutcome {
        committed: commit.committed,
        ahead,
        skipped_large_files: commit.skipped_large_files,
        kind: merge.kind,
        review_paths: merge.review_paths,
        changed_files: merge.changed_files,
        frozen_paths: merge.frozen_paths,
        displaced: merge.displaced,
    })
}

/// Run a git operation against `root`, retrying once after clearing a stale
/// `.lock` file (see `locks`).
pub fn run_with_lock_retry<T>(
    root: &Path,
    operation: impl Fn(&Path) -> AppResult<T>,
) -> AppResult<T> {
    locks::retry_after_stale_lock(root, || operation(root))
}

/// Clone a backup repository into `path` (restore on a fresh machine).
pub fn clone(url: &str, path: &Path, credential: Option<GitCredential>) -> AppResult<()> {
    remote::clone(url, path, credential)
}

/// Fetch `origin` and report ahead/behind for the current branch.
pub fn fetch(root: &Path, credential: Option<GitCredential>) -> AppResult<RemoteDelta> {
    remote::fetch(root, credential)
}

/// Read the remote tip of the current branch without fetching. `url` probes
/// a remote other than `origin`.
pub fn remote_head(
    root: &Path,
    url: Option<&str>,
    credential: Option<GitCredential>,
) -> AppResult<RemoteTip> {
    remote::remote_head(root, url, credential)
}

/// Push the current branch to `origin`; rejections come back as data,
/// including the refusal to upload a history root the graph has not
/// accepted.
pub fn push(
    root: &Path,
    credential: Option<GitCredential>,
    accepted_roots: &[git2::Oid],
) -> AppResult<PushOutcome> {
    remote::push(root, credential, accepted_roots)
}

/// Commit every pending change (no-op when clean), never staging the
/// graph's local-only folders or changes to files at or above
/// `max_file_bytes`. See `commit_all` in `commit.rs`.
pub fn commit_all(
    root: &Path,
    message: &str,
    max_file_bytes: u64,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<CommitOutcome> {
    commit::commit_all(root, message, max_file_bytes, local_only)
}

/// The short id of the last commit that changed the note at `path` (a
/// canonical graph-relative note path), read from history alone; `None`
/// with no repository, no history, or a note HEAD does not hold.
pub fn note_version(root: &Path, path: &str) -> AppResult<Option<String>> {
    note_version::note_version(root, path)
}
