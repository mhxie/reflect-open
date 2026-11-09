//! Pull-side merge: fast-forward when possible, otherwise a true merge.
//!
//! The merge is computed, resolved and committed in memory, then checked out;
//! the branch ref moves last, so a stop at any step leaves a state the next
//! pull converges from. The repository never enters libgit2's merge state.
//! Pulls never write conflict markers.
//!
//! **Uncommitted bytes are never overwritten.** Before the checkout writes
//! any path, this device's entries in its way that no commit holds (an
//! oversized edit the commit withheld, an untracked or ignored file) move out
//! of the way to `name (this device).ext` (see `displace`), under the graph
//! lock the commit took. A save that raced the cycle's commit defers the pull
//! instead ([`MergeKind::Deferred`]): the engine commits and pulls again. A
//! pull that fails after entries moved puts them back where it can, and every
//! entry that stays moved is reported, on success and on failure alike.
//!
//! **Separate histories pause.** Before anything is analyzed or written, a
//! pull whose incoming commits include a history root the graph has not
//! accepted pauses sync (see `history_roots`), and so does one whose incoming
//! tree holds a path Reflect never writes (see `paths`).
//!
//! **Local-only folders are frozen.** No merge or fast-forward ever creates,
//! writes, or deletes a path that is, or that the filesystem resolves into, a
//! local-only folder (or out of the graph). Each such folder moves as one
//! unit, so a type change (a link becoming a folder upstream) is one entry's
//! change. The checkout leaves the units alone; a diverged merge runs against
//! a stand-in for the remote whose units hold this device's version. Where
//! this device's history already tracks a unit, the repository still follows
//! the other device: HEAD and the index take its version of the unit, so
//! history keeps it and the next commit stays clean, while this device's
//! files are never touched; each skipped change is reported in
//! [`MergeOutcome::frozen_paths`]. A pull that would start tracking a unit
//! this device's history does not track pauses instead (commits never add,
//! update, or delete a local-only entry, so the unit would stay in every
//! later backup), and so does a remote change that would replace a
//! working-tree folder holding a local-only folder with a file. Both
//! refusals come before anything is written.

use std::fs;
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, IndexTime, MergeOptions, Repository};
use reflect_graph_paths::{ExternalLinks, LocalOnlyFolders, to_slash_lossy};
use serde::Serialize;

use reflect_graph_io::conflict::copy::{free_conflict_copy_path, utc_stamp};
use reflect_graph_io::conflict::ladder::{self, ConflictInput};
use reflect_graph_io::conflict::merge3;
use reflect_graph_io::conflict::{ConflictSide, Resolution};
use reflect_types::{AppError, AppResult};

use super::displace::{DisplacedFile, Displacement, Moves, displace};
use super::history_roots::ensure_pull_accepted;
use super::paths::ensure_writable_path;
use super::repo::{
    branch_tip_ahead_of_detached_head, clear_foreign_state, current_branch, open_existing,
    reattach_head, signature, stage0_entry,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    UpToDate,
    FastForward,
    Merged,
    /// A save raced the cycle's commit: a tracked, public file changed at a
    /// path the pull writes. Nothing was written; the engine commits and
    /// pulls again.
    Deferred,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Upsert,
    Remove,
}

/// One working-tree file a merge/fast-forward rewrote, in the same shape as
/// the watcher's `FileChange` so the caller can reindex directly.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub kind: ChangeKind,
    /// Last-modified time of the written file (epoch ms; upserts only).
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub kind: MergeKind,
    /// Graph-relative paths of the conflict copies this merge wrote.
    pub review_paths: Vec<String>,
    /// Every file this merge changed on disk, for the caller to reindex.
    pub changed_files: Vec<ChangedFile>,
    /// The other device's changes inside this device's local-only folders:
    /// recorded in history, never written here. The sync layer warns.
    pub frozen_paths: Vec<String>,
    /// This device's entries the pull moved out of the paths it wrote, and
    /// where each went. Each new path is an upsert in `changed_files` too.
    /// The sync layer warns and open editors follow.
    pub displaced: Vec<DisplacedFile>,
}

impl MergeOutcome {
    /// An outcome that wrote nothing.
    fn nothing(kind: MergeKind) -> Self {
        MergeOutcome {
            kind,
            review_paths: Vec::new(),
            changed_files: Vec::new(),
            frozen_paths: Vec::new(),
            displaced: Vec::new(),
        }
    }

    fn up_to_date() -> Self {
        Self::nothing(MergeKind::UpToDate)
    }

    /// This outcome followed by `next`, in the order the files changed.
    fn then(mut self, next: MergeOutcome) -> Self {
        self.review_paths.extend(next.review_paths);
        self.changed_files.extend(next.changed_files);
        self.frozen_paths.extend(next.frozen_paths);
        self.displaced.extend(next.displaced);
        if !matches!(next.kind, MergeKind::UpToDate) {
            self.kind = next.kind;
        }
        self
    }
}

/// What a pull may do in one graph.
#[derive(Clone, Copy, Debug)]
pub struct PullPolicy<'a> {
    /// The graph's local-only folders, never written by a pull.
    pub local_only: Option<&'a LocalOnlyFolders>,
    /// The history roots the graph accepts (see `history_roots`).
    pub accepted_roots: &'a [git2::Oid],
    /// The backup size limit: a merged text at or above it is never
    /// committed (history keeps this device's version and the merged text
    /// stays on disk, an edit every later commit withholds and reports).
    pub max_file_bytes: u64,
    /// The folders the graph's external storage has used: links into them
    /// are never committed, and a pull writing a file where one stands parks
    /// the link (the folder keeps its copy).
    pub external: Option<&'a ExternalLinks>,
}

