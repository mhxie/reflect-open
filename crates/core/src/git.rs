//! The git backup/sync commands: thin wrappers over [`reflect_git`].
//!
//! All operations run on blocking threads (network fetches/pushes take
//! seconds) and are **generation-gated** like file writes: every command takes
//! the `generation` the frontend received when its graph was opened and
//! resolves the root through `reflect_graph_io::root_for_generation`, which
//! fails when the active graph's generation has since moved. A stale command
//! errors loudly instead of acting on the new graph. The one exception is
//! `git_clone`, which runs before any graph is open.
//!
//! What a graph's backup may do is loaded with the graph (`fs::graph_open`):
//! its local-only folders, its backup size limit, and the history roots it
//! accepts (see [`settings`]). Sync refuses while the local-only folders are
//! unknown (`reflect_graph_io::graph_for_sync`).

mod settings;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use reflect_git::{CommitPolicy, MAX_FILE_BYTES, PullPolicy};
use reflect_graph_io::{
    GraphState, accepted_history_roots, backup_max_file_bytes, external_links, graph_for_sync,
    invalidate_file_catalog, root_for_generation, with_graph_lock,
};
use reflect_types::{
    AppResult, CommitOutcome, DisplacedFile, GitCredential, GitStatus, PullOutcome, PushOutcome,
    RemoteDelta, RemoteTip,
};
use serde::Serialize;

use crate::{Core, background_task};

/// The settings key holding every graph's backup size limit (Rust owns it:
/// `settings_save` keeps the copy on disk).
pub(crate) use self::settings::MAX_FILE_SIZE_SETTINGS_KEY;
/// The open graph's backup settings, loaded at graph open.
pub(crate) use self::settings::load_backup_settings;
/// The settings key holding every graph's accepted history roots (Rust owns
/// it: `settings_save` keeps the copy on disk).
pub(crate) use reflect_git::ACCEPTED_HISTORY_ROOTS_SETTINGS_KEY;

/// The `note:displaced` payload.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteDisplaced<'a> {
    generation: u64,
    from: &'a str,
    to: &'a str,
    kept_out: bool,
}

/// The open graph's backup size limit, or the default when the open loaded
/// none.
fn max_file_bytes(state: &GraphState, generation: u64) -> AppResult<u64> {
    Ok(backup_max_file_bytes(state, generation)?.unwrap_or(MAX_FILE_BYTES))
}

