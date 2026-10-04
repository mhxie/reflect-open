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
//! with neither check, as before.

use std::fs;
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, IndexTime, MergeOptions, Repository};
use reflect_graph_paths::LocalOnlyFolders;
use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::history_roots::ensure_pull_accepted;
use super::repo::{current_branch, ensure_clean_state, open_existing, signature};

/// Conflict-marker labels. "this device" is the local side, "other device"
/// the remote one — product language, not branch names.
const OUR_LABEL: &str = "this device";
const THEIR_LABEL: &str = "other device";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    UpToDate,
    FastForward,
    Merged,
    MergedWithConflicts,
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
    /// real mtime.
    pub changed_files: Vec<ChangedFile>,
    /// The other device's changes inside this device's local-only folders:
    /// recorded in history, never written here. The sync layer warns.
    pub frozen_paths: Vec<String>,
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
/// (the sync engine guarantees it): local changes are already committed,
/// except inside local-only folders, which are never committed and which
/// this merge never writes (see the module docs). `accepted_roots` are the
/// graph's accepted history roots.
pub(super) fn merge_remote(
    root: &Path,
    local_only: Option<&LocalOnlyFolders>,
    accepted_roots: &[git2::Oid],
) -> AppResult<MergeOutcome> {
    let repo = open_existing(root)?;
    ensure_clean_state(&repo)?;
    let branch = current_branch(&repo)?;
    let Ok(remote_oid) = repo.refname_to_id(&format!("refs/remotes/origin/{branch}")) else {
        // A brand-new (empty) backup repo has no remote branch until the
        // first push creates it. Nothing to merge is success, not an error —
        // the launch cycle (commit → fetch → merge → push) must fall through
        // to that push.
        return Ok(MergeOutcome {
            kind: MergeKind::UpToDate,
            conflicted_paths: Vec::new(),
            changed_files: Vec::new(),
            frozen_paths: Vec::new(),
        });
    };
    if let Ok(local_oid) = repo.refname_to_id(&format!("refs/heads/{branch}")) {
        ensure_pull_accepted(&repo, root, local_oid, remote_oid, accepted_roots)?;
    }
    let annotated = repo.find_annotated_commit(remote_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome {
            kind: MergeKind::UpToDate,
            conflicted_paths: Vec::new(),
            changed_files: Vec::new(),
            frozen_paths: Vec::new(),
        });
    }

    if analysis.is_unborn() || analysis.is_fast_forward() {
        // Capture the outgoing tree before the ref moves (None on unborn).
        let old_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        let new_tree = repo.find_commit(remote_oid)?.tree()?;
        let mut changed_files = changed_between(&repo, old_tree.as_ref(), &new_tree)?;
        let refname = format!("refs/heads/{branch}");
        let frozen_paths = match local_only {
            None => {
                repo.reference(&refname, remote_oid, true, "reflect sync: fast-forward")?;
                repo.set_head(&refname)?;
                // Force is safe here: with no local-only folders the
                // pre-merge invariant is a committed working tree, so there
                // is nothing uncommitted to clobber.
                repo.checkout_head(Some(CheckoutBuilder::new().force()))?;
                Vec::new()
            }
            Some(folders) => {
                // Never a full forced checkout: it would also "restore"
                // tracked local-only paths whose frozen copies differ, writing
                // through the link. Only the changed, writable paths are
                // checked out. The working tree goes first, the index is
                // written once, and the ref moves last. A failure up to and
                // including the index write leaves the index and the ref
                // together on the old commit, and a retry checks the same
                // paths out again. Only a failure to move the ref after the
                // index write leaves the index ahead of HEAD; the next commit
                // then records the pulled files as a local change, which the
                // following merge reconciles with the identical remote one.
                let plan = plan_pull(root, folders, std::mem::take(&mut changed_files));
                if let Some(old_tree) = &old_tree {
                    ensure_units_already_tracked(old_tree, &plan.units)?;
                }
                ensure_no_folder_replaced(root, folders, &plan.allowed)?;
                checkout_paths(&repo, &new_tree, &plan.allowed)?;
                let mut follow: Vec<String> = plan
                    .allowed
                    .iter()
                    .map(|change| change.path.clone())
                    .collect();
                follow.extend(plan.units.iter().cloned());
                let mut index = repo.index()?;
                follow_tree_in_index(&repo, &mut index, &new_tree, &follow)?;
                index.write()?;
                repo.reference(&refname, remote_oid, true, "reflect sync: fast-forward")?;
                repo.set_head(&refname)?;
                changed_files = plan.allowed;
                plan.frozen
            }
        };
        // Stamp mtimes only now — the checkout above is what wrote the files.
        stamp_modified_times(root, &mut changed_files);
        return Ok(MergeOutcome {
            kind: MergeKind::FastForward,
            conflicted_paths: Vec::new(),
            changed_files,
            frozen_paths,
        });
    }

    // With local-only folders, merge against a stand-in for the remote whose
    // frozen units hold this device's version: ours == theirs there, so
    // whatever base the merge picks it neither writes nor checks them.
    let held = match local_only {
        Some(folders) => held_units(&repo, root, folders, remote_oid)?,
        None => Vec::new(),
    };
    // History takes the remote's version of each held unit it changed since
    // the merge base; a held unit it did not change keeps this device's.
    let followed = if held.is_empty() {
        Vec::new()
    } else {
        let local = repo.head()?.peel_to_commit()?;
        let remote = repo.find_commit(remote_oid)?;
        let followed = remote_changed_units(&repo, local.id(), &remote, &held)?;
        ensure_units_already_tracked(&local.tree()?, &followed)?;
        followed
    };
    let annotated = if held.is_empty() {
        annotated
    } else {
        repo.find_annotated_commit(remote_without(&repo, remote_oid, &held)?)?
    };

    let mut merge_opts = MergeOptions::new();
    let mut checkout = CheckoutBuilder::new();
    checkout
        .allow_conflicts(true)
        .conflict_style_merge(true)
        .our_label(OUR_LABEL)
        .their_label(THEIR_LABEL);
    repo.merge(&[&annotated], Some(&mut merge_opts), Some(&mut checkout))?;

    // From here the repo carries MERGE_* state; a failure that leaves it
    // behind would trip `ensure_clean_state` on every later cycle and wedge
    // sync until a manual repair — exactly what this design forbids. Clear it
    // on every path; the next cycle re-derives anything a failed attempt lost.
    let result = complete_merge(&repo, root, remote_oid, &held, &followed, local_only);
    if result.is_err() {
        let _ = repo.cleanup_state();
    }
    let (conflicted_paths, changed_files, frozen_paths) = result?;

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
    })
}

