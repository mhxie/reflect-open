//! The git backup/sync commands: thin Tauri wrappers over [`reflect_git`].
//!
//! All operations run on blocking threads (network fetches/pushes take
//! seconds) and are **generation-gated** like file writes: every command takes
//! the `generation` the frontend received when its graph was opened and
//! resolves the root through `crate::fs::root_for_generation`, which fails
//! when the active graph's generation has since moved. A stale command errors
//! loudly instead of acting on the new graph. The one exception is
//! `git_clone`, which runs before any graph is open.
//!
//! What a graph's backup may do is loaded with the graph (`fs::graph_open`):
//! its local-only folders, its backup size limit, and the history roots it
//! accepts (see [`settings`]). Sync refuses while the local-only folders are
//! unknown (`fs::graph_for_sync`).

mod settings;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;
use tauri::State;

use reflect_git::{
    CommitOutcome, DisplacedFile, GitCredential, GitStatus, MAX_FILE_BYTES, PullOutcome,
    PullPolicy, PushOutcome, RemoteDelta, RemoteTip,
};

use crate::blocking::run_blocking;
use crate::error::AppResult;
use crate::fs::GraphState;

/// The settings key holding every graph's backup size limit (Rust owns it:
/// `settings_save` keeps the copy on disk).
pub(crate) use self::settings::MAX_FILE_SIZE_SETTINGS_KEY;
/// The open graph's backup settings, loaded at graph open.
pub(crate) use self::settings::load_backup_settings;
/// The settings key holding every graph's accepted history roots (Rust owns
/// it: `settings_save` keeps the copy on disk).
pub(crate) use reflect_git::ACCEPTED_HISTORY_ROOTS_SETTINGS_KEY;

/// Run a git operation on a blocking thread, retrying once after clearing a
/// stale `.lock` file.
async fn run_git<T, F>(root: PathBuf, operation: F) -> AppResult<T>
where
    T: Send + 'static,
    F: Fn(&Path) -> AppResult<T> + Send + 'static,
{
    run_blocking(move || reflect_git::run_with_lock_retry(&root, &operation)).await
}

/// Snapshot the backup repository (cheap, no network).
#[tauri::command]
pub async fn git_status(generation: u64, state: State<'_, GraphState>) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || reflect_git::status(&root)).await
}

/// The short id of the last commit that changed one graph-relative note,
/// read from history alone (no network, no working-tree bytes).
#[tauri::command]
pub async fn git_note_version(
    path: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<Option<String>> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || reflect_git::note_version(&root, &path)).await
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
    run_git(root, move |root| {
        crate::fs::with_graph_lock(root, || {
            reflect_git::setup(root, remote_url.clone(), branch.clone())
        })
    })
    .await
}

/// Stop backing this graph up (drop `origin`; repo, history, and the
/// machine-level credential all stay).
#[tauri::command]
pub async fn git_disconnect(generation: u64, state: State<'_, GraphState>) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_git(root, |root| {
        crate::fs::with_graph_lock(root, || reflect_git::disconnect(root))
    })
    .await
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
    run_blocking(move || reflect_git::clone(&url, Path::new(&path), credential)).await
}

/// Commit every pending change (no-op when clean), never staging the graph's
/// local-only folders or changes to files at or above its backup size limit.
#[tauri::command]
pub async fn git_commit_all(
    message: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<CommitOutcome> {
    let (root, local_only) = crate::fs::graph_for_sync(&state, generation)?;
    let max_file_bytes = max_file_bytes(&state, generation)?;
    let started = std::time::Instant::now();
    let outcome = run_git(root, move |root| {
        reflect_git::commit_all(root, &message, max_file_bytes, local_only.as_deref())
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
    run_git(root, move |root| {
        reflect_git::fetch(root, credential.clone())
    })
    .await
}

/// Read the remote tip of the current branch without fetching.
#[tauri::command]
pub async fn git_remote_head(
    credential: Option<GitCredential>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<RemoteTip> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || reflect_git::remote_head(&root, credential)).await
}

/// The `note:displaced` payload.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteDisplaced<'a> {
    generation: u64,
    from: &'a str,
    to: &'a str,
    kept_out: bool,
}

/// Commit local changes, then merge the fetched remote branch. The graph's
/// local-only folders are never written (the other device's changes there
/// come back as `frozenPaths`), this device's entries the commit withholds
/// move aside rather than being overwritten, each announced on
/// `note:displaced` whether the pull succeeded or failed, and a pull that
/// would join a history the graph has not accepted pauses instead.
#[tauri::command]
pub async fn git_pull<R: tauri::Runtime>(
    message: String,
    generation: u64,
    app: tauri::AppHandle<R>,
    state: State<'_, GraphState>,
) -> AppResult<PullOutcome> {
    use tauri::Emitter;
    let (root, local_only) = crate::fs::graph_for_sync(&state, generation)?;
    let accepted_roots = crate::fs::accepted_history_roots(&state, generation)?;
    let max_file_bytes = max_file_bytes(&state, generation)?;
    // Every attempt's moves, the stale-lock retry included.
    let displaced: Arc<Mutex<Vec<DisplacedFile>>> = Arc::default();
    let sink = Arc::clone(&displaced);
    let outcome = run_git(root, move |root| {
        let policy = PullPolicy {
            local_only: local_only.as_deref(),
            accepted_roots: &accepted_roots,
            max_file_bytes,
        };
        // A retry carries the earlier attempt's moves back in, so the graph's
        // record of displaced revisions covers every move announced below.
        let mut moved = std::mem::take(&mut *sink.lock().unwrap_or_else(PoisonError::into_inner));
        let pulled = reflect_git::pull_all(root, &message, &policy, &mut moved);
        *sink.lock().unwrap_or_else(PoisonError::into_inner) = moved;
        pulled
    })
    .await;
    // Invalidate on both arms: a failed pull can leave the tree half written.
    // A pull the user switched graphs away from announces nothing into the
    // new session.
    let root = crate::fs::root_for_generation(&state, generation)?;
    crate::fs::invalidate_file_catalog(&state, &root);
    let displaced = std::mem::take(&mut *displaced.lock().unwrap_or_else(PoisonError::into_inner));
    for file in &displaced {
        let payload = NoteDisplaced {
            generation,
            from: &file.from,
            to: &file.to,
            kept_out: file.kept_out,
        };
        if let Err(err) = app.emit(reflect_types::events::NOTE_DISPLACED, payload) {
            tracing::warn!(?err, from = %file.from, "could not announce a displaced note");
        }
    }
    outcome
}

/// Push the current branch to `origin`; rejections come back as data so the
/// sync engine can branch on them, including the refusal to upload a history
/// the graph has not accepted.
#[tauri::command]
pub async fn git_push(
    credential: Option<GitCredential>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<PushOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    let accepted_roots = crate::fs::accepted_history_roots(&state, generation)?;
    run_git(root, move |root| {
        reflect_git::push(root, credential.clone(), &accepted_roots)
    })
    .await
}

/// The open graph's backup size limit, or the default when the open loaded
/// none.
fn max_file_bytes(state: &GraphState, generation: u64) -> AppResult<u64> {
    Ok(crate::fs::backup_max_file_bytes(state, generation)?.unwrap_or(MAX_FILE_BYTES))
}

#[cfg(test)]
mod tests;
