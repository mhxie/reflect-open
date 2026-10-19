//! The note revisions the latest pull moved aside, per graph. A pull that
//! displaces this device's note writes the other device's file at its path;
//! an open editor on that path still holds the displaced revision as its base,
//! and its next checked write must not merge this device's edits (kept-out
//! bytes included) into the incoming note. So a checked write that names one
//! of these revisions at the path it moved from is refused
//! (`write_note_revision`), and the editor follows the copy on
//! `note:displaced` instead, as it does after any refused save.
//!
//! Each pull replaces its graph's record under the graph lock, so a write
//! never sees a half-updated one; a graph open clears it. Only fingerprints
//! are kept, never note text.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};

use crate::hash::sha256_hex;

/// Per graph root: each displaced path and the fingerprints of the revisions
/// moved away from it.
type Record = HashMap<PathBuf, HashMap<String, HashSet<String>>>;

static RECORD: LazyLock<Mutex<Record>> = LazyLock::new(Mutex::default);

/// The root the record is keyed by: canonical when it resolves, so two
/// spellings of one graph share it.
fn key(root: &Path) -> PathBuf {
    root.canonicalize().unwrap_or_else(|_| root.to_path_buf())
}

fn fingerprint(text: &str) -> String {
    sha256_hex(text.as_bytes())
}

/// Replace the record of the graph at `root` with `revisions`: each path a
/// pull moved an entry away from, and that entry's text as `note_read`
/// returns it (a path may carry several). An empty list clears the record.
/// The caller holds the graph lock.
pub fn replace(root: &Path, revisions: impl IntoIterator<Item = (String, String)>) {
    let mut paths: HashMap<String, HashSet<String>> = HashMap::new();
    for (path, text) in revisions {
        paths.entry(path).or_default().insert(fingerprint(&text));
    }
    let key = key(root);
    let mut record = RECORD.lock().unwrap_or_else(PoisonError::into_inner);
    if paths.is_empty() {
        record.remove(&key);
    } else {
        record.insert(key, paths);
    }
}

/// Forget the record of the graph at `root`: it closed, or another opened.
pub fn clear(root: &Path) {
    let key = key(root);
    RECORD
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&key);
}

/// Whether `text` is a revision the latest pull moved away from `rel` in the
/// graph at `root`.
pub fn names(root: &Path, rel: &str, text: &str) -> bool {
    let key = key(root);
    let record = RECORD.lock().unwrap_or_else(PoisonError::into_inner);
    record
        .get(&key)
        .and_then(|paths| paths.get(rel))
        .is_some_and(|recorded| recorded.contains(&fingerprint(text)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pull_replaces_the_record_and_an_empty_one_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        replace(root, [("notes/a.md".to_string(), "# Mine\n".to_string())]);
        assert!(names(root, "notes/a.md", "# Mine\n"));
        assert!(!names(root, "notes/a.md", "# Theirs\n"));
        assert!(!names(root, "notes/b.md", "# Mine\n"));

        replace(root, [("notes/b.md".to_string(), "# B\n".to_string())]);
        assert!(!names(root, "notes/a.md", "# Mine\n"));
        assert!(names(root, "notes/b.md", "# B\n"));

        replace(root, std::iter::empty());
        assert!(!names(root, "notes/b.md", "# B\n"));
    }

    /// A path moved aside twice (a retry's earlier attempt, then the retry)
    /// names both revisions.
    #[test]
    fn a_path_keeps_every_revision_moved_from_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        replace(
            root,
            [
                ("notes/a.md".to_string(), "# First\n".to_string()),
                ("notes/a.md".to_string(), "# Second\n".to_string()),
            ],
        );
        assert!(names(root, "notes/a.md", "# First\n"));
        assert!(names(root, "notes/a.md", "# Second\n"));
        assert!(!names(root, "notes/a.md", "# Theirs\n"));
    }

    #[test]
    fn each_graph_keeps_its_own_record() {
        let (one, two) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        replace(
            one.path(),
            [("notes/a.md".to_string(), "# Mine\n".to_string())],
        );
        assert!(!names(two.path(), "notes/a.md", "# Mine\n"));
        clear(one.path());
        assert!(!names(one.path(), "notes/a.md", "# Mine\n"));
    }

    /// Two spellings of one graph root share its record.
    #[test]
    fn the_record_is_keyed_by_the_canonical_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("graph");
        std::fs::create_dir_all(&root).unwrap();
        replace(&root, [("notes/a.md".to_string(), "# Mine\n".to_string())]);
        assert!(names(&root.join("."), "notes/a.md", "# Mine\n"));
    }
}
