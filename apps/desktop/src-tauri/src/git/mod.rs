//! Git backup/sync primitives (Plan 12).
//!
//! Rust owns the *capabilities* — init/adopt, commit, fetch, merge, push —
//! while the sync **policy** (debounce cadence, retry loop, product states,
//! GitHub specifics) lives in `@reflect/core` `sync/`. Nothing here is
//! GitHub-specific: remotes are URLs, and an HTTPS sign-in arrives per call
//! as a [`GitCredential`] presented through a callback (never embedded in
//! the URL, so never on disk).
//!
//! All operations run on blocking threads (network fetches/pushes take
//! seconds) and are **generation-gated** like file writes: every command takes
//! the `generation` the frontend received when its graph was opened and
//! resolves the root through `crate::fs::root_for_generation`, which fails
//! when the active graph's generation has since moved (the user switched
//! graphs after the command was issued). A stale command errors loudly instead
//! of acting on the new graph, so commands never interleave across graphs.
//! The one exception is `git_clone`, which runs before any graph is open.

mod commit;
mod commit_message;
mod displace;
#[cfg(test)]
mod fault;
mod history_roots;
mod max_file_size;
mod merge;
mod note_version;
mod remote;
mod repo;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::blocking::run_blocking;

use crate::error::AppResult;
use crate::fs::GraphState;

use self::commit::CommitOutcome;
use self::merge::MergeOutcome;
use self::remote::{GitCredential, PushOutcome, RemoteDelta};

/// The open graph's accepted history roots, loaded at graph open
/// (`fs::activate`).
pub(crate) use self::history_roots::load_for_root as load_accepted_history_roots;
/// The settings key holding every graph's accepted history roots (Rust owns
/// it: `settings_save` keeps the copy on disk).
pub(crate) use self::history_roots::SETTINGS_KEY as ACCEPTED_HISTORY_ROOTS_SETTINGS_KEY;
/// The open graph's backup size limit, loaded at graph open (`fs::activate`).
pub(crate) use self::max_file_size::load_for_root as load_max_file_size;
/// The settings key holding every graph's backup size limit (Rust owns it:
/// `settings_save` keeps the copy on disk).
pub(crate) use self::max_file_size::SETTINGS_KEY as MAX_FILE_SIZE_SETTINGS_KEY;

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
    /// The repository state is not `Clean` — a merge/rebase the user started
    /// outside Reflect (e.g. via the git CLI) is in progress. Sync refuses to
    /// run until it is finished or aborted.
    pub in_progress: bool,
}

fn status(root: &Path) -> AppResult<GitStatus> {
    if !root.join(".git").exists() {
        return Ok(GitStatus {
            initialized: false,
            branch: None,
            remote_url: None,
            ahead: 0,
            behind: 0,
            in_progress: false,
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
        in_progress: repo.state() != git2::RepositoryState::Clean,
    })
}

/// Stop backing this graph up: drop the `origin` remote. The repository and
/// its history stay intact (reconnecting re-adds a remote); the machine-level
/// GitHub credential is untouched — other graphs keep syncing.
fn disconnect(root: &Path) -> AppResult<GitStatus> {
    let repo = repo::open_existing(root)?;
    if repo.find_remote("origin").is_ok() {
        repo.remote_delete("origin")?;
    }
    drop(repo);
    status(root)
}

fn setup(root: &Path, remote_url: Option<String>, branch: Option<String>) -> AppResult<GitStatus> {
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

/// Snapshot the backup repository (cheap, no network).
#[tauri::command]
pub async fn git_status(generation: u64, state: State<'_, GraphState>) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || status(&root)).await
}

/// Read the latest committed version of one graph-relative note, with no network.
#[tauri::command]
pub async fn git_note_version(
    path: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<Option<String>> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || note_version::note_version(&root, &path)).await
}

/// Initialize (or adopt) the graph's repository, optionally point `origin` at
/// `remote_url`, and align the local branch with `branch` (the remote's
/// default — fetch/merge/push must target the branch the backup repo actually
/// uses, e.g. an existing repo on `master` while fresh graphs init `main`).
/// Idempotent.
#[tauri::command]
pub async fn git_setup(
    remote_url: Option<String>,
    branch: Option<String>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || setup(&root, remote_url, branch)).await
}

/// Stop backing this graph up (drop `origin`; repo, history, and the
/// machine-level credential all stay).
#[tauri::command]
pub async fn git_disconnect(generation: u64, state: State<'_, GraphState>) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || disconnect(&root)).await
}

