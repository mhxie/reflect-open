//! Pull-side merge: fast-forward when possible, otherwise merge — and when
//! the merge conflicts, materialize the conflict **into the note** (standard
//! Git markers with readable labels), commit the merge anyway, and let the
//! user resolve by editing the file.
//!
//! The repository is never left mid-merge: committing the conflict keeps sync
//! flowing for every other note, both devices converge on the same marked-up
//! file, and the raw versions stay recoverable from history (the merge commit
//! has both parents). The indexer (Plan 12 core) detects the markers and flags
//! the note `Needs review`.
//!
//! The markers are standard Git, with product labels instead of branch names:
//!
//! ```text
//! <<<<<<< this device
//! the local version
//! =======
//! the other device's version
//! >>>>>>> other device
//! ```
//!
//! **Separate histories pause.** Before anything is analyzed or written, a
//! pull whose incoming commits include a history root the graph has not
//! accepted pauses sync (see `history_roots`): libgit2 would merge two
//! unrelated histories, or fast-forward into another device's merge of one,
//! like any other change.
//!
//! **Uncommitted bytes are never overwritten.** A pull writes only the paths
//! the other device changed (its write set), and before it writes any of
//! them it validates them all and moves this device's uncommitted entries
//! out of their way to `name (this device).ext` (see `displace`), holding
//! the note write guard (`fs::note_write_guard`) until the working tree is
//! final. A save that raced the cycle's commit defers the pull instead
//! ([`MergeKind::Deferred`]): the engine commits and pulls again. Both
//! fast-forward shapes take one path that checks out only the write set,
//! writes the index once, and moves the ref last; there is no forced
//! checkout of HEAD, which would revert every uncommitted tracked file. A
//! pull that fails after entries moved puts them back where it can, and
//! every entry that stays moved is reported, on success and on failure
//! alike.
//!
//! **Local-only folders are frozen.** With folders configured, no merge or
//! fast-forward ever creates, writes, or deletes a path that is, or that the
//! filesystem resolves into, a local-only folder (or out of the graph). Each
//! such folder moves as one unit, so a type change (a link becoming a folder
//! upstream) is one entry's change: a fast-forward checks out only the other
//! changed paths, and a diverged merge runs against the remote with each
//! unit held at this device's version. Where this device's history already
//! tracks a unit, the repository still follows the other device: HEAD and
//! the index take its version of the unit, so history keeps it and the next
//! commit stays clean, while this device's files are never touched. Paths
//! tracked before the folder became local-only therefore stay frozen on
//! disk and are never checked out again; each skipped change is reported in
//! [`MergeOutcome::frozen_paths`]. A pull that would start tracking a unit
//! this device's history does not track pauses instead: commits never add,
//! update, or delete a local-only entry, so the unit would stay in every
//! later backup. A remote change that would replace a working-tree folder
//! holding a local-only folder (with a file) is refused too. Both refusals
//! come before anything is written.
//!
//! An unborn HEAD has no history of its own: it adopts the remote's whole,
//! with neither local-only check, as before (its untracked entries in the
//! way still move aside).

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, IndexTime, MergeOptions, Repository};
use reflect_graph_paths::LocalOnlyFolders;
use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::displace::{
    copy_name, displace, ensure_writable_path, fold, taken_paths, DisplacedFile, Displacement,
    Moves, MAX_NAME_PROBES,
};
use super::history_roots::ensure_pull_accepted;
use super::repo::{current_branch, ensure_clean_state, open_existing, signature};

/// Conflict-marker labels. "this device" is the local side, "other device"
/// the remote one — product language, not branch names.
const OUR_LABEL: &str = "this device";
const THEIR_LABEL: &str = "other device";

/// The label a binary conflict's copy of the other device's version carries.
const CONFLICT_LABEL: &str = "conflict";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    UpToDate,
    FastForward,
    Merged,
    MergedWithConflicts,
    /// A save raced the cycle's commit: a tracked, public file changed at a
    /// path the pull writes. Nothing was written; the engine commits and
    /// pulls again.
    Deferred,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Upsert,
    Remove,
}

