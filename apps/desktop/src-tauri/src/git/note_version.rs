//! Read the last commit for one literal note path without inspecting working bytes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use git2::{Commit, ErrorCode, Oid};

use crate::error::{AppError, AppResult};

use super::repo;

/// Versions already resolved against one graph's HEAD. History walks can be
/// long for an old note, and nothing they read changes until HEAD moves, so a
/// new HEAD (or another graph) replaces the whole set.
struct ResolvedVersions {
    root: PathBuf,
    head: Oid,
    versions: HashMap<String, Option<String>>,
}

static RESOLVED: Mutex<Option<ResolvedVersions>> = Mutex::new(None);

fn note_entry(commit: &Commit<'_>, path: &Path) -> AppResult<Option<(Oid, i32)>> {
    match commit.tree()?.get_path(path) {
        Ok(entry) => Ok(Some((entry.id(), entry.filemode()))),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn cached_version(root: &Path, head: Oid, path: &str) -> Option<Option<String>> {
    let resolved = RESOLVED.lock().unwrap_or_else(PoisonError::into_inner);
    resolved
        .as_ref()
        .filter(|resolved| resolved.head == head && resolved.root == root)
        .and_then(|resolved| resolved.versions.get(path).cloned())
}

fn remember_version(root: &Path, head: Oid, path: &str, version: Option<String>) {
    let mut resolved = RESOLVED.lock().unwrap_or_else(PoisonError::into_inner);
    let current = match resolved.take() {
        Some(current) if current.head == head && current.root == root => current,
        _ => ResolvedVersions {
            root: root.to_path_buf(),
            head,
            versions: HashMap::new(),
        },
    };
    let current = resolved.insert(current);
    current.versions.insert(path.to_string(), version);
}

/// Walk back from `commit` while some parent holds the same note entry. The
/// entry is fixed along the walk, so each step reads only the parents' trees.
fn last_change(mut commit: Commit<'_>, path: &Path) -> AppResult<Option<String>> {
    let Some(entry) = note_entry(&commit, path)? else {
        return Ok(None);
    };
    loop {
        let mut unchanged_parent = None;
        for index in 0..commit.parent_count() {
            let parent = commit.parent(index)?;
            if note_entry(&parent, path)? == Some(entry) {
                unchanged_parent = Some(parent);
                break;
            }
        }
        if let Some(parent) = unchanged_parent {
            commit = parent;
            continue;
        }
        let abbreviated = commit.as_object().short_id()?;
        let sha = abbreviated
            .as_str()
            .map_err(|_| AppError::parse("Git returned an invalid abbreviated commit id"))?;
        return Ok(Some(sha.to_string()));
    }
}

/// Return the last path-changing commit for a note present in HEAD's tree.
///
/// Tree lookup treats glob punctuation and Git pathspec prefixes literally.
/// When a merge retains a parent's note entry, follow that parent rather than
/// assigning the unrelated merge commit or a discarded branch's version.
/// Results are reused until HEAD moves.
pub(super) fn note_version(root: &Path, path: &str) -> AppResult<Option<String>> {
    if !reflect_graph_paths::is_note(path) {
        return Err(AppError::traversal(format!(
            "expected a canonical graph-relative note path: {path:?}"
        )));
    }
    if !root.join(".git").exists() {
        return Ok(None);
    }
    let repository = repo::open_existing(root)?;
    let commit = match repository.head() {
        Ok(head) => head.peel_to_commit()?,
        Err(error) if matches!(error.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => {
            return Ok(None)
        }
        Err(error) => return Err(error.into()),
    };
    let head = commit.id();
    if let Some(version) = cached_version(root, head, path) {
        return Ok(version);
    }
    let version = last_change(commit, Path::new(path))?;
    remember_version(root, head, path, version.clone());
    Ok(version)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use git2::{Repository, Signature};
    use tempfile::tempdir;

    use super::*;

    fn commit_note(repository: &Repository, path: &str, content: &str) -> Oid {
        let root = repository.workdir().unwrap();
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, content).unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new(path)).unwrap();
        index.write().unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repository.find_tree(tree_id).unwrap();
        let signature = Signature::now("Reflect", "tests@reflect.app").unwrap();
        let parent = repository
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&Commit<'_>> = parent.iter().collect();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "note edit",
                &tree,
                &parents,
            )
            .unwrap()
    }

    fn short_sha(repository: &Repository, oid: Oid) -> String {
        repository
            .find_object(oid, None)
            .unwrap()
            .short_id()
            .unwrap()
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn version_comes_from_the_note_commit_not_unrelated_graph_commits() {
        let graph = tempdir().unwrap();
        let repository = Repository::init(graph.path()).unwrap();
        let first = commit_note(&repository, "notes/first.md", "first version");
        commit_note(&repository, "notes/second.md", "unrelated note");
        assert_eq!(
            note_version(graph.path(), "notes/first.md").unwrap(),
            Some(short_sha(&repository, first))
        );
        let updated = commit_note(&repository, "notes/first.md", "next version");
        assert_eq!(
            note_version(graph.path(), "notes/first.md").unwrap(),
            Some(short_sha(&repository, updated))
        );
    }

    #[test]
    fn working_changes_and_uncommitted_notes_do_not_create_versions() {
        let graph = tempdir().unwrap();
        let repository = Repository::init(graph.path()).unwrap();
        let committed = commit_note(&repository, "notes/committed.md", "committed version");
        fs::write(graph.path().join("notes/committed.md"), "unsaved to Git").unwrap();
        fs::write(graph.path().join("notes/new.md"), "not committed").unwrap();
        assert_eq!(
            note_version(graph.path(), "notes/committed.md").unwrap(),
            Some(short_sha(&repository, committed))
        );
        assert_eq!(note_version(graph.path(), "notes/new.md").unwrap(), None);
        assert_eq!(
            note_version(graph.path(), "notes/missing.md").unwrap(),
            None
        );
    }

    #[test]
    fn no_repository_or_unborn_history_has_no_note_version() {
        let graph = tempdir().unwrap();
        assert_eq!(note_version(graph.path(), "notes/note.md").unwrap(), None);
        assert!(!graph.path().join(".git").exists());
        Repository::init(graph.path()).unwrap();
        assert_eq!(note_version(graph.path(), "notes/note.md").unwrap(), None);
    }

    #[test]
    fn a_recreated_uncommitted_note_does_not_show_its_deletion_commit() {
        let graph = tempdir().unwrap();
        let repository = Repository::init(graph.path()).unwrap();
        let note_path = "notes/recreated.md";
        let original = commit_note(&repository, note_path, "original version");
        fs::remove_file(graph.path().join(note_path)).unwrap();
        let mut index = repository.index().unwrap();
        index.remove_path(Path::new(note_path)).unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
        let parent = repository.find_commit(original).unwrap();
        let signature = Signature::now("Reflect", "tests@reflect.app").unwrap();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "delete note",
                &tree,
                &[&parent],
            )
            .unwrap();
        fs::write(graph.path().join(note_path), "recreated but not committed").unwrap();

        assert_eq!(note_version(graph.path(), note_path).unwrap(), None);
        let recreated = commit_note(&repository, note_path, "recreated committed version");
        assert_eq!(
            note_version(graph.path(), note_path).unwrap(),
            Some(short_sha(&repository, recreated))
        );
    }

    #[test]
    fn rejects_paths_outside_the_canonical_note_policy() {
        let graph = tempdir().unwrap();
        for path in [
            "../outside.md",
            "/absolute.md",
            "C:/outside.md",
            "notes\\outside.md",
            "notes/../outside.md",
            "notes//note.md",
            "notes/./note.md",
            ".hidden/note.md",
            "notes/.hidden.md",
            "assets/note.md",
            "audio-memos/note.md",
            "notes/note.MD",
            "",
        ] {
            assert!(
                matches!(
                    note_version(graph.path(), path),
                    Err(AppError::Traversal { .. })
                ),
                "{path:?}"
            );
        }
    }

    #[test]
    fn spaces_and_unicode_paths_are_literal() {
        let graph = tempdir().unwrap();
        let repository = Repository::init(graph.path()).unwrap();
        let path = "notes/研究 notes.md";
        let committed = commit_note(&repository, path, "literal note");
        commit_note(&repository, "notes/other.md", "another note");
        assert_eq!(
            note_version(graph.path(), path).unwrap(),
            Some(short_sha(&repository, committed))
        );
    }

    #[cfg(unix)]
    #[test]
    fn glob_characters_and_pathspec_magic_do_not_expand() {
        let graph = tempdir().unwrap();
        let repository = Repository::init(graph.path()).unwrap();
        for path in ["notes/[draft]*?.md", ":(glob)*.md"] {
            let committed = commit_note(&repository, path, "literal note");
            commit_note(&repository, "notes/draft-other.md", "glob should not match");
            assert_eq!(
                note_version(graph.path(), path).unwrap(),
                Some(short_sha(&repository, committed))
            );
        }
    }

    #[test]
    fn an_unchanged_merge_follows_the_retained_notes_parent() {
        let graph = tempdir().unwrap();
        let repository = Repository::init(graph.path()).unwrap();
        let original = commit_note(&repository, "notes/note.md", "original note");
        let discarded = commit_note(&repository, "notes/note.md", "discarded branch note");
        let original_commit = repository.find_commit(original).unwrap();
        let discarded_commit = repository.find_commit(discarded).unwrap();
        let retained_tree = original_commit.tree().unwrap();
        let signature = Signature::now("Reflect", "tests@reflect.app").unwrap();
        repository.set_head_detached(original).unwrap();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "merge retaining original note",
                &retained_tree,
                &[&original_commit, &discarded_commit],
            )
            .unwrap();
        assert_eq!(
            note_version(graph.path(), "notes/note.md").unwrap(),
            Some(short_sha(&repository, original))
        );
    }

    #[test]
    fn a_merge_can_retain_the_second_parents_note_version() {
        let graph = tempdir().unwrap();
        let repository = Repository::init(graph.path()).unwrap();
        let original = commit_note(&repository, "notes/note.md", "original note");
        let retained = commit_note(&repository, "notes/note.md", "retained branch note");
        let original_commit = repository.find_commit(original).unwrap();
        let retained_commit = repository.find_commit(retained).unwrap();
        let retained_tree = retained_commit.tree().unwrap();
        let signature = Signature::now("Reflect", "tests@reflect.app").unwrap();
        repository.set_head_detached(original).unwrap();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "merge retaining branch note",
                &retained_tree,
                &[&original_commit, &retained_commit],
            )
            .unwrap();
        assert_eq!(
            note_version(graph.path(), "notes/note.md").unwrap(),
            Some(short_sha(&repository, retained))
        );
    }

    #[test]
    fn a_merge_that_changes_both_parent_versions_is_the_notes_version() {
        let graph = tempdir().unwrap();
        let repository = Repository::init(graph.path()).unwrap();
        let original = commit_note(&repository, "notes/note.md", "original note");
        let branch = commit_note(&repository, "notes/note.md", "branch note");
        let resolution = commit_note(&repository, "notes/note.md", "resolved note");
        let original_commit = repository.find_commit(original).unwrap();
        let branch_commit = repository.find_commit(branch).unwrap();
        let resolved_tree = repository.find_commit(resolution).unwrap().tree().unwrap();
        let signature = Signature::now("Reflect", "tests@reflect.app").unwrap();
        repository.set_head_detached(original).unwrap();
        let merged = repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "merge resolving note",
                &resolved_tree,
                &[&original_commit, &branch_commit],
            )
            .unwrap();
        assert_eq!(
            note_version(graph.path(), "notes/note.md").unwrap(),
            Some(short_sha(&repository, merged))
        );
    }

    #[test]
    fn a_moved_head_resolves_again_instead_of_reusing_the_previous_version() {
        let graph = tempdir().unwrap();
        let repository = Repository::init(graph.path()).unwrap();
        let first = commit_note(&repository, "notes/note.md", "first version");
        let second = commit_note(&repository, "notes/note.md", "second version");
        assert_eq!(
            note_version(graph.path(), "notes/note.md").unwrap(),
            Some(short_sha(&repository, second))
        );
        assert_eq!(
            note_version(graph.path(), "notes/note.md").unwrap(),
            Some(short_sha(&repository, second))
        );
        repository.set_head_detached(first).unwrap();
        assert_eq!(
            note_version(graph.path(), "notes/note.md").unwrap(),
            Some(short_sha(&repository, first))
        );
    }
}