impl<'a> PullPolicy<'a> {
    /// What the pull's own commit may stage.
    pub(super) fn commit(&self) -> super::CommitPolicy<'a> {
        super::CommitPolicy {
            max_file_bytes: self.max_file_bytes,
            local_only: self.local_only,
            external: self.external,
        }
    }
}

impl Default for PullPolicy<'_> {
    fn default() -> Self {
        Self {
            local_only: None,
            accepted_roots: &[],
            max_file_bytes: super::MAX_FILE_BYTES,
            external: None,
        }
    }
}

/// Merge the fetched `origin/<branch>` into the local branch. The caller
/// holds the graph lock. `displaced` receives every entry the pull moved and
/// left moved, whatever the result, for the caller to announce.
pub(super) fn merge_locked(
    root: &Path,
    policy: &PullPolicy<'_>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<MergeOutcome> {
    let repo = open_existing(root)?;
    clear_foreign_state(&repo)?;
    let local = merge_branch_into_detached_head(&repo, root, policy, displaced)?;
    if matches!(local.kind, MergeKind::Deferred) {
        return Ok(local);
    }
    let remote = pull(&repo, root, policy, displaced)?;
    Ok(local.then(remote))
}

/// Merge the backup branch into a detached HEAD that is behind it, then
/// attach HEAD to the branch, so the branch only ever moves forward. A
/// deferred merge leaves HEAD detached: the branch is still ahead of it.
fn merge_branch_into_detached_head(
    repo: &Repository,
    root: &Path,
    policy: &PullPolicy<'_>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<MergeOutcome> {
    let outcome = match branch_tip_ahead_of_detached_head(repo)? {
        Some(tip) => merge_into_head(
            repo,
            root,
            tip,
            "Merge the backup branch into the checked-out commit",
            policy,
            displaced,
        )?,
        None => MergeOutcome::up_to_date(),
    };
    reattach_head(repo)?;
    Ok(outcome)
}

#[cfg(test)]
pub(super) fn merge_remote(root: &Path) -> AppResult<MergeOutcome> {
    merge_remote_with(root, &PullPolicy::default())
}

#[cfg(test)]
pub(super) fn merge_remote_with(root: &Path, policy: &PullPolicy<'_>) -> AppResult<MergeOutcome> {
    merge_remote_displacing(root, policy).0
}

/// [`merge_remote_with`] that also returns every entry the pull left moved,
/// on success and on failure alike.
#[cfg(test)]
pub(super) fn merge_remote_displacing(
    root: &Path,
    policy: &PullPolicy<'_>,
) -> (AppResult<MergeOutcome>, Vec<DisplacedFile>) {
    let mut displaced = Vec::new();
    let merged =
        reflect_graph_io::with_graph_lock(root, || merge_locked(root, policy, &mut displaced));
    (merged, displaced)
}

/// Check out `tree` over a working tree whose write set displacement cleared,
/// leaving the runtime directory and the frozen `units` alone. The checkout
/// is safe: external writers do not hold the graph lock, so one that lands
/// after the displacement scan is refused rather than overwritten.
fn checkout_target(repo: &Repository, tree: &git2::Tree<'_>, units: &[String]) -> AppResult<()> {
    // The first matching pathspec wins, so the exclusions come before `*`.
    let mut checkout = CheckoutBuilder::new();
    checkout.safe().path("!.reflect");
    for path in units {
        checkout.path(format!("!{path}"));
    }
    checkout.path("*");
    repo.checkout_tree(tree.as_object(), Some(&mut checkout))?;
    Ok(())
}

/// Finish what a displacement started: on success drop the parked entries
/// and report the copies (also through `displaced`); on failure put back
/// what can go back and report the rest through `displaced`.
fn settle<T>(
    moves: Moves,
    landed: AppResult<T>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<(T, Vec<DisplacedFile>)> {
    match landed {
        Ok(value) => {
            let copies = moves.finish();
            displaced.extend(copies.iter().cloned());
            Ok((value, copies))
        }
        Err(err) => {
            displaced.extend(moves.undo());
            Err(err)
        }
    }
}

/// The copies a settled displacement reported, as upserts to reindex.
fn upserts(copies: &[DisplacedFile]) -> Vec<ChangedFile> {
    copies
        .iter()
        .map(|copy| ChangedFile {
            path: copy.to.clone(),
            kind: ChangeKind::Upsert,
            modified_ms: None,
        })
        .collect()
}

fn pull(
    repo: &Repository,
    root: &Path,
    policy: &PullPolicy<'_>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<MergeOutcome> {
    let branch = current_branch(repo)?;
    let Ok(remote_oid) = repo.refname_to_id(&format!("refs/remotes/origin/{branch}")) else {
        // A new backup repo has no remote branch until the first push.
        return Ok(MergeOutcome::up_to_date());
    };
    let head_oid = repo.head().ok().and_then(|head| head.target());
    if let Some(head_oid) = head_oid {
        ensure_pull_accepted(repo, root, head_oid, remote_oid, policy.accepted_roots)?;
    }
    ensure_incoming_paths_writable(repo, head_oid, remote_oid)?;
    merge_into_head(
        repo,
        root,
        remote_oid,
        "Merge changes from other devices",
        policy,
        displaced,
    )
}

/// Refuse, before anything is written, a remote tree that changes a path
/// Reflect never writes ([`ensure_writable_path`], on the raw tree bytes):
/// libgit2 checks names only at checkout, and knows nothing of `.reflect`
/// spellings the volume folds onto it. Only the other device's changes are
/// checked (since the merge base, or every path with no base): a path only
/// this device committed is never written by the pull.
fn ensure_incoming_paths_writable(
    repo: &Repository,
    head_oid: Option<git2::Oid>,
    remote_oid: git2::Oid,
) -> AppResult<()> {
    let base_tree = match head_oid.map(|head| repo.merge_base(head, remote_oid)) {
        Some(Ok(base)) => Some(repo.find_commit(base)?.tree()?),
        _ => None,
    };
    let remote_tree = repo.find_commit(remote_oid)?.tree()?;
    let diff = repo.diff_tree_to_tree(base_tree.as_ref(), Some(&remote_tree), None)?;
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(bytes) = file.path_bytes() {
                ensure_writable_path(bytes)?;
            }
        }
    }
    Ok(())
}