/// Clone a backup repository into `path` (restore on a fresh machine). Runs
/// before any graph is open, so it takes an absolute destination rather than
/// a graph-relative path; the caller opens the result as a graph afterwards.
#[tauri::command]
pub async fn git_clone(
    url: String,
    path: String,
    credential: Option<GitCredential>,
) -> AppResult<()> {
    run_blocking(move || remote::clone(&url, Path::new(&path), credential)).await
}

/// Commit every pending change (no-op when clean), never staging the graph's
/// local-only folders or changes to files at or above its backup size limit.
/// See [`commit::commit_all`].
#[tauri::command]
pub async fn git_commit_all(
    message: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<CommitOutcome> {
    let (root, local_only) = crate::fs::graph_for_sync(&state, generation)?;
    let max_file_bytes = crate::fs::backup_max_file_bytes(&state, generation)?
        .unwrap_or(max_file_size::DEFAULT_MAX_FILE_BYTES);
    let started = std::time::Instant::now();
    let outcome = run_blocking(move || {
        commit::commit_all(&root, &message, max_file_bytes, local_only.as_deref())
    })
    .await;
    if let Ok(outcome) = &outcome {
        tracing::info!(
            committed = outcome.committed,
            ahead = outcome.ahead,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "git_commit_all"
        );
    }
    outcome
}

/// Fetch `origin` and report ahead/behind for the current branch.
#[tauri::command]
pub async fn git_fetch(
    credential: Option<GitCredential>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<RemoteDelta> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || remote::fetch(&root, credential)).await
}

/// Broadcast fired for every entry a pull moved out of a path it wrote and
/// left moved, whether the pull succeeded or failed: every window's open
/// editor on `from` decides whether to follow it to `to`. Without it, an
/// editor holding the moved note would save it back over the other device's
/// file at `from`.
const NOTE_DISPLACED_EVENT: &str = "note:displaced";

/// The `note:displaced` payload.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteDisplaced<'a> {
    generation: u64,
    from: &'a str,
    to: &'a str,
    kept_out: bool,
}

/// Merge the fetched remote branch; conflicts are committed into the notes as
/// labeled markers (see [`merge`]). The repo is never left mid-merge, the
/// graph's local-only folders are never written, this device's uncommitted
/// entries in the pull's way move aside rather than being overwritten (see
/// [`displace`]), each announced on `note:displaced`, and a pull that would
/// join a history the graph has not accepted pauses instead (see
/// [`history_roots`]).
#[tauri::command]
pub async fn git_merge_remote<R: tauri::Runtime>(
    generation: u64,
    app: tauri::AppHandle<R>,
    state: State<'_, GraphState>,
) -> AppResult<MergeOutcome> {
    use tauri::Emitter;
    let (root, local_only) = crate::fs::graph_for_sync(&state, generation)?;
    let accepted = crate::fs::accepted_history_roots(&state, generation)?;
    let max_file_bytes = crate::fs::backup_max_file_bytes(&state, generation)?
        .unwrap_or(max_file_size::DEFAULT_MAX_FILE_BYTES);
    let (outcome, displaced) = run_blocking(move || {
        let policy = merge::PullPolicy {
            local_only: local_only.as_deref(),
            accepted_roots: &accepted,
            max_file_bytes,
        };
        let mut displaced = Vec::new();
        let outcome = merge::merge_remote(&root, &policy, &mut displaced);
        Ok((outcome, displaced))
    })
    .await?;
    let root = crate::fs::root_for_generation(&state, generation)?;
    // A failed merge can still have changed the source graph's working tree.
    crate::fs::invalidate_file_catalog(&state, &root);
    for file in &displaced {
        let payload = NoteDisplaced {
            generation,
            from: &file.from,
            to: &file.to,
            kept_out: file.kept_out,
        };
        if let Err(err) = app.emit(NOTE_DISPLACED_EVENT, payload) {
            tracing::warn!(?err, from = %file.from, "could not announce a displaced note");
        }
    }
    outcome
}

/// Push the current branch to `origin`; rejections come back as data so the
/// sync engine can branch on them, including the refusal to upload a history
/// the graph has not accepted (see [`history_roots`]).
#[tauri::command]
pub async fn git_push(
    credential: Option<GitCredential>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<PushOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    let accepted = crate::fs::accepted_history_roots(&state, generation)?;
    run_blocking(move || remote::push(&root, credential, &accepted)).await
}