/// What a pull with local-only folders does with each changed path, decided
/// before anything is written.
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

fn plan_pull(root: &Path, folders: &LocalOnlyFolders, changes: Vec<ChangedFile>) -> PullPlan {
    let mut plan = PullPlan {
        allowed: Vec::new(),
        units: Vec::new(),
        frozen: Vec::new(),
    };
    for change in changes {
        match frozen_unit(root, folders, &change.path) {
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
         --cached on {them}, then commit and push), or restore the backup repository from a \
         good copy, then sync again.",
        untracked.join(", ")
    )))
}

/// Refuse, before anything is written, a write that would replace a
/// working-tree folder holding a local-only folder or link (another device
/// turned `people/` into a file): the checkout would delete the folder,
/// notes and all, and history has no copy of them.
fn ensure_no_folder_replaced(
    root: &Path,
    folders: &LocalOnlyFolders,
    writes: &[ChangedFile],
) -> AppResult<()> {
    for change in writes {
        if holds_local_only(&root.join(&change.path), folders) {
            return Err(AppError::io(format!(
                "Sync paused: another device replaced the folder \"{}\", which holds a \
                 local-only folder, with a file. Move the local-only folder out of it, then \
                 sync again.",
                change.path
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

/// Check out exactly `changes` from `tree`, forcibly (the pre-merge
/// invariant holds for every path outside local-only folders), into the
/// working tree only: the caller writes the index once, afterwards. An empty
/// pathspec would mean every path, so no changes means no checkout.
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
/// anything, a remote change that would replace a folder holding a
/// local-only folder.
fn held_units(
    repo: &Repository,
    root: &Path,
    folders: &LocalOnlyFolders,
    remote_oid: git2::Oid,
) -> AppResult<Vec<String>> {
    let local = repo.head()?.peel_to_commit()?;
    let remote = repo.find_commit(remote_oid)?;
    let remote_tree = remote.tree()?;
    let plan = plan_pull(
        root,
        folders,
        changed_between(repo, Some(&local.tree()?), &remote_tree)?,
    );
    // The merge writes only where the remote changed since the base.
    let base_tree = match repo.merge_base(local.id(), remote_oid) {
        Ok(base) => Some(repo.find_commit(base)?.tree()?),
        Err(_) => None,
    };
    let mut writes = changed_between(repo, base_tree.as_ref(), &remote_tree)?;
    writes.retain(|change| !under_any(&plan.units, &change.path));
    ensure_no_folder_replaced(root, folders, &writes)?;
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
/// both parents, and clear the merge state. Split out so [`merge_remote`] can
/// guarantee `cleanup_state` runs even when any step here fails. Returns the
/// conflicted paths and every file the merge changed relative to local HEAD.
fn complete_merge(
    repo: &Repository,
    root: &Path,
    remote_oid: git2::Oid,
    held: &[String],
    followed: &[String],
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<(Vec<String>, Vec<ChangedFile>, Vec<String>)> {
    let mut index = repo.index()?;
    let conflicted_paths = resolve_conflicts(repo, root, &mut index, local_only)?;
    let local_commit = repo.head()?.peel_to_commit()?;
    let remote_commit = repo.find_commit(remote_oid)?;
    let remote_tree = remote_commit.tree()?;
    // Held units merged as this device's version; where the other device
    // changed one (`followed`), history takes its version instead. The files
    // stay frozen.
    follow_tree_in_index(repo, &mut index, &remote_tree, followed)?;
    index.write()?;
    let frozen_paths: Vec<String> =
        changed_between(repo, Some(&local_commit.tree()?), &remote_tree)?
            .into_iter()
            .map(|change| change.path)
            .filter(|path| under_any(followed, path))
            .collect();

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

/// Diff two trees into the watcher's change shape: what the merge wrote or
/// removed on disk relative to the previous local HEAD.
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
    Ok(out)
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
///   alongside (`name (conflict).ext`);
/// - **deleted on both** — confirm the removal.
fn resolve_conflicts(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
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
                    repo, root, index, our, their, local_only,
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
/// write the other device's version alongside (`name (conflict).ext`).
fn resolve_both_edited(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
    our: ConflictSide,
    their: ConflictSide,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<Vec<String>> {
    let binary = repo.find_blob(our.id)?.is_binary() || repo.find_blob(their.id)?.is_binary();
    if !binary {
        index.add_path(Path::new(&our.path))?;
        return Ok(vec![our.path]);
    }
    write_blob(repo, root, &our.path, our.id, local_only)?;
    let copy = conflict_copy_path(&their.path);
    write_blob(repo, root, &copy, their.id, local_only)?;
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
/// the target goes through the write guard: `fs::write` follows symlinks,
/// and a held path can never conflict, so a refusal here is a bug surfacing
/// loudly rather than a write through a link.
fn write_blob(
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

/// `assets/img.png` → `assets/img (conflict).png`; no extension → appended.
/// Splits on the basename only — a dot in a *directory* name (`assets.v1/x`)
/// must not relocate the copy out of the file's directory.
fn conflict_copy_path(rel: &str) -> String {
    let (dir, file) = match rel.rsplit_once('/') {
        Some((dir, file)) => (Some(dir), file),
        None => (None, rel),
    };
    let renamed = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} (conflict).{ext}"),
        _ => format!("{file} (conflict)"),
    };
    match dir {
        Some(dir) => format!("{dir}/{renamed}"),
        None => renamed,
    }
}

#[cfg(test)]
mod path_tests {
    use super::conflict_copy_path;

    #[test]
    fn conflict_copies_stay_in_their_directory() {
        assert_eq!(
            conflict_copy_path("assets/img.png"),
            "assets/img (conflict).png"
        );
        assert_eq!(
            conflict_copy_path("assets.v1/img"),
            "assets.v1/img (conflict)"
        );
        assert_eq!(
            conflict_copy_path("assets.v1/img.png"),
            "assets.v1/img (conflict).png"
        );
        assert_eq!(conflict_copy_path("topfile.bin"), "topfile (conflict).bin");
        assert_eq!(conflict_copy_path("noext"), "noext (conflict)");
        assert_eq!(
            conflict_copy_path("assets/.hidden"),
            "assets/.hidden (conflict)"
        );
    }
}