/// Merge `theirs_oid` into HEAD: fast-forward when possible, otherwise an
/// in-memory three-way merge. Before the checkout writes its paths,
/// displacement moves this device's uncommitted entries out of their way. The
/// ref HEAD names moves last; a detached HEAD moves itself.
fn merge_into_head(
    repo: &Repository,
    root: &Path,
    theirs_oid: git2::Oid,
    message: &str,
    policy: &PullPolicy<'_>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<MergeOutcome> {
    let refname = repo
        .find_reference("HEAD")?
        .symbolic_target()?
        .unwrap_or("HEAD")
        .to_string();
    let annotated = repo.find_annotated_commit(theirs_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome::up_to_date());
    }

    if analysis.is_unborn() || analysis.is_fast_forward() {
        let old_oid = repo.head().ok().and_then(|head| head.target());
        let old_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        let new_tree = repo.find_commit(theirs_oid)?.tree()?;
        let plan = plan_pull(
            root,
            policy.local_only,
            changed_between(repo, old_tree.as_ref(), &new_tree)?,
        );
        if let Some(folders) = policy.local_only {
            if let Some(old_tree) = &old_tree {
                ensure_units_already_tracked(old_tree, &plan.units)?;
            }
            ensure_no_folder_replaced(
                root,
                folders,
                plan.allowed.iter().map(|change| change.path.as_str()),
            )?;
        }
        let moves = match displace(repo, root, &plan.allowed, &new_tree, policy, displaced)? {
            Displacement::Ready(moves) => moves,
            Displacement::Deferred => return Ok(MergeOutcome::nothing(MergeKind::Deferred)),
        };
        let landed = seam::after_displacement().and_then(|()| {
            #[cfg(test)]
            super::fault::trip(super::fault::FaultPoint::BeforeFastForwardCheckout)?;
            checkout_target(repo, &new_tree, &plan.units)?;
            follow_units_in_index(repo, &new_tree, &plan.units)?;
            #[cfg(test)]
            super::fault::trip(super::fault::FaultPoint::BeforeFastForwardRefMove)?;
            let message = "reflect sync: fast-forward";
            match old_oid {
                // Guarded: the branch must still be where this pull started.
                Some(old_oid) => {
                    repo.reference_matching(&refname, theirs_oid, true, old_oid, message)?
                }
                None => repo.reference(&refname, theirs_oid, true, message)?,
            };
            // No `set_head`: a stale `HEAD.lock` must not fail a pull.
            Ok(())
        });
        let ((), copies) = settle(moves, landed, displaced)?;
        let mut changed_files = plan.allowed;
        changed_files.extend(upserts(&copies));
        stamp_modified_times(root, &mut changed_files);
        return Ok(MergeOutcome {
            kind: MergeKind::FastForward,
            review_paths: Vec::new(),
            changed_files,
            frozen_paths: plan.frozen,
            displaced: copies,
        });
    }

    let ours = repo.head()?.peel_to_commit()?;
    let head_oid = ours.id();
    let theirs = repo.find_commit(theirs_oid)?;
    let ours_tree = ours.tree()?;
    let theirs_tree = theirs.tree()?;
    let frozen = match policy.local_only {
        Some(folders) => FrozenMerge::plan(repo, root, folders, &ours, &theirs)?,
        None => FrozenMerge::default(),
    };
    // The merge runs against a stand-in whose held units carry this
    // device's version, so it never writes or checks them.
    let stand_in = if frozen.held.is_empty() {
        None
    } else {
        Some(repo.find_commit(remote_without(repo, &theirs, &frozen.held)?)?)
    };
    let merged_with = stand_in.as_ref().unwrap_or(&theirs);
    let mut index = repo.merge_commits(&ours, merged_with, Some(&MergeOptions::new()))?;
    let resolved = resolve_index_conflicts(repo, root, &mut index, &ours, &theirs, policy)?;
    // Held units merged as this device's version; where the other device
    // changed one (`followed`), history takes its version instead.
    follow_tree_in_index(repo, &mut index, &theirs_tree, &frozen.followed)?;
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::BeforeMergeCommit)?;

    let tree = repo.find_tree(index.write_tree_to(repo)?)?;
    let sig = signature(repo)?;
    let message = if resolved.review_paths.is_empty() {
        message.to_string()
    } else {
        format!("{message} (files to review)")
    };
    let merge_oid = repo.commit(None, &sig, &sig, &message, &tree, &[&ours, &theirs])?;
    let mut changed_files = changed_between(repo, Some(&ours_tree), &tree)?;
    changed_files.retain(|change| !under_any(&frozen.held, &change.path));

    // The write set: what the checkout writes, plus each oversized merged
    // text, which lands over this device's version after it.
    let mut writes = changed_files.clone();
    for (path, _) in &resolved.oversized {
        if !writes.iter().any(|write| write.path == *path) {
            writes.push(ChangedFile {
                path: path.clone(),
                kind: ChangeKind::Upsert,
                modified_ms: None,
            });
        }
    }
    let moves = match displace(repo, root, &writes, &tree, policy, displaced)? {
        Displacement::Ready(moves) => moves,
        // The merge commit stays dangling; the next pull makes another.
        Displacement::Deferred => return Ok(MergeOutcome::nothing(MergeKind::Deferred)),
    };
    let landed = seam::after_displacement().and_then(|()| {
        #[cfg(test)]
        super::fault::trip(super::fault::FaultPoint::AfterMergeCommitBeforeCheckout)?;
        checkout_target(repo, &tree, &frozen.held)?;
        follow_units_in_index(repo, &tree, &frozen.followed)?;
        write_oversized_merges(root, &resolved.oversized, &mut changed_files)?;
        #[cfg(test)]
        super::fault::trip(super::fault::FaultPoint::BeforeMergeRefMove)?;
        repo.reference_matching(&refname, merge_oid, true, head_oid, &message)?;
        Ok(())
    });
    let ((), copies) = settle(moves, landed, displaced)?;
    changed_files.extend(upserts(&copies));
    stamp_modified_times(root, &mut changed_files);

    let frozen_paths = if frozen.followed.is_empty() {
        Vec::new()
    } else {
        changed_between(repo, Some(&ours_tree), &theirs_tree)?
            .into_iter()
            .map(|change| change.path)
            .filter(|path| under_any(&frozen.followed, path))
            .collect()
    };
    Ok(MergeOutcome {
        kind: MergeKind::Merged,
        review_paths: resolved.review_paths,
        changed_files,
        frozen_paths,
        displaced: copies,
    })
}