impl Core {
    /// Run a git operation on a blocking thread, retrying once after clearing
    /// a stale `.lock` file.
    async fn run_git<T, F>(&self, root: PathBuf, operation: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: Fn(&Path) -> AppResult<T> + Send + 'static,
    {
        self.spawn_blocking(move || reflect_git::run_with_lock_retry(&root, &operation))
            .await
    }

    /// Command: snapshot the backup repository (cheap, no network).
    pub async fn git_status(&self, generation: u64) -> AppResult<GitStatus> {
        let root = root_for_generation(&self.graph, generation)?;
        self.spawn_blocking(move || reflect_git::status(&root))
            .await
    }

    /// Command: the short id of the last commit that changed one
    /// graph-relative note, read from history alone (no network, no
    /// working-tree bytes).
    pub async fn git_note_version(
        &self,
        path: String,
        generation: u64,
    ) -> AppResult<Option<String>> {
        let root = root_for_generation(&self.graph, generation)?;
        self.spawn_blocking(move || reflect_git::note_version(&root, &path))
            .await
    }

    /// Command: initialize (or adopt) the graph's repository, optionally point
    /// `origin` at `remote_url`, and align the local branch with `branch` (the
    /// remote's default — fetch/merge/push must target the branch the backup
    /// repo actually uses, e.g. an existing repo on `master` while fresh
    /// graphs init `main`). Idempotent.
    pub async fn git_setup(
        &self,
        remote_url: Option<String>,
        branch: Option<String>,
        generation: u64,
    ) -> AppResult<GitStatus> {
        let root = root_for_generation(&self.graph, generation)?;
        self.run_git(root, move |root| {
            with_graph_lock(root, || {
                reflect_git::setup(root, remote_url.clone(), branch.clone())
            })
        })
        .await
    }

    /// Command: stop backing this graph up (drop `origin`; repo, history, and
    /// the machine-level credential all stay).
    pub async fn git_disconnect(&self, generation: u64) -> AppResult<GitStatus> {
        let root = root_for_generation(&self.graph, generation)?;
        self.run_git(root, |root| {
            with_graph_lock(root, || reflect_git::disconnect(root))
        })
        .await
    }

    /// Command: clone a backup repository into `path` (restore on a fresh
    /// machine). Runs before any graph is open, so it takes an absolute
    /// destination rather than a graph-relative path; the caller opens the
    /// result as a graph afterwards.
    pub async fn git_clone(
        &self,
        url: String,
        path: String,
        credential: Option<GitCredential>,
    ) -> AppResult<()> {
        self.spawn_blocking(move || reflect_git::clone(&url, Path::new(&path), credential))
            .await
    }

    /// Command: commit every pending change (no-op when clean), never staging
    /// the graph's local-only folders, links into its external storage, or
    /// changes to files at or above its backup size limit.
    pub async fn git_commit_all(
        &self,
        message: String,
        generation: u64,
    ) -> AppResult<CommitOutcome> {
        let (root, local_only) = graph_for_sync(&self.graph, generation)?;
        let max_file_bytes = max_file_bytes(&self.graph, generation)?;
        let external = external_links(&self.graph, generation)?;
        let started = std::time::Instant::now();
        let outcome = self
            .run_git(root, move |root| {
                let policy = CommitPolicy {
                    max_file_bytes,
                    local_only: local_only.as_deref(),
                    external: external.as_deref(),
                };
                reflect_git::commit_all(root, &message, &policy)
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

    /// Command: fetch `origin` and report ahead/behind for the current branch.
    pub async fn git_fetch(
        &self,
        credential: Option<GitCredential>,
        generation: u64,
    ) -> AppResult<RemoteDelta> {
        let root = root_for_generation(&self.graph, generation)?;
        self.run_git(root, move |root| {
            reflect_git::fetch(root, credential.clone())
        })
        .await
    }

    /// Command: read the remote tip of the current branch without fetching.
    /// `url` probes a remote other than `origin`.
    pub async fn git_remote_head(
        &self,
        url: Option<String>,
        credential: Option<GitCredential>,
        generation: u64,
    ) -> AppResult<RemoteTip> {
        let root = root_for_generation(&self.graph, generation)?;
        self.spawn_blocking(move || reflect_git::remote_head(&root, url.as_deref(), credential))
            .await
    }

    /// Command: commit local changes, then merge the fetched remote branch.
    /// The graph's local-only folders are never written (the other device's
    /// changes there come back as `frozenPaths`), this device's entries the
    /// commit withholds move aside rather than being overwritten, each
    /// announced on `note:displaced` whether the pull succeeded or failed, and
    /// a pull that would join a history the graph has not accepted pauses
    /// instead.
    pub async fn git_pull(&self, message: String, generation: u64) -> AppResult<PullOutcome> {
        let (root, local_only) = graph_for_sync(&self.graph, generation)?;
        let accepted_roots = accepted_history_roots(&self.graph, generation)?;
        let max_file_bytes = max_file_bytes(&self.graph, generation)?;
        let external = external_links(&self.graph, generation)?;
        // Every attempt's moves, the stale-lock retry included.
        let displaced: Arc<Mutex<Vec<DisplacedFile>>> = Arc::default();
        let sink = Arc::clone(&displaced);
        let outcome = self
            .run_git(root, move |root| {
                let policy = PullPolicy {
                    local_only: local_only.as_deref(),
                    accepted_roots: &accepted_roots,
                    max_file_bytes,
                    external: external.as_deref(),
                };
                // A retry carries the earlier attempt's moves back in, so the
                // graph's record of displaced revisions covers every move
                // announced below.
                let mut moved =
                    std::mem::take(&mut *sink.lock().unwrap_or_else(PoisonError::into_inner));
                let pulled = reflect_git::pull_all(root, &message, &policy, &mut moved);
                *sink.lock().unwrap_or_else(PoisonError::into_inner) = moved;
                pulled
            })
            .await;
        // Invalidate on both arms: a failed pull can leave the tree half written.
        // A pull the user switched graphs away from announces nothing into the
        // new session.
        let root = root_for_generation(&self.graph, generation)?;
        invalidate_file_catalog(&self.graph, &root);
        let displaced =
            std::mem::take(&mut *displaced.lock().unwrap_or_else(PoisonError::into_inner));
        for file in &displaced {
            let payload = NoteDisplaced {
                generation,
                from: &file.from,
                to: &file.to,
                kept_out: file.kept_out,
            };
            match serde_json::to_value(payload) {
                Ok(payload) => self.host().emit(
                    reflect_types::events::EventName::NoteDisplaced.as_str(),
                    payload,
                ),
                Err(err) => {
                    tracing::warn!(?err, from = %file.from, "could not announce a displaced note")
                }
            }
        }
        if outcome.is_ok() {
            self.git_maintain(root).await;
        }
        outcome
    }

    /// Repack the repository when it crosses the `git gc --auto` thresholds,
    /// after a pull: the cycle's fetch is done and its push has not started.
    /// A failure only skips this repack.
    ///
    /// The first repack of a long-used repository can take a minute, and it
    /// owns no file lock, so its assertion may expire: iOS then suspends the
    /// repack, and it goes on when the app resumes.
    async fn git_maintain(&self, root: PathBuf) {
        let _background_task =
            background_task::expiring(&self.background_tasks, "Reflect git maintenance");
        let started = std::time::Instant::now();
        match self
            .spawn_blocking(move || reflect_git::maintain(&root))
            .await
        {
            Ok(None) => {}
            Ok(Some(repack)) => tracing::info!(
                objects = repack.objects,
                removed_packs = repack.removed_packs,
                removed_loose_objects = repack.removed_loose_objects,
                elapsed_ms = started.elapsed().as_millis() as u64,
                "git_maintain"
            ),
            Err(err) => tracing::warn!(error = err.message(), "git repack failed"),
        }
    }

    /// Command: push the current branch to `origin`; rejections come back as
    /// data so the sync engine can branch on them, including the refusal to
    /// upload a history the graph has not accepted.
    pub async fn git_push(
        &self,
        credential: Option<GitCredential>,
        generation: u64,
    ) -> AppResult<PushOutcome> {
        let root = root_for_generation(&self.graph, generation)?;
        let accepted_roots = accepted_history_roots(&self.graph, generation)?;
        self.run_git(root, move |root| {
            reflect_git::push(root, credential.clone(), &accepted_roots)
        })
        .await
    }
}

#[cfg(test)]
mod tests;