/// One working-tree file a merge/fast-forward rewrote, in the same shape as
/// the watcher's `FileChange` so the caller can reindex directly.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub kind: ChangeKind,
    /// Last-modified time of the written file (epoch ms; upserts only), so
    /// the reindex stamps the real mtime like the watcher path does.
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub kind: MergeKind,
    /// Graph-relative paths that now carry conflict markers (or a binary
    /// conflict copy). Informational — the indexer rediscovers them from
    /// content.
    pub conflicted_paths: Vec<String>,
    /// Every file this merge changed on disk. The sync layer reindexes these
    /// directly — pulls must not depend on the file watcher being up (on
    /// launch it may not be yet) to keep the index in step with the notes.
    /// Deletions carry `modified_ms: None`; upserts carry the written file's
    /// real mtime. Each displaced entry's new path is an upsert here too.
    pub changed_files: Vec<ChangedFile>,
    /// The other device's changes inside this device's local-only folders:
    /// recorded in history, never written here. The sync layer warns.
    pub frozen_paths: Vec<String>,
    /// This device's entries the pull moved out of the paths it wrote, and
    /// where each went. The sync layer warns and open editors follow.
    pub displaced: Vec<DisplacedFile>,
}

impl MergeOutcome {
    /// An outcome that wrote nothing.
    fn nothing(kind: MergeKind) -> Self {
        Self {
            kind,
            conflicted_paths: Vec::new(),
            changed_files: Vec::new(),
            frozen_paths: Vec::new(),
            displaced: Vec::new(),
        }
    }
}

/// What a pull may do in one graph.
pub(super) struct PullPolicy<'a> {
    /// The graph's local-only folders, never written by a pull.
    pub(super) local_only: Option<&'a LocalOnlyFolders>,
    /// The history roots the graph accepts (see `history_roots`).
    pub(super) accepted_roots: &'a [git2::Oid],
    /// The backup size limit: a file at or above it is an edit the commit
    /// skipped, so it moves aside instead of deferring the pull.
    pub(super) max_file_bytes: u64,
}

/// One side of an index conflict, lifted out of the index so the borrow ends
/// before we mutate it.
struct ConflictSide {
    path: String,
    id: git2::Oid,
}

fn side_of(entry: Option<IndexEntry>) -> Option<ConflictSide> {
    entry.map(|entry| ConflictSide {
        path: String::from_utf8_lossy(&entry.path).into_owned(),
        id: entry.id,
    })
}

/// Whether a merge must never write `path` on this device (see
/// `fs::entry_is_local_only`: by name, by a folded alias such as
/// `ſecure` for a `secure` link, or through a parent that resolves into a
/// local-only folder or out of the graph).
fn is_frozen(root: &Path, folders: &LocalOnlyFolders, path: &str) -> bool {
    crate::fs::entry_is_local_only(root, path, folders)
}

/// Merge the fetched `origin/<branch>` into the local branch. Pre-condition
/// (the sync engine guarantees it): local changes are committed, except
/// inside local-only folders, which are never committed and which this
/// merge never writes, and except bytes a commit holds back (an oversized
/// edit), which move aside (see the module docs). `displaced` receives every
/// entry the pull moved and left moved, whatever the result, for the caller
/// to announce.
pub(super) fn merge_remote(
    root: &Path,
    policy: &PullPolicy<'_>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<MergeOutcome> {
    let repo = open_existing(root)?;
    ensure_clean_state(&repo)?;
    let branch = current_branch(&repo)?;
    let Ok(remote_oid) = repo.refname_to_id(&format!("refs/remotes/origin/{branch}")) else {
        // A brand-new (empty) backup repo has no remote branch until the
        // first push creates it. Nothing to merge is success, not an error —
        // the launch cycle (commit → fetch → merge → push) must fall through
        // to that push.
        return Ok(MergeOutcome::nothing(MergeKind::UpToDate));
    };
    if let Ok(local_oid) = repo.refname_to_id(&format!("refs/heads/{branch}")) {
        ensure_pull_accepted(&repo, root, local_oid, remote_oid, policy.accepted_roots)?;
    }
    let annotated = repo.find_annotated_commit(remote_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome::nothing(MergeKind::UpToDate));
    }
    if analysis.is_unborn() || analysis.is_fast_forward() {
        return fast_forward(&repo, root, &branch, remote_oid, policy, displaced);
    }
    merge_diverged(&repo, root, remote_oid, annotated, policy, displaced)
}