/// Resolve a note conflict of the in-memory merge through the ladder. Both
/// sides are commit blobs, so their commit times order them on every device.
fn merge_note(
    base: Option<&[u8]>,
    ours: (&[u8], &git2::Commit<'_>),
    theirs: (&[u8], &git2::Commit<'_>),
) -> AppResult<Vec<u8>> {
    let ours_side = text_side(ours.0, commit_ms(ours.1))?;
    let theirs_side = text_side(theirs.0, commit_ms(theirs.1))?;
    let base = base.map(text_of).transpose()?;
    let content = match ladder::resolve(ConflictInput {
        base,
        sides: (ours_side, theirs_side),
        merge_loop_detected: false,
    })? {
        Resolution::AlreadyResolved => return Ok(ours.0.to_vec()),
        Resolution::Merged { content } | Resolution::Reconciled { content } => content,
    };
    Ok(content.into_bytes())
}

fn text_of(bytes: &[u8]) -> AppResult<&str> {
    std::str::from_utf8(bytes).map_err(|_| AppError::io("a text side is not UTF-8"))
}

fn text_side(bytes: &[u8], modified_ms: u64) -> AppResult<ConflictSide> {
    Ok(ConflictSide {
        content: text_of(bytes)?.to_string(),
        modified_ms,
    })
}

fn commit_ms(commit: &git2::Commit<'_>) -> u64 {
    commit.time().seconds().max(0) as u64 * 1000
}

/// Diff two trees into the watcher's change shape.
fn changed_between(
    repo: &Repository,
    old: Option<&git2::Tree>,
    new: &git2::Tree,
) -> AppResult<Vec<ChangedFile>> {
    let diff = repo.diff_tree_to_tree(old, Some(new), None)?;
    let mut out = Vec::new();
    for delta in diff.deltas() {
        let removed = delta.status() == git2::Delta::Deleted;
        let file = if removed {
            delta.old_file()
        } else {
            delta.new_file()
        };
        if let Some(path) = file.path() {
            let path = to_slash_lossy(path);
            if path.starts_with(".reflect/") {
                continue;
            }
            out.push(ChangedFile {
                path,
                kind: if removed {
                    ChangeKind::Remove
                } else {
                    ChangeKind::Upsert
                },
                modified_ms: None,
            });
        }
    }
    Ok(out)
}

/// Fill `modified_ms` for upserts from the working-tree files.
fn stamp_modified_times(root: &Path, changes: &mut [ChangedFile]) {
    for change in changes {
        if matches!(change.kind, ChangeKind::Remove) {
            continue;
        }
        let abs = root.join(&change.path);
        if let Ok(bytes) = std::fs::read(&abs) {
            reflect_graph_io::own_writes::record(root, &change.path, &bytes);
        }
        change.modified_ms = abs
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64);
    }
}

/// What resolving a merge index's conflicts left to do.
#[derive(Default)]
struct Resolved {
    /// The conflict copy paths.
    review_paths: Vec<String>,
    /// Merged texts at or above the backup size limit: the index keeps this
    /// device's version, and the merged text lands on disk after the
    /// checkout.
    oversized: Vec<(String, Vec<u8>)>,
}

/// Resolve every conflict of an in-memory merge index:
///
/// - **edit vs delete**: keep the edited version, never silently delete;
/// - **deleted on both**: confirm the removal;
/// - **note (`.md`)**: the ladder's merged text;
/// - **other text**: the three-way merge when it is clean;
/// - **anything else** (binary, symlink, an unclean text merge): keep ours at
///   the path and the other device's version beside it as
///   `name (conflict <stamp> <hash8>).ext`;
/// - **submodule**: keep ours.
///
/// A merged text at or above the backup size limit is never committed: the
/// index keeps ours (the other device's version is the merge's second
/// parent) and the merged text is reported in [`Resolved::oversized`].
fn resolve_index_conflicts(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
    ours: &git2::Commit<'_>,
    theirs: &git2::Commit<'_>,
    policy: &PullPolicy<'_>,
) -> AppResult<Resolved> {
    let mut resolved = Resolved::default();
    if !index.has_conflicts() {
        return Ok(resolved);
    }
    let stamp = utc_stamp(theirs.time().seconds());
    let conflicts = index.conflicts()?.collect::<Result<Vec<_>, _>>()?;

    let review = &mut resolved.review_paths;
    for conflict in conflicts {
        let mut paths: Vec<String> = [&conflict.ancestor, &conflict.our, &conflict.their]
            .into_iter()
            .flatten()
            .map(entry_path)
            .collect();
        paths.sort();
        paths.dedup();
        for path in &paths {
            index.conflict_remove(Path::new(path))?;
        }
        match (conflict.our, conflict.their) {
            (Some(our), Some(their)) => {
                let path = entry_path(&our);
                if our.mode == GITLINK_MODE || their.mode == GITLINK_MODE {
                    add_resolved_unreviewed(index, root, &stamp, &path, our.id, our.mode, review)?;
                    continue;
                }
                let plain = our.mode != SYMLINK_MODE && their.mode != SYMLINK_MODE;
                let our_blob = repo.find_blob(our.id)?;
                let their_blob = repo.find_blob(their.id)?;
                let ancestor_blob = match &conflict.ancestor {
                    Some(ancestor) if ancestor.mode != GITLINK_MODE => {
                        Some(repo.find_blob(ancestor.id)?)
                    }
                    _ => None,
                };
                let all_text = plain
                    && is_text(&our_blob)
                    && is_text(&their_blob)
                    && ancestor_blob.as_ref().is_none_or(is_text);
                let base = ancestor_blob.as_ref().map(|blob| blob.content());
                let merged = if !all_text {
                    None
                } else if reflect_graph_paths::is_note(&path) {
                    Some(merge_note(
                        base,
                        (our_blob.content(), ours),
                        (their_blob.content(), theirs),
                    )?)
                } else {
                    let ours_side = text_side(our_blob.content(), commit_ms(ours))?;
                    let theirs_side = text_side(their_blob.content(), commit_ms(theirs))?;
                    merge3::diff3(
                        base.map(text_of).transpose()?.unwrap_or(""),
                        &ours_side,
                        &theirs_side,
                    )?
                    .map(String::into_bytes)
                };
                match merged {
                    Some(merged) if merged.len() as u64 >= policy.max_file_bytes => {
                        add_resolved_unreviewed(
                            index, root, &stamp, &path, our.id, our.mode, review,
                        )?;
                        resolved.oversized.push((path, merged));
                    }
                    Some(merged) => {
                        let id = repo.blob(&merged)?;
                        add_resolved_unreviewed(index, root, &stamp, &path, id, our.mode, review)?;
                    }
                    None => {
                        add_resolved_unreviewed(
                            index, root, &stamp, &path, our.id, our.mode, review,
                        )?;
                        let copy = free_conflict_copy_path(
                            &path,
                            &stamp,
                            &their.id.to_string()[..8],
                            |path| match index.get_path(Path::new(path), 0) {
                                // A crashed merge may have committed this copy already.
                                Some(entry) => entry.id != their.id,
                                None => index_or_worktree_has(index, root, path),
                            },
                        );
                        let staged = stage_resolved(
                            index, root, &stamp, &copy, their.id, their.mode, review,
                        )?;
                        review.push(staged);
                    }
                }
            }
            (Some(edited), None) | (None, Some(edited)) => {
                let path = entry_path(&edited);
                add_resolved_unreviewed(
                    index,
                    root,
                    &stamp,
                    &path,
                    edited.id,
                    edited.mode,
                    review,
                )?;
            }
            (None, None) => {}
        }
    }
    if index.has_conflicts() {
        return Err(AppError::io("the merge left unresolved conflicts"));
    }
    Ok(resolved)
}

/// Land each oversized merged text (see [`Resolved::oversized`]) on disk,
/// over this device's version the checkout left there, and report it as
/// changed.
fn write_oversized_merges(
    root: &Path,
    oversized: &[(String, Vec<u8>)],
    changed_files: &mut Vec<ChangedFile>,
) -> AppResult<()> {
    for (path, merged) in oversized {
        let target = reflect_graph_io::resolve(root, path)?;
        reflect_graph_io::io::atomic_write_bytes(root, &target, merged)?;
        if !changed_files.iter().any(|change| change.path == *path) {
            changed_files.push(ChangedFile {
                path: path.clone(),
                kind: ChangeKind::Upsert,
                modified_ms: None,
            });
        }
    }
    Ok(())
}

const GITLINK_MODE: u32 = 0o160000;
const SYMLINK_MODE: u32 = 0o120000;

/// Stage a resolved entry without recording it for review, unless it had to
/// move to its conflict copy path.
fn add_resolved_unreviewed(
    index: &mut Index,
    root: &Path,
    stamp: &str,
    path: &str,
    id: git2::Oid,
    mode: u32,
    review: &mut Vec<String>,
) -> AppResult<()> {
    let staged = stage_resolved(index, root, stamp, path, id, mode, review)?;
    if staged != path {
        review.push(staged);
    }
    Ok(())
}

/// Stage `id` at `path`, or at its conflict copy path when `path` is a
/// directory, and return the path used. Parent files that collide are moved
/// to their conflict copy paths and recorded in `review`.
fn stage_resolved(
    index: &mut Index,
    root: &Path,
    stamp: &str,
    path: &str,
    id: git2::Oid,
    mode: u32,
    review: &mut Vec<String>,
) -> AppResult<String> {
    let dir_prefix = format!("{path}/");
    let is_dir = index
        .iter()
        .any(|entry| entry.path.starts_with(dir_prefix.as_bytes()));
    let path = if is_dir {
        let hash8 = id.to_string();
        free_conflict_copy_path(path, stamp, &hash8[..8], |path| {
            index_or_worktree_has(index, root, path)
        })
    } else {
        path.to_string()
    };
    let mut parent = path.as_str();
    while let Some((dir, _)) = parent.rsplit_once('/') {
        if let Some(file) = index.get_path(Path::new(dir), 0) {
            let hash8 = file.id.to_string();
            let copy = free_conflict_copy_path(dir, stamp, &hash8[..8], |path| {
                index_or_worktree_has(index, root, path)
            });
            index.remove_path(Path::new(dir))?;
            index.add(&stage0_entry(&copy, file.id, file.mode))?;
            review.push(copy);
        }
        parent = dir;
    }
    index.add(&stage0_entry(&path, id, mode))?;
    Ok(path)
}

fn entry_path(entry: &IndexEntry) -> String {
    String::from_utf8_lossy(&entry.path).into_owned()
}

fn is_text(blob: &git2::Blob<'_>) -> bool {
    !blob.is_binary() && std::str::from_utf8(blob.content()).is_ok()
}

/// Whether `rel` is taken in the merge index (as a file or a directory) or on
/// disk.
fn index_or_worktree_has(index: &Index, root: &Path, rel: &str) -> bool {
    let dir_prefix = format!("{rel}/");
    index.get_path(Path::new(rel), 0).is_some()
        || index
            .iter()
            .any(|entry| entry.path.starts_with(dir_prefix.as_bytes()))
        || root.join(rel).symlink_metadata().is_ok()
}

// ---- local-only folders -----------------------------------------------------

/// What a fast-forward does with each changed path, decided before anything
/// is written.
struct PullPlan {
    /// The changed paths it checks out.
    allowed: Vec<ChangedFile>,
    /// Frozen units, each the shortest frozen prefix of a changed path:
    /// never written here, and moved whole, so a type change at one (a link
    /// becoming a folder) is one entry's change, not a file meeting a folder.
    units: Vec<String>,
    /// The changed paths inside those units: the warning payload.
    frozen: Vec<String>,
}

/// Split `changes` into the checked-out paths and the frozen units (none
/// without local-only folders).
fn plan_pull(
    root: &Path,
    folders: Option<&LocalOnlyFolders>,
    changes: Vec<ChangedFile>,
) -> PullPlan {
    let mut plan = PullPlan {
        allowed: Vec::new(),
        units: Vec::new(),
        frozen: Vec::new(),
    };
    for change in changes {
        match folders.and_then(|folders| frozen_unit(root, folders, &change.path)) {
            Some(unit) => {
                if !plan.units.contains(&unit) {
                    plan.units.push(unit);
                }
                plan.frozen.push(change.path);
            }
            None => plan.allowed.push(change),
        }
    }
    plan
}

/// The shortest prefix of `path` this device must never write (by name, by a
/// folded alias such as `ſecure` for a `secure` link, or through a parent
/// that resolves into a local-only folder or out of the graph), or `None`
/// when it may write the path.
fn frozen_unit(root: &Path, folders: &LocalOnlyFolders, path: &str) -> Option<String> {
    let mut prefix = String::new();
    for component in path.split('/') {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(component);
        if reflect_graph_io::entry_is_local_only(root, &prefix, folders) {
            return Some(prefix);
        }
    }
    None
}

/// Whether `path` lies at or under one of `units`.
fn under_any(units: &[String], path: &str) -> bool {
    units.iter().any(|unit| {
        path == unit
            || path
                .strip_prefix(unit.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// The frozen units of a diverged merge: `held` are those of every path where
/// the remote differs from local HEAD, `followed` the held units the remote
/// changed since the merge base (all of them with no base), where history
/// takes the remote's version.
#[derive(Default)]
struct FrozenMerge {
    held: Vec<String>,
    followed: Vec<String>,
}

impl FrozenMerge {
    /// Decide the units, refusing before the merge writes anything a remote
    /// change outside them that would replace a folder holding a local-only
    /// folder, and a followed unit this device's history does not track.
    fn plan(
        repo: &Repository,
        root: &Path,
        folders: &LocalOnlyFolders,
        ours: &git2::Commit<'_>,
        theirs: &git2::Commit<'_>,
    ) -> AppResult<Self> {
        let ours_tree = ours.tree()?;
        let theirs_tree = theirs.tree()?;
        let base_tree = match repo.merge_base(ours.id(), theirs.id()) {
            Ok(base) => Some(repo.find_commit(base)?.tree()?),
            Err(_) => None,
        };
        let plan = plan_pull(
            root,
            Some(folders),
            changed_between(repo, Some(&ours_tree), &theirs_tree)?,
        );
        let writes = changed_between(repo, base_tree.as_ref(), &theirs_tree)?;
        ensure_no_folder_replaced(
            root,
            folders,
            writes
                .iter()
                .map(|change| change.path.as_str())
                .filter(|path| !under_any(&plan.units, path)),
        )?;
        let mut followed = Vec::new();
        for unit in &plan.units {
            let base = match &base_tree {
                Some(tree) => entries_under(repo, tree, unit)?,
                None => Vec::new(),
            };
            if base != entries_under(repo, &theirs_tree, unit)? {
                followed.push(unit.clone());
            }
        }
        ensure_units_already_tracked(&ours_tree, &followed)?;
        Ok(Self {
            held: plan.units,
            followed,
        })
    }
}

/// Refuse, before anything is written, a pull that would start tracking a
/// frozen unit this device's history (`head_tree`) does not track: commits
/// never add, update, or delete a local-only entry, so once in the index the
/// unit would stay in every later backup. Units HEAD already tracks keep
/// following the other device.
fn ensure_units_already_tracked(head_tree: &git2::Tree, units: &[String]) -> AppResult<()> {
    let untracked: Vec<String> = units
        .iter()
        .filter(|unit| head_tree.get_path(Path::new(unit.as_str())).is_err())
        .map(|unit| format!("\"{unit}\""))
        .collect();
    if untracked.is_empty() {
        return Ok(());
    }
    let (folders, them) = if untracked.len() == 1 {
        ("the local-only folder", "that folder")
    } else {
        ("the local-only folders", "those folders")
    };
    Err(AppError::io(format!(
        "Sync paused: the backup has files inside {folders} {}, which this graph's history does \
         not track. Pulling them would keep them in every later backup from this device, so \
         Reflect stops instead. Remove them from the backup in a separate clone (git rm -r \
         --cached on {them}, then commit and push; any other device that tracks {them}, the \
         phone included, then deletes its copies at its next sync, though history keeps them, \
         so copy what you need off those devices first), or restore the backup repository from \
         a good copy, then sync again.",
        untracked.join(", ")
    )))
}

/// Refuse, before anything is written, a write that would replace a
/// working-tree folder holding a local-only folder or link (another device
/// turned `people/` into a file): the checkout would delete the folder,
/// notes and all, and history has no copy of them.
fn ensure_no_folder_replaced<'a>(
    root: &Path,
    folders: &LocalOnlyFolders,
    writes: impl IntoIterator<Item = &'a str>,
) -> AppResult<()> {
    for path in writes {
        if holds_local_only(&root.join(path), folders) {
            return Err(AppError::io(format!(
                "Sync paused: another device replaced the folder \"{path}\", which holds a \
                 local-only folder, with a file. Move the local-only folder out of it, then \
                 sync again."
            )));
        }
    }
    Ok(())
}

/// Whether `path` is a real directory with a local-only folder or link
/// somewhere below it, by on-disk name like the walk. An unreadable entry
/// counts: fail closed.
fn holds_local_only(path: &Path, folders: &LocalOnlyFolders) -> bool {
    if !fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
        return false;
    }
    walkdir::WalkDir::new(path)
        .follow_links(false)
        .min_depth(1)
        .into_iter()
        .any(|entry| match entry {
            Err(_) => true,
            Ok(entry) => {
                (entry.file_type().is_dir() || entry.file_type().is_symlink())
                    && entry
                        .file_name()
                        .to_str()
                        .is_some_and(|name| folders.is_folder_name(name))
            }
        })
}

/// Make the repository index match `tree` at the frozen `units`, which the
/// checkout left alone, so the next commit records no change there.
fn follow_units_in_index(repo: &Repository, tree: &git2::Tree, units: &[String]) -> AppResult<()> {
    if units.is_empty() {
        return Ok(());
    }
    let mut index = repo.index()?;
    follow_tree_in_index(repo, &mut index, tree, units)?;
    index.write()?;
    Ok(())
}

/// Make `index` match `tree` at and under each of `paths`, without touching
/// the working tree: clear every path first, then copy the tree's files and
/// links there (a whole subtree for a folder), so a type change never meets
/// its old self as a file/folder collision. The stat fields are left zero:
/// those files are never checked out here.
fn follow_tree_in_index(
    repo: &Repository,
    index: &mut Index,
    tree: &git2::Tree,
    paths: &[String],
) -> AppResult<()> {
    for path in paths {
        let path = Path::new(path);
        if index.get_path(path, 0).is_some() {
            index.remove_path(path)?;
        }
        index.remove_dir(path, 0)?;
    }
    for path in paths {
        for (path, id, mode) in entries_under(repo, tree, path)? {
            index.add(&IndexEntry {
                ctime: IndexTime::new(0, 0),
                mtime: IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode: mode as u32,
                uid: 0,
                gid: 0,
                file_size: 0,
                id,
                flags: 0,
                flags_extended: 0,
                path,
            })?;
        }
    }
    Ok(())
}

/// Every file, link, and submodule entry of `tree` at or under `path`, as
/// `(path bytes, id, mode)`; empty when `tree` has nothing there.
fn entries_under(
    repo: &Repository,
    tree: &git2::Tree,
    path: &str,
) -> AppResult<Vec<(Vec<u8>, git2::Oid, i32)>> {
    let entry = match tree.get_path(Path::new(path)) {
        Ok(entry) => entry,
        Err(err) if err.code() == git2::ErrorCode::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.into()),
    };
    if entry.kind() != Some(git2::ObjectType::Tree) {
        return Ok(vec![(
            path.as_bytes().to_vec(),
            entry.id(),
            entry.filemode(),
        )]);
    }
    let subtree = repo.find_tree(entry.id())?;
    let mut out = Vec::new();
    subtree.walk(git2::TreeWalkMode::PreOrder, |prefix, child| {
        if child.kind() != Some(git2::ObjectType::Tree) {
            let mut full = format!("{path}/{prefix}").into_bytes();
            full.extend_from_slice(child.name_bytes());
            out.push((full, child.id(), child.filemode()));
        }
        git2::TreeWalkResult::Ok
    })?;
    Ok(out)
}

/// A dangling stand-in for the remote commit: its tree with every held unit
/// set to local HEAD's version (a whole subtree, a single entry, or
/// nothing), and its parents, so the merge base is unchanged. Built through
/// a flattened index, so a unit whose type differs between the two sides
/// swaps cleanly. The merge commit itself names the real remote.
fn remote_without(
    repo: &Repository,
    remote: &git2::Commit<'_>,
    held: &[String],
) -> AppResult<git2::Oid> {
    let local_tree = repo.head()?.peel_to_tree()?;
    let mut index = Index::new()?;
    index.read_tree(&remote.tree()?)?;
    follow_tree_in_index(repo, &mut index, &local_tree, held)?;
    let tree = repo.find_tree(index.write_tree_to(repo)?)?;
    let parents: Vec<git2::Commit> = remote.parents().collect();
    let parents: Vec<&git2::Commit> = parents.iter().collect();
    let sig = signature(repo)?;
    Ok(repo.commit(
        None,
        &sig,
        &sig,
        "reflect sync: remote changes outside local-only folders",
        &tree,
        &parents,
    )?)
}

/// Test-only hook into a pull, run once displacement succeeded and before
/// the checkout: a test lands a concurrent write there, or makes the
/// checkout fail. Thread-local, so parallel tests never see each other's.
#[cfg(test)]
pub(super) mod seam {
    use std::cell::RefCell;

    use reflect_types::AppResult;

    type Hook = Box<dyn FnOnce() -> AppResult<()>>;

    thread_local! {
        pub(in super::super) static AFTER_DISPLACEMENT: RefCell<Option<Hook>> =
            const { RefCell::new(None) };
    }

    pub(in super::super) fn after_displacement() -> AppResult<()> {
        match AFTER_DISPLACEMENT.with_borrow_mut(Option::take) {
            Some(hook) => hook(),
            None => Ok(()),
        }
    }
}

#[cfg(not(test))]
mod seam {
    use reflect_types::AppResult;

    pub(super) fn after_displacement() -> AppResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod outcome_tests {
    use super::{ChangeKind, ChangedFile, DisplacedFile, MergeKind, MergeOutcome};

    /// The shape the TypeScript merge outcome schema parses.
    #[test]
    fn outcomes_serialize_for_the_typescript_boundary() {
        let outcome = MergeOutcome {
            kind: MergeKind::FastForward,
            review_paths: Vec::new(),
            changed_files: vec![
                ChangedFile {
                    path: "notes/gone.md".into(),
                    kind: ChangeKind::Remove,
                    modified_ms: None,
                },
                ChangedFile {
                    path: "notes/new.md".into(),
                    kind: ChangeKind::Upsert,
                    modified_ms: Some(1_700_000_000_000),
                },
            ],
            frozen_paths: vec!["people/secure/visa.md".into()],
            displaced: vec![DisplacedFile {
                from: "daily/2026-10-04.md".into(),
                to: "daily/2026-10-04 (this device).md".into(),
                kept_out: false,
                tracked: false,
                different_note: false,
            }],
        };
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            serde_json::json!({
                "kind": "fastForward",
                "reviewPaths": [],
                "changedFiles": [
                    { "path": "notes/gone.md", "kind": "remove", "modifiedMs": null },
                    { "path": "notes/new.md", "kind": "upsert", "modifiedMs": 1_700_000_000_000_u64 },
                ],
                "frozenPaths": ["people/secure/visa.md"],
                "displaced": [{
                    "from": "daily/2026-10-04.md",
                    "to": "daily/2026-10-04 (this device).md",
                    "keptOut": false,
                    "tracked": false,
                    "differentNote": false,
                }],
            })
        );
        assert_eq!(
            serde_json::to_value(MergeKind::Deferred).unwrap(),
            serde_json::json!("deferred")
        );
    }
}