/// Fast-forward (or adopt, on an unborn HEAD) to `remote_oid`. Never a full
/// forced checkout: only the write set is checked out, after displacement,
/// the index is written once, and the ref moves last. A failure up to and
/// including the index write leaves the index and the ref together on the
/// old commit, and a retry checks the same paths out again. Only a failure
/// to move the ref after the index write leaves the index ahead of HEAD; the
/// next commit then records the pulled files as a local change, which the
/// following merge reconciles with the identical remote one.
fn fast_forward(
    repo: &Repository,
    root: &Path,
    branch: &str,
    remote_oid: git2::Oid,
    policy: &PullPolicy<'_>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<MergeOutcome> {
    // Capture the outgoing tree before the ref moves (None on unborn).
    let old_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let new_tree = repo.find_commit(remote_oid)?.tree()?;
    let plan = plan_pull(
        root,
        policy.local_only,
        write_set(repo, old_tree.as_ref(), &new_tree)?,
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
    // Held from the displacement scan until the ref moves: an app write
    // landing in between would be overwritten by the checkout.
    let _guard = (!plan.allowed.is_empty()).then(crate::fs::note_write_guard);
    let moves = match displace(
        repo,
        root,
        &plan.allowed,
        &new_tree,
        policy.max_file_bytes,
        displaced,
    )? {
        Displacement::Ready(moves) => moves,
        Displacement::Deferred => return Ok(MergeOutcome::nothing(MergeKind::Deferred)),
    };
    let landed = seam::after_displacement().and_then(|()| {
        checkout_paths(repo, &new_tree, &plan.allowed)?;
        let mut follow: Vec<String> = plan
            .allowed
            .iter()
            .map(|change| change.path.clone())
            .collect();
        follow.extend(plan.units.iter().cloned());
        let mut index = repo.index()?;
        follow_tree_in_index(repo, &mut index, &new_tree, &follow)?;
        index.write()?;
        let refname = format!("refs/heads/{branch}");
        repo.reference(&refname, remote_oid, true, "reflect sync: fast-forward")?;
        repo.set_head(&refname)?;
        Ok(())
    });
    let ((), copies) = settle(moves, landed, displaced)?;
    let mut changed_files = plan.allowed;
    changed_files.extend(upserts(&copies));
    // Stamp mtimes only now — the checkout above is what wrote the files.
    stamp_modified_times(root, &mut changed_files);
    Ok(MergeOutcome {
        kind: MergeKind::FastForward,
        conflicted_paths: Vec::new(),
        changed_files,
        frozen_paths: plan.frozen,
        displaced: copies,
    })
}

/// Merge a remote that diverged from local HEAD. With local-only folders,
/// the merge runs against a stand-in for the remote whose frozen units hold
/// this device's version: ours == theirs there, so whatever base the merge
/// picks it neither writes nor checks them.
fn merge_diverged(
    repo: &Repository,
    root: &Path,
    remote_oid: git2::Oid,
    annotated: git2::AnnotatedCommit<'_>,
    policy: &PullPolicy<'_>,
    displaced: &mut Vec<DisplacedFile>,
) -> AppResult<MergeOutcome> {
    let local = repo.head()?.peel_to_commit()?;
    let remote = repo.find_commit(remote_oid)?;
    let remote_tree = remote.tree()?;
    // The merge writes only where the remote changed since the base (every
    // path, with no base), deletions and edit-vs-delete restores included.
    let base_tree = match repo.merge_base(local.id(), remote_oid) {
        Ok(base) => Some(repo.find_commit(base)?.tree()?),
        Err(_) => None,
    };
    let mut writes = write_set(repo, base_tree.as_ref(), &remote_tree)?;
    let held = match policy.local_only {
        Some(folders) => held_units(repo, root, folders, &local.tree()?, &remote_tree, &writes)?,
        None => Vec::new(),
    };
    writes.retain(|change| !under_any(&held, &change.path));
    // History takes the remote's version of each held unit it changed since
    // the merge base; a held unit it did not change keeps this device's.
    let followed = if held.is_empty() {
        Vec::new()
    } else {
        let followed = remote_changed_units(repo, local.id(), &remote, &held)?;
        ensure_units_already_tracked(&local.tree()?, &followed)?;
        followed
    };
    let annotated = if held.is_empty() {
        annotated
    } else {
        repo.find_annotated_commit(remote_without(repo, remote_oid, &held)?)?
    };

    // Held from the displacement scan until the merge commit: an app write
    // landing in between would trip or be overwritten by the merge checkout.
    let _guard = (!writes.is_empty()).then(crate::fs::note_write_guard);
    let moves = match displace(
        repo,
        root,
        &writes,
        &remote_tree,
        policy.max_file_bytes,
        displaced,
    )? {
        Displacement::Ready(moves) => moves,
        Displacement::Deferred => return Ok(MergeOutcome::nothing(MergeKind::Deferred)),
    };
    let landed = seam::after_displacement().and_then(|()| {
        let mut merge_opts = MergeOptions::new();
        let mut checkout = CheckoutBuilder::new();
        checkout
            .allow_conflicts(true)
            .conflict_style_merge(true)
            .our_label(OUR_LABEL)
            .their_label(THEIR_LABEL);
        repo.merge(&[&annotated], Some(&mut merge_opts), Some(&mut checkout))?;
        complete_merge(repo, root, remote_oid, &held, &followed, policy.local_only)
    });
    if landed.is_err() {
        // The repo may carry MERGE_* state now; a failure that leaves it
        // behind would trip `ensure_clean_state` on every later cycle and
        // wedge sync until a manual repair — exactly what this design
        // forbids. Clear it on every path; the next cycle re-derives anything
        // a failed attempt lost.
        let _ = repo.cleanup_state();
    }
    let ((conflicted_paths, mut changed_files, frozen_paths), copies) =
        settle(moves, landed, displaced)?;
    let mut kept = upserts(&copies);
    stamp_modified_times(root, &mut kept);
    changed_files.extend(kept);

    let kind = if conflicted_paths.is_empty() {
        MergeKind::Merged
    } else {
        MergeKind::MergedWithConflicts
    };
    Ok(MergeOutcome {
        kind,
        conflicted_paths,
        changed_files,
        frozen_paths,
        displaced: copies,
    })
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

/// What a pull does with each changed path, decided before anything is
/// written.
struct PullPlan {
    /// The changed paths it checks out: the write set.
    allowed: Vec<ChangedFile>,
    /// Frozen units, each the shortest frozen prefix of a changed path:
    /// never written here, and moved whole, so a type change at one (a link
    /// becoming a folder) is one entry's change, not a file meeting a folder.
    units: Vec<String>,
    /// The changed paths inside those units: the warning payload.
    frozen: Vec<String>,
}

/// Split `changes` into the write set and the frozen units (none without
/// local-only folders).
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

/// The shortest prefix of `path` this device must never write
/// ([`is_frozen`]), or `None` when it may write the path.
fn frozen_unit(root: &Path, folders: &LocalOnlyFolders, path: &str) -> Option<String> {
    let mut prefix = String::new();
    for component in path.split('/') {
        if !prefix.is_empty() {
            prefix.push('/');
        }
        prefix.push_str(component);
        if is_frozen(root, folders, &prefix) {
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

/// Check out exactly `changes` from `tree`, forcibly (displacement already
/// moved every uncommitted entry out of their way), into the working tree
/// only: the caller writes the index once, afterwards. An empty pathspec
/// would mean every path, so no changes means no checkout.
fn checkout_paths(repo: &Repository, tree: &git2::Tree, changes: &[ChangedFile]) -> AppResult<()> {
    if changes.is_empty() {
        return Ok(());
    }
    let mut checkout = CheckoutBuilder::new();
    checkout
        .force()
        .disable_pathspec_match(true)
        .update_index(false);
    for change in changes {
        checkout.path(change.path.as_str());
    }
    repo.checkout_tree(tree.as_object(), Some(&mut checkout))?;
    Ok(())
}

/// Make the index match `tree` at and under each of `paths`, without
/// touching the working tree: clear every path first, then copy the tree's
/// files and links there (a whole subtree for a folder), so a type change
/// never meets its old self as a file/folder collision. The stat fields stay
/// zero: the next commit re-reads the few files involved (and never a
/// local-only path), so it stays clean.
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

/// The frozen units a diverged merge must hold: those of every path where
/// the remote differs from local HEAD. Refuses, before the merge writes
/// anything, a remote change in the write set (`writes`, outside the units)
/// that would replace a folder holding a local-only folder.
fn held_units(
    repo: &Repository,
    root: &Path,
    folders: &LocalOnlyFolders,
    local_tree: &git2::Tree,
    remote_tree: &git2::Tree,
    writes: &[ChangedFile],
) -> AppResult<Vec<String>> {
    let plan = plan_pull(
        root,
        Some(folders),
        changed_between(repo, Some(local_tree), remote_tree)?,
    );
    ensure_no_folder_replaced(
        root,
        folders,
        writes
            .iter()
            .map(|change| change.path.as_str())
            .filter(|path| !under_any(&plan.units, path)),
    )?;
    Ok(plan.units)
}

/// A dangling stand-in for the remote commit: its tree with every held unit
/// set to local HEAD's version (a whole subtree, a single entry, or
/// nothing), and its parents, so the merge base is unchanged. Built through
/// a flattened index, so a unit whose type differs between the two sides
/// swaps cleanly. The merge commit itself names the real remote.
fn remote_without(
    repo: &Repository,
    remote_oid: git2::Oid,
    held: &[String],
) -> AppResult<git2::Oid> {
    let local_tree = repo.head()?.peel_to_tree()?;
    let remote = repo.find_commit(remote_oid)?;
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

/// The held units the remote changed since the merge base (all of them
/// when there is no base): history takes the remote's version there.
fn remote_changed_units(
    repo: &Repository,
    local: git2::Oid,
    remote: &git2::Commit,
    held: &[String],
) -> AppResult<Vec<String>> {
    let base_tree = match repo.merge_base(local, remote.id()) {
        Ok(base) => Some(repo.find_commit(base)?.tree()?),
        Err(_) => None,
    };
    let remote_tree = remote.tree()?;
    let mut changed = Vec::new();
    for unit in held {
        let base = match &base_tree {
            Some(tree) => entries_under(repo, tree, unit)?,
            None => Vec::new(),
        };
        if base != entries_under(repo, &remote_tree, unit)? {
            changed.push(unit.clone());
        }
    }
    Ok(changed)
}

/// The post-`repo.merge` half: materialize conflicts, commit the merge with
/// both parents, and clear the merge state. Split out so [`merge_diverged`]
/// can guarantee `cleanup_state` runs even when any step here fails. Returns
/// the conflicted paths and every file the merge changed relative to local
/// HEAD.
fn complete_merge(
    repo: &Repository,
    root: &Path,
    remote_oid: git2::Oid,
    held: &[String],
    followed: &[String],
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<(Vec<String>, Vec<ChangedFile>, Vec<String>)> {
    let mut index = repo.index()?;
    let local_commit = repo.head()?.peel_to_commit()?;
    let remote_commit = repo.find_commit(remote_oid)?;
    let remote_tree = remote_commit.tree()?;
    let conflicted_paths = resolve_conflicts(repo, root, &mut index, &remote_tree, local_only)?;
    // Held units merged as this device's version; where the other device
    // changed one (`followed`), history takes its version instead. The files
    // stay frozen.
    follow_tree_in_index(repo, &mut index, &remote_tree, followed)?;
    index.write()?;
    let frozen_paths: Vec<String> = if followed.is_empty() {
        Vec::new()
    } else {
        changed_between(repo, Some(&local_commit.tree()?), &remote_tree)?
            .into_iter()
            .map(|change| change.path)
            .filter(|path| under_any(followed, path))
            .collect()
    };

    let tree = repo.find_tree(index.write_tree()?)?;
    // The working tree is final here (merge checkout + conflict resolution
    // wrote everything), so the stamped mtimes are the files' real ones.
    let mut changed_files = changed_between(repo, Some(&local_commit.tree()?), &tree)?;
    changed_files.retain(|change| !under_any(held, &change.path));
    stamp_modified_times(root, &mut changed_files);
    let sig = signature(repo)?;
    let message = if conflicted_paths.is_empty() {
        "Merge changes from other devices"
    } else {
        "Merge changes from other devices (conflicts to review)"
    };
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        message,
        &tree,
        &[&local_commit, &remote_commit],
    )?;
    repo.cleanup_state()?;
    Ok((conflicted_paths, changed_files, frozen_paths))
}

/// The paths a pull writes or removes going from `old` to `new` (the other
/// device's changes: fast-forward from HEAD, a diverged merge from the merge
/// base), every one validated first ([`ensure_writable_path`], on the raw
/// tree bytes): a pull never acts on a path it could not write safely.
/// Diffs against this device's own commits are never validated: a path only
/// this device committed is never written by the pull.
fn write_set(
    repo: &Repository,
    old: Option<&git2::Tree>,
    new: &git2::Tree,
) -> AppResult<Vec<ChangedFile>> {
    let diff = repo.diff_tree_to_tree(old, Some(new), None)?;
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            if let Some(bytes) = file.path_bytes() {
                ensure_writable_path(bytes)?;
            }
        }
    }
    Ok(changes_in(&diff))
}

/// Diff two trees into the watcher's change shape: what the merge wrote or
/// removed on disk relative to the previous local HEAD.
fn changed_between(
    repo: &Repository,
    old: Option<&git2::Tree>,
    new: &git2::Tree,
) -> AppResult<Vec<ChangedFile>> {
    Ok(changes_in(&repo.diff_tree_to_tree(old, Some(new), None)?))
}

/// A tree diff's deltas as changed files.
fn changes_in(diff: &git2::Diff<'_>) -> Vec<ChangedFile> {
    let mut out = Vec::new();
    for delta in diff.deltas() {
        let removed = delta.status() == git2::Delta::Deleted;
        let file = if removed {
            delta.old_file()
        } else {
            delta.new_file()
        };
        if let Some(path) = file.path() {
            out.push(ChangedFile {
                path: path.to_string_lossy().replace('\\', "/"),
                kind: if removed {
                    ChangeKind::Remove
                } else {
                    ChangeKind::Upsert
                },
                modified_ms: None, // stamped once the working tree is final
            });
        }
    }
    out
}

/// Fill `modified_ms` for upserts from the (now final) working-tree files.
fn stamp_modified_times(root: &Path, changes: &mut [ChangedFile]) {
    for change in changes {
        if matches!(change.kind, ChangeKind::Remove) {
            continue;
        }
        change.modified_ms = root
            .join(&change.path)
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64);
    }
}

/// Turn every index conflict into committed working-tree content:
///
/// - **text vs text** — the merge checkout already wrote labeled markers into
///   the file; stage it as-is (the user resolves by editing the note);
/// - **edit vs delete** — keep the edited version, never silently delete;
/// - **binary vs binary** — keep ours in place and the other device's copy
///   alongside (`name (conflict).ext`, or the first free `(conflict N)`);
/// - **deleted on both** — confirm the removal.
fn resolve_conflicts(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
    remote_tree: &git2::Tree,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<Vec<String>> {
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }

    struct OwnedConflict {
        our: Option<ConflictSide>,
        their: Option<ConflictSide>,
        ancestor: Option<ConflictSide>,
    }
    let conflicts: Vec<OwnedConflict> = index
        .conflicts()?
        .filter_map(Result::ok)
        .map(|conflict| OwnedConflict {
            our: side_of(conflict.our),
            their: side_of(conflict.their),
            ancestor: side_of(conflict.ancestor),
        })
        .collect();

    let mut conflicted_paths = Vec::new();
    for conflict in conflicts {
        match (conflict.our, conflict.their) {
            (Some(our), Some(their)) => {
                conflicted_paths.extend(resolve_both_edited(
                    repo,
                    root,
                    index,
                    our,
                    their,
                    remote_tree,
                    local_only,
                )?);
            }
            (Some(edited), None) | (None, Some(edited)) => {
                conflicted_paths.push(resolve_edit_vs_delete(
                    repo, root, index, edited, local_only,
                )?);
            }
            (None, None) => {
                if let Some(ancestor) = conflict.ancestor {
                    index.remove_path(Path::new(&ancestor.path))?;
                }
            }
        }
    }
    Ok(conflicted_paths)
}

/// Both sides changed the file. Text: the merge checkout already wrote the
/// labeled marker file, so staging the working copy clears the conflict
/// entries. Binary: markers would corrupt the bytes — keep ours in place and
/// write the other device's version alongside, at a free name.
fn resolve_both_edited(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
    our: ConflictSide,
    their: ConflictSide,
    remote_tree: &git2::Tree,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<Vec<String>> {
    let binary = repo.find_blob(our.id)?.is_binary() || repo.find_blob(their.id)?.is_binary();
    if !binary {
        index.add_path(Path::new(&our.path))?;
        return Ok(vec![our.path]);
    }
    write_blob(repo, root, &our.path, our.id, local_only)?;
    let copy = write_conflict_copy(repo, root, index, remote_tree, &their, local_only)?;
    index.add_path(Path::new(&our.path))?;
    index.add_path(Path::new(&copy))?;
    Ok(vec![our.path, copy])
}

/// One side edited what the other deleted (either direction): restore and
/// stage the edited version — sync must never silently delete a note someone
/// touched. The user removes it again if the deletion was intentional.
fn resolve_edit_vs_delete(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
    edited: ConflictSide,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<String> {
    write_blob(repo, root, &edited.path, edited.id, local_only)?;
    index.add_path(Path::new(&edited.path))?;
    Ok(edited.path)
}

/// Write a blob into the working tree. With local-only folders configured
/// the target goes through the strict write guard, editable folders
/// included: `fs::write` follows symlinks, a pull never writes into a
/// local-only folder, and a held path can never conflict, so a refusal here
/// is a bug surfacing loudly rather than a write through a link.
pub(super) fn write_blob(
    repo: &Repository,
    root: &Path,
    rel: &str,
    id: git2::Oid,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<()> {
    let blob = repo.find_blob(id)?;
    let target = match local_only {
        Some(folders) => crate::fs::resolve_write_in_graph(root, rel, Some(folders))?,
        None => root.join(rel),
    };
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(target, blob.content())?;
    Ok(())
}

/// Write the other device's side of a binary conflict beside it, at the
/// first `name (conflict).ext`, `name (conflict 2).ext`, … that no tree,
/// the index, or the disk holds, never over an existing file. Returns its
/// path.
fn write_conflict_copy(
    repo: &Repository,
    root: &Path,
    index: &Index,
    remote_tree: &git2::Tree,
    their: &ConflictSide,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<String> {
    let blob = repo.find_blob(their.id)?;
    let head = repo.head()?.peel_to_tree()?;
    let mut taken: Option<HashSet<String>> = None;
    for attempt in 1..=MAX_NAME_PROBES {
        let copy = conflict_copy_path(&their.path, attempt);
        let taken = taken
            .get_or_insert_with(|| taken_paths(index, &[&head, remote_tree], std::iter::empty()));
        if taken.contains(&fold(&copy)) {
            continue;
        }
        if let Some(folders) = local_only {
            crate::fs::resolve_write_in_graph(root, &copy, Some(folders))?;
        }
        if create_new(root, &copy, blob.content())? {
            return Ok(copy);
        }
    }
    Err(AppError::io(format!(
        "no free name to keep the other device's version of {} beside it",
        their.path
    )))
}

/// Create `rel` holding `bytes` only while nothing holds the name, walking
/// to it without following a symlink. False when the name is taken.
#[cfg(unix)]
fn create_new(root: &Path, rel: &str, bytes: &[u8]) -> AppResult<bool> {
    use crate::fs::{open_dir_beneath, persist_beneath, Persist, Persisted};
    let base = root.canonicalize()?;
    let (dir, name) = match rel.rsplit_once('/') {
        Some((dir, name)) => (dir, name),
        None => ("", rel),
    };
    let graph = open_dir_beneath(&base, Path::new(""), false)?;
    let parent = open_dir_beneath(&base, Path::new(dir), true)?;
    Ok(matches!(
        persist_beneath(&graph, &parent, name, bytes, Persist::NoClobber)?,
        Persisted::Created(_)
    ))
}

/// Create `rel` holding `bytes` only while nothing holds the name. False
/// when the name is taken.
#[cfg(not(unix))]
fn create_new(root: &Path, rel: &str, bytes: &[u8]) -> AppResult<bool> {
    use std::io::Write;
    let target = root.join(rel);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
    {
        Ok(mut file) => {
            file.write_all(bytes)?;
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(err) => Err(err.into()),
    }
}

/// `assets/img.png` → `assets/img (conflict).png` on the first attempt,
/// `assets/img (conflict 2).png` on the second; no extension → appended.
/// Splits on the basename only — a dot in a *directory* name (`assets.v1/x`)
/// must not relocate the copy out of the file's directory.
fn conflict_copy_path(rel: &str, attempt: u32) -> String {
    match rel.rsplit_once('/') {
        Some((dir, file)) => format!("{dir}/{}", copy_name(file, CONFLICT_LABEL, attempt)),
        None => copy_name(rel, CONFLICT_LABEL, attempt),
    }
}

/// Test-only hook into a pull, run once displacement succeeded and before
/// the checkout or merge: a test lands a concurrent write there, or makes
/// the checkout fail. Thread-local, so parallel tests never see each
/// other's.
#[cfg(test)]
pub(super) mod seam {
    use std::cell::RefCell;

    use crate::error::AppResult;

    type Hook = Box<dyn FnOnce() -> AppResult<()>>;

    thread_local! {
        pub(in crate::git) static AFTER_DISPLACEMENT: RefCell<Option<Hook>> =
            const { RefCell::new(None) };
    }

    pub(in crate::git) fn after_displacement() -> AppResult<()> {
        match AFTER_DISPLACEMENT.with_borrow_mut(Option::take) {
            Some(hook) => hook(),
            None => Ok(()),
        }
    }
}

#[cfg(not(test))]
mod seam {
    use crate::error::AppResult;

    pub(super) fn after_displacement() -> AppResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod path_tests {
    use super::conflict_copy_path;

    #[test]
    fn conflict_copies_stay_in_their_directory() {
        assert_eq!(
            conflict_copy_path("assets/img.png", 1),
            "assets/img (conflict).png"
        );
        assert_eq!(
            conflict_copy_path("assets.v1/img", 1),
            "assets.v1/img (conflict)"
        );
        assert_eq!(
            conflict_copy_path("assets.v1/img.png", 1),
            "assets.v1/img (conflict).png"
        );
        assert_eq!(
            conflict_copy_path("topfile.bin", 1),
            "topfile (conflict).bin"
        );
        assert_eq!(conflict_copy_path("noext", 1), "noext (conflict)");
        assert_eq!(
            conflict_copy_path("assets/.hidden", 1),
            "assets/.hidden (conflict)"
        );
        assert_eq!(
            conflict_copy_path("assets/img.png", 2),
            "assets/img (conflict 2).png"
        );
    }
}
