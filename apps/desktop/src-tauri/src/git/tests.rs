//! Integration tests for the git primitives, exercised against tempdir graphs
//! and a local bare "remote" (libgit2's local transport — no network, no
//! credentials, same code paths as HTTPS apart from auth).

use std::fs;
use std::path::{Path, PathBuf};

use git2::{Repository, RepositoryInitOptions};
use tempfile::{tempdir, TempDir};

use super::commit::commit_all;
use super::displace::DisplacedFile;
use super::max_file_size::DEFAULT_MAX_FILE_BYTES as MAX_FILE_BYTES;
use super::merge::{MergeKind, MergeOutcome, PullPolicy};
use super::remote::{fetch, push};
use super::{setup, status};
use crate::error::AppResult;
use reflect_graph_paths::LocalOnlyFolders;

/// Pull with the default size limit, the way most tests need it; the
/// entries left displaced are in the outcome.
fn merge_remote(
    root: &Path,
    local_only: Option<&LocalOnlyFolders>,
    accepted_roots: &[git2::Oid],
) -> AppResult<MergeOutcome> {
    pull(root, local_only, accepted_roots, MAX_FILE_BYTES).0
}

/// Pull with an explicit size limit, returning the result and every entry
/// the pull left displaced, which a failed pull reports too.
fn pull(
    root: &Path,
    local_only: Option<&LocalOnlyFolders>,
    accepted_roots: &[git2::Oid],
    max_file_bytes: u64,
) -> (AppResult<MergeOutcome>, Vec<DisplacedFile>) {
    let policy = PullPolicy {
        local_only,
        accepted_roots,
        max_file_bytes,
    };
    let mut displaced = Vec::new();
    let outcome = super::merge::merge_remote(root, &policy, &mut displaced);
    (outcome, displaced)
}

/// Scaffold a minimal graph layout (what `fs::bootstrap` produces).
fn scaffold_graph(root: &Path) {
    for dir in ["daily", "notes", "assets", ".reflect"] {
        fs::create_dir_all(root.join(dir)).unwrap();
    }
    fs::write(
        root.join(".gitignore"),
        crate::graph_gitignore::default_contents(),
    )
    .unwrap();
    fs::write(root.join(".reflect/index.sqlite"), "not a real db").unwrap();
}

fn write(root: &Path, rel: &str, contents: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn read(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

fn head_message(root: &Path) -> String {
    let repo = Repository::open(root).unwrap();
    let commit = repo.head().unwrap().peel_to_commit().unwrap();
    commit.message().unwrap().trim().to_string()
}

fn head_oid(root: &Path) -> git2::Oid {
    Repository::open(root)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
}

/// A bare remote + a primary graph connected to it.
struct Fixture {
    _dir: TempDir,
    remote_url: String,
    graph_a: PathBuf,
}

fn fixture() -> Fixture {
    let dir = tempdir().unwrap();
    let bare = dir.path().join("remote.git");
    let mut opts = RepositoryInitOptions::new();
    opts.bare(true).initial_head("main");
    Repository::init_opts(&bare, &opts).unwrap();
    let remote_url = bare.to_string_lossy().into_owned();

    let graph_a = dir.path().join("graph-a");
    scaffold_graph(&graph_a);
    setup(&graph_a, Some(remote_url.clone()), None).unwrap();

    Fixture {
        _dir: dir,
        remote_url,
        graph_a,
    }
}

/// Clone the remote into a second "device". `commit_all`/`merge_remote` only
/// need a repo at the root, so the clone stands in for a second graph.
fn second_device(fixture: &Fixture) -> PathBuf {
    let root = fixture._dir.path().join("graph-b");
    Repository::clone(&fixture.remote_url, &root).unwrap();
    root
}

fn head_tree_paths(root: &Path) -> Vec<String> {
    let repo = Repository::open(root).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    let mut paths = Vec::new();
    tree.walk(git2::TreeWalkMode::PreOrder, |prefix, entry| {
        if entry.kind() == Some(git2::ObjectType::Blob) {
            paths.push(format!("{prefix}{}", entry.name().unwrap_or("")));
        }
        git2::TreeWalkResult::Ok
    })
    .unwrap();
    paths
}

#[test]
fn setup_initializes_main_and_origin() {
    let fixture = fixture();
    let status = status(&fixture.graph_a).unwrap();
    assert!(status.initialized);
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert_eq!(
        status.remote_url.as_deref(),
        Some(fixture.remote_url.as_str())
    );
    assert!(!status.in_progress);
}

#[test]
fn setup_creates_graph_gitignore_defaults_when_missing() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("graph");
    fs::create_dir_all(&root).unwrap();

    setup(&root, None, None).unwrap();

    let gitignore = read(&root, ".gitignore");
    assert!(gitignore.contains("/.reflect/"));
    assert!(gitignore.contains(".DS_Store"));
    assert!(gitignore.contains("Thumbs.db"));
    assert!(gitignore.contains("*.swp"));
}

#[test]
fn commit_excludes_reflect_and_skips_when_clean() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");

    let first = commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert!(first.committed);
    assert!(first.sha.is_some());

    let paths = head_tree_paths(root);
    assert!(paths.contains(&"notes/a.md".to_string()));
    assert!(paths.contains(&".gitignore".to_string()));
    assert!(
        !paths.iter().any(|path| path.starts_with(".reflect")),
        ".reflect/ leaked into backup: {paths:?}"
    );

    let second = commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert!(!second.committed, "clean tree must not produce a commit");
}

#[test]
fn commit_describes_single_note_changes() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(root, "notes/project-atlas.md", "# Project Atlas\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Add Project Atlas");

    write(
        root,
        "notes/project-atlas.md",
        "# Project Atlas\n\nNext step\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Update Project Atlas");

    fs::remove_file(root.join("notes/project-atlas.md")).unwrap();
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Delete Project Atlas");
}

#[test]
fn commit_uses_authored_note_subjects() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(
        root,
        "notes/01arz3ndektsv4rrffq69g5fav.md",
        "---\ntitle: \"Project #1\"\n---\n# Ignored H1\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Add Project #1");

    write(
        root,
        "notes/01arz3ndektsv4rrffq69g5fav.md",
        "# Launch Review\n\n- agenda\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Update Launch Review");

    fs::remove_file(root.join("notes/01arz3ndektsv4rrffq69g5fav.md")).unwrap();
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Delete Launch Review");
}

#[test]
fn commit_describes_note_renames() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(
        root,
        "notes/original.md",
        "# Original Name\n\n- stable body line one\n- stable body line two\n- stable body line three\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();

    fs::remove_file(root.join("notes/original.md")).unwrap();
    write(
        root,
        "notes/renamed.md",
        "# Renamed Name\n\n- stable body line one\n- stable body line two\n- stable body line three\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Rename Original Name to Renamed Name");
}

#[test]
fn commit_does_not_leak_private_authored_titles() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(
        root,
        "notes/private-project.md",
        "---\nprivate: true\ntitle: Secret Plan\n---\n# Secret Heading\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Add private note");

    // The shared classifier unwraps a tagged value...
    write(root, "notes/tagged.md", "# Tagged Plan\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Add Tagged Plan");
    write(
        root,
        "notes/tagged.md",
        "---\nprivate: !x true\n---\n# Tagged Plan\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Update private note");

    // ...and treats frontmatter it can't read, but that mentions private, as
    // locked.
    write(root, "notes/unreadable.md", "# Unreadable Plan\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    write(
        root,
        "notes/unreadable.md",
        "---\nprivate: no\ntitle: [Unreadable Plan\n---\n# Unreadable Plan\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Update private note");

    // A locked note renamed names neither side.
    fs::rename(
        root.join("notes/private-project.md"),
        root.join("notes/renamed-project.md"),
    )
    .unwrap();
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Rename private note");
}

#[test]
fn commit_never_labels_a_non_utf8_private_note_by_its_path() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    // Privacy is decided on the raw blob, so the path-derived label ("Secret
    // Plan") can't stand in for a title the UTF-8 reader couldn't read.
    fs::write(
        root.join("notes/secret-plan.md"),
        b"---\nprivate: true\n---\n\xff\xfe Secret\n",
    )
    .unwrap();
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Add private note");
}

#[test]
fn commit_summarizes_note_batches() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(root, "daily/2026-06-23.md", "# Daily\n");
    write(root, "notes/project-atlas.md", "# Project Atlas\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Add 2 notes");

    write(root, "daily/2026-06-23.md", "# Daily\n\n- one\n");
    write(
        root,
        "notes/project-atlas.md",
        "# Project Atlas\n\nNext step\n",
    );
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Update 2 notes");
}

#[test]
fn commit_mentions_note_and_attachment_batches() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(root, "notes/capture.md", "# Capture\n");
    write(root, "assets/screenshot.png", "not really a png\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Add 1 note and 1 attachment");
}

#[test]
fn commit_describes_mixed_note_and_file_batches_by_action() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    write(root, "notes/capture.md", "# Capture\n");
    write(root, "books/book.json", "{}\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Add 1 note and 1 file");
}

#[test]
fn commit_falls_back_for_metadata_only_changes() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Update notes");
}

#[test]
fn commit_records_deletions() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/gone.md", "# Gone\n");
    commit_all(root, "add", MAX_FILE_BYTES, None).unwrap();

    fs::remove_file(root.join("notes/gone.md")).unwrap();
    let outcome = commit_all(root, "delete", MAX_FILE_BYTES, None).unwrap();
    assert!(outcome.committed);
    assert!(!head_tree_paths(root).contains(&"notes/gone.md".to_string()));
}

#[test]
fn oversized_files_are_skipped_and_reported() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    // Commit the scaffold first: tracked-but-unchanged files (like the
    // .gitignore, larger than the tiny test threshold) must NOT be reported —
    // only files whose changes are actually being withheld.
    commit_all(root, "scaffold", MAX_FILE_BYTES, None).unwrap();

    write(root, "notes/small.md", "tiny\n");
    write(root, "assets/huge.bin", "0123456789abcdef");

    let outcome = commit_all(root, "guarded", 10, None).unwrap();
    assert!(outcome.committed);
    assert_eq!(
        outcome.skipped_large_files.len(),
        1,
        "{:?}",
        outcome.skipped_large_files
    );
    assert_eq!(outcome.skipped_large_files[0].path, "assets/huge.bin");

    let paths = head_tree_paths(root);
    assert!(paths.contains(&"notes/small.md".to_string()));
    assert!(!paths.contains(&"assets/huge.bin".to_string()));
}

#[test]
fn push_and_fetch_round_trip() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    let first = commit_all(root, "first", MAX_FILE_BYTES, None).unwrap();
    assert!(first.ahead >= 1, "{first:?}");

    let outcome = push(root, None, &[]).unwrap();
    assert!(outcome.pushed, "push failed: {outcome:?}");

    let delta = fetch(root, None).unwrap();
    assert_eq!(delta.ahead, 0);
    assert_eq!(delta.behind, 0);

    // The engine's skip condition: a clean no-op commit that is also not
    // ahead means there is nothing to push at all.
    let idle = commit_all(root, "noop", MAX_FILE_BYTES, None).unwrap();
    assert!(!idle.committed);
    assert_eq!(idle.ahead, 0);
}

#[test]
fn disconnect_drops_origin_but_keeps_history() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "first", MAX_FILE_BYTES, None).unwrap();
    push(root, None, &[]).unwrap();

    let after = super::disconnect(root).unwrap();
    assert!(after.initialized);
    assert!(after.remote_url.is_none());
    assert!(head_tree_paths(root).contains(&"notes/a.md".to_string()));

    // Idempotent, and reconnecting works.
    super::disconnect(root).unwrap();
    let reconnected = setup(root, Some(fixture.remote_url.clone()), None).unwrap();
    assert!(reconnected.remote_url.is_some());
}

#[test]
fn clone_restores_a_backup_into_an_empty_destination() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "first", MAX_FILE_BYTES, None).unwrap();
    push(root, None, &[]).unwrap();

    let target = fixture._dir.path().join("restored");
    super::remote::clone(&fixture.remote_url, &target, None).unwrap();
    assert_eq!(read(&target, "notes/a.md"), "# A\n");

    // A non-empty destination is refused — a restore must never overwrite.
    let occupied = fixture._dir.path().join("occupied");
    fs::create_dir_all(&occupied).unwrap();
    fs::write(occupied.join("keep.txt"), "existing").unwrap();
    assert!(super::remote::clone(&fixture.remote_url, &occupied, None).is_err());
}

#[test]
fn first_sync_against_an_empty_remote_pushes() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "first", MAX_FILE_BYTES, None).unwrap();

    // The engine's launch cycle is commit → fetch → merge → push. A brand-new
    // backup repo has no remote branch yet; that must not error the cycle
    // before the push that creates it (PR #96 review).
    let delta = fetch(root, None).unwrap();
    assert_eq!(delta.behind, 0);
    assert!(delta.ahead >= 1, "local commits count as ahead: {delta:?}");
    let merged = merge_remote(root, None, &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::UpToDate), "{merged:?}");
    assert!(push(root, None, &[]).unwrap().pushed);
}

#[test]
fn connecting_an_existing_backup_on_another_branch_pulls_its_history() {
    let dir = tempdir().unwrap();
    let bare = dir.path().join("remote.git");
    let mut opts = RepositoryInitOptions::new();
    opts.bare(true).initial_head("master");
    Repository::init_opts(&bare, &opts).unwrap();
    let remote_url = bare.to_string_lossy().into_owned();

    // Seed the remote with existing history on `master` (the user's old repo).
    let seed = dir.path().join("seed");
    fs::create_dir_all(&seed).unwrap();
    let mut seed_opts = RepositoryInitOptions::new();
    seed_opts.initial_head("master");
    Repository::init_opts(&seed, &seed_opts).unwrap();
    setup(&seed, Some(remote_url.clone()), None).unwrap();
    write(&seed, "notes/existing.md", "# Existing\n");
    commit_all(&seed, "seed", MAX_FILE_BYTES, None).unwrap();
    push(&seed, None, &[]).unwrap();

    // A fresh graph (local default would be `main`) connects to it; the
    // GitHub API reports `master` as the default branch and setup aligns the
    // local branch — without this, merge looks for origin/main, sees nothing,
    // and push creates a parallel branch instead of integrating the backup
    // (PR #96 review).
    let root = dir.path().join("graph");
    scaffold_graph(&root);
    setup(&root, Some(remote_url), Some("master".to_string())).unwrap();
    assert_eq!(status(&root).unwrap().branch.as_deref(), Some("master"));

    // The engine's launch cycle: the local root commit and the remote history
    // are unrelated, so the merge pauses, naming both roots, until the graph
    // accepts the backup's root and its own (which the joined history
    // uploads); then it integrates them.
    commit_all(&root, "local notes", MAX_FILE_BYTES, None).unwrap();
    fetch(&root, None).unwrap();
    let accepted = [head_oid(&seed), head_oid(&root)];
    let message = paused_message(merge_remote(&root, None, &[]).unwrap_err());
    for id in accepted {
        assert!(message.contains(&id.to_string()), "{message}");
    }
    let merged = merge_remote(&root, None, &accepted).unwrap();
    assert!(
        matches!(
            merged.kind,
            MergeKind::Merged | MergeKind::MergedWithConflicts
        ),
        "{merged:?}"
    );
    assert!(push(&root, None, &accepted).unwrap().pushed);

    let paths = head_tree_paths(&root);
    assert!(
        paths.contains(&"notes/existing.md".to_string()),
        "{paths:?}"
    );
    assert!(paths.contains(&".gitignore".to_string()));
}

#[test]
fn aligning_onto_a_stale_local_branch_keeps_the_working_tree() {
    let fixture = fixture();
    let root = &fixture.graph_a;

    // History: commit 1, a stale local `master` pointing at it, then commit 2
    // on `main` with newer content.
    write(root, "notes/ours.md", "# Ours v1\n");
    commit_all(root, "v1", MAX_FILE_BYTES, None).unwrap();
    {
        let repo = Repository::open(root).unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("master", &head, false).unwrap();
    }
    write(root, "notes/ours.md", "# Ours v2\n");
    commit_all(root, "v2", MAX_FILE_BYTES, None).unwrap();

    // Aligning onto the stale name must keep our content (HEAD's commit and
    // the working tree are untouched — the stale branch loses the name, we
    // don't lose notes to its old tree).
    setup(root, None, Some("master".to_string())).unwrap();
    assert_eq!(status(root).unwrap().branch.as_deref(), Some("master"));
    assert_eq!(read(root, "notes/ours.md"), "# Ours v2\n");
    assert!(head_tree_paths(root).contains(&"notes/ours.md".to_string()));

    // And the repo is immediately usable: a no-op commit stays a no-op (the
    // tree still matches HEAD — nothing was silently reverted).
    let outcome = commit_all(root, "noop", MAX_FILE_BYTES, None).unwrap();
    assert!(!outcome.committed, "align must not desync tree and HEAD");
}

#[test]
fn non_fast_forward_push_is_rejected_as_data() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/b.md", "# B\n");
    commit_all(&root_b, "from b", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    write(root_a, "notes/c.md", "# C\n");
    commit_all(root_a, "from a", MAX_FILE_BYTES, None).unwrap();
    let rejected = push(root_a, None, &[]).unwrap();
    assert!(!rejected.pushed);
    assert!(
        rejected.non_fast_forward,
        "expected non-fast-forward, got: {rejected:?}"
    );

    // The standard recovery: fetch, merge (clean — different files), push.
    let delta = fetch(root_a, None).unwrap();
    assert_eq!(delta.behind, 1);
    assert_eq!(delta.ahead, 1);
    let merged = merge_remote(root_a, None, &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    // The merge reports what it wrote (b's note) so the caller can reindex
    // without depending on the file watcher — with the file's real mtime.
    assert_eq!(
        merged
            .changed_files
            .iter()
            .map(|change| change.path.as_str())
            .collect::<Vec<_>>(),
        vec!["notes/b.md"],
    );
    assert!(
        merged.changed_files[0].modified_ms.is_some(),
        "upserts carry the written file's mtime: {merged:?}"
    );
    assert!(push(root_a, None, &[]).unwrap().pushed);
}

#[test]
fn conflicting_edits_are_committed_with_labeled_markers() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/shared.md", "# Shared\n\noriginal line\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/shared.md", "# Shared\n\nedited on b\n");
    commit_all(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    write(root_a, "notes/shared.md", "# Shared\n\nedited on a\n");
    commit_all(root_a, "a edit", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a, None, &[]).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );
    assert_eq!(merged.conflicted_paths, vec!["notes/shared.md".to_string()]);
    assert!(
        merged
            .changed_files
            .iter()
            .any(|change| change.path == "notes/shared.md"),
        "{merged:?}"
    );

    let content = read(root_a, "notes/shared.md");
    assert!(content.contains("<<<<<<< this device"), "{content}");
    assert!(content.contains("edited on a"), "{content}");
    assert!(content.contains("edited on b"), "{content}");
    assert!(content.contains(">>>>>>> other device"), "{content}");

    // The conflict is committed: the repo is never wedged mid-merge, and the
    // push goes through so both devices converge on the same marked-up note.
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    assert!(push(root_a, None, &[]).unwrap().pushed);

    fetch(&root_b, None).unwrap();
    let converged = merge_remote(&root_b, None, &[]).unwrap();
    assert!(
        matches!(converged.kind, MergeKind::FastForward),
        "{converged:?}"
    );
    assert_eq!(read(&root_b, "notes/shared.md"), content);
}

#[test]
fn edit_vs_delete_keeps_the_edit() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/keep.md", "# Keep\n\noriginal\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/keep.md", "# Keep\n\nedited on b\n");
    commit_all(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    fs::remove_file(root_a.join("notes/keep.md")).unwrap();
    commit_all(root_a, "a delete", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a, None, &[]).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );

    let content = read(root_a, "notes/keep.md");
    assert!(content.contains("edited on b"), "{content}");
    assert!(head_tree_paths(root_a).contains(&"notes/keep.md".to_string()));
}

#[test]
fn binary_conflict_keeps_both_copies() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    fs::write(root_a.join("assets/img.bin"), b"\x00base\x01").unwrap();
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    let root_b = second_device(&fixture);
    fs::write(root_b.join("assets/img.bin"), b"\x00from-b\x01").unwrap();
    commit_all(&root_b, "b image", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    fs::write(root_a.join("assets/img.bin"), b"\x00from-a\x01").unwrap();
    commit_all(root_a, "a image", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a, None, &[]).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );

    assert_eq!(
        fs::read(root_a.join("assets/img.bin")).unwrap(),
        b"\x00from-a\x01"
    );
    assert_eq!(
        fs::read(root_a.join("assets/img (conflict).bin")).unwrap(),
        b"\x00from-b\x01"
    );
    let paths = head_tree_paths(root_a);
    assert!(paths.contains(&"assets/img.bin".to_string()));
    assert!(paths.contains(&"assets/img (conflict).bin".to_string()));
}

#[test]
fn detached_head_is_a_typed_error_not_a_panic() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "base", MAX_FILE_BYTES, None).unwrap();
    {
        let repo = Repository::open(root).unwrap();
        let oid = repo.head().unwrap().target().unwrap();
        repo.set_head_detached(oid).unwrap();
    }

    let err = merge_remote(root, None, &[]).unwrap_err();
    let crate::error::AppError::Io { message } = err else {
        panic!("expected an Io error, got {err:?}");
    };
    assert!(message.contains("detached HEAD"), "{message}");
    assert!(matches!(
        push(root, None, &[]).unwrap_err(),
        crate::error::AppError::Io { .. }
    ));
}

#[test]
fn merging_into_an_unborn_repo_adopts_the_remote_history() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "seed", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    // A fresh graph with no commits yet (unborn HEAD) connects to an existing
    // backup; the merge must adopt the remote history, not error on the
    // missing local branch.
    let root = fixture._dir.path().join("fresh");
    scaffold_graph(&root);
    setup(&root, Some(fixture.remote_url.clone()), None).unwrap();
    fetch(&root, None).unwrap();

    let merged = merge_remote(&root, None, &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(&root, "notes/a.md"), "# A\n");
    let upsert = merged
        .changed_files
        .iter()
        .find(|change| change.path == "notes/a.md")
        .expect("the adopted file is reported for reindexing");
    assert!(upsert.modified_ms.is_some(), "{merged:?}");
    assert!(head_tree_paths(&root).contains(&"notes/a.md".to_string()));
}

#[test]
fn rename_rename_conflict_keeps_both_names_and_confirms_the_removal() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(
        root_a,
        "notes/orig.md",
        "# Original\n\nshared content that travels with the rename\n",
    );
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    let root_b = second_device(&fixture);
    fs::rename(
        root_b.join("notes/orig.md"),
        root_b.join("notes/renamed-b.md"),
    )
    .unwrap();
    commit_all(&root_b, "b rename", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    fs::rename(
        root_a.join("notes/orig.md"),
        root_a.join("notes/renamed-a.md"),
    )
    .unwrap();
    commit_all(root_a, "a rename", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();

    // Rename detection turns this into three conflict groups: ours-only
    // (renamed-a), theirs-only (renamed-b), and ancestor-only (orig — gone on
    // both sides). The last one must be cleared from the index or the merge
    // tree could not be written at all.
    let merged = merge_remote(root_a, None, &[]).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );

    let paths = head_tree_paths(root_a);
    assert!(
        paths.contains(&"notes/renamed-a.md".to_string()),
        "{paths:?}"
    );
    assert!(
        paths.contains(&"notes/renamed-b.md".to_string()),
        "{paths:?}"
    );
    assert!(!paths.contains(&"notes/orig.md".to_string()), "{paths:?}");
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
}

#[cfg(unix)]
#[test]
fn failed_merge_completion_still_clears_the_merge_state() {
    use std::os::unix::fs::PermissionsExt;

    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/keep.md", "# Keep\n\noriginal\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/keep.md", "# Keep\n\nedited on b\n");
    commit_all(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    fs::remove_file(root_a.join("notes/keep.md")).unwrap();
    commit_all(root_a, "a delete", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();

    // Make restoring the surviving edit fail mid-completion: the notes
    // directory refuses new files, so write_blob cannot recreate keep.md.
    let notes_dir = root_a.join("notes");
    fs::set_permissions(&notes_dir, fs::Permissions::from_mode(0o555)).unwrap();
    let result = merge_remote(root_a, None, &[]);
    fs::set_permissions(&notes_dir, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(result.is_err(), "{result:?}");

    // The contract: a failed merge never wedges the repo mid-merge…
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    drop(repo);

    // …and the next cycle recovers on its own.
    let merged = merge_remote(root_a, None, &[]).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );
    assert_eq!(read(root_a, "notes/keep.md"), "# Keep\n\nedited on b\n");
}

#[test]
fn fetch_without_remote_is_a_typed_error() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("graph");
    scaffold_graph(&root);
    setup(&root, None, None).unwrap();
    let err = fetch(&root, None).unwrap_err();
    assert!(matches!(err, crate::error::AppError::NotFound { .. }));
}

#[test]
fn adopting_an_existing_repo_appends_graph_gitignore_defaults() {
    let dir = tempdir().unwrap();
    let root = dir.path().join("graph");
    scaffold_graph(&root);
    fs::write(root.join(".gitignore"), "node_modules/\n").unwrap();
    Repository::init(&root).unwrap();

    setup(&root, None, None).unwrap();
    let gitignore = read(&root, ".gitignore");
    assert!(gitignore.contains("node_modules/"));
    assert!(gitignore.contains("/.reflect/"));
    assert!(gitignore.contains(".DS_Store"));
    assert!(gitignore.contains("Thumbs.db"));
    assert!(gitignore.contains("*.swp"));

    // Idempotent: a second setup must not duplicate the entry.
    setup(&root, None, None).unwrap();
    let again = read(&root, ".gitignore");
    assert_eq!(again.matches(".reflect").count(), 1, "{again}");
    assert_eq!(again.matches(".DS_Store").count(), 1, "{again}");
    assert_eq!(again.matches("Thumbs.db").count(), 1, "{again}");
    assert_eq!(again.matches("*.swp").count(), 1, "{again}");
}

// ---- the Plan 17 rename matrix ----------------------------------------------
// Title renames now move files (delete+add in git terms). These pin the three
// new merge shapes: rename+edit must converge via rename detection, and the
// two genuinely new conflict shapes (add/add, rename/rename) must surface
// without wedging or losing content.

#[test]
fn rename_on_one_device_merges_with_edit_on_the_other() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    let base = "# Meeting Notes\n\n- agenda point one\n- agenda point two\n- agenda point three\n";
    write(root_a, "notes/01arz3ndektsv4rrffq69g5fav.md", base);
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    // Device B edits a body line of the old path.
    let root_b = second_device(&fixture);
    write(
        &root_b,
        "notes/01arz3ndektsv4rrffq69g5fav.md",
        "# Meeting Notes\n\n- agenda point one\n- agenda point two EDITED ON B\n- agenda point three\n",
    );
    commit_all(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    // Device A renames the file the way the rename pipeline does: the slug
    // path changes and the H1 line with it; the body is untouched.
    fs::remove_file(root_a.join("notes/01arz3ndektsv4rrffq69g5fav.md")).unwrap();
    write(
        root_a,
        "notes/meeting-notes.md",
        "# Meeting Notes\n\n- agenda point one\n- agenda point two\n- agenda point three\n",
    );
    commit_all(root_a, "rename", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a, None, &[]).unwrap();

    // Rename detection (libgit2 merge default) lands B's edit in the moved
    // file — no conflict, no resurrected ULID path.
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert!(merged.conflicted_paths.is_empty(), "{merged:?}");
    let content = read(root_a, "notes/meeting-notes.md");
    assert!(content.contains("EDITED ON B"), "{content}");
    assert!(!root_a.join("notes/01arz3ndektsv4rrffq69g5fav.md").exists());
    assert!(push(root_a, None, &[]).unwrap().pushed);
}

#[test]
fn same_title_created_on_two_devices_surfaces_as_a_review_conflict() {
    // New with slug filenames: two offline devices can create the same path.
    // The merge must surface it through the existing marker flow, not wedge.
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/seed.md", "# Seed\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    let root_b = second_device(&fixture);
    write(
        &root_b,
        "notes/meeting.md",
        "# Meeting\n\nnotes from device b\n",
    );
    commit_all(&root_b, "b creates", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    write(
        root_a,
        "notes/meeting.md",
        "# Meeting\n\nnotes from device a\n",
    );
    commit_all(root_a, "a creates", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a, None, &[]).unwrap();

    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );
    assert_eq!(
        merged.conflicted_paths,
        vec!["notes/meeting.md".to_string()]
    );
    let content = read(root_a, "notes/meeting.md");
    assert!(content.contains("notes from device a"), "{content}");
    assert!(content.contains("notes from device b"), "{content}");
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    assert!(push(root_a, None, &[]).unwrap().pushed);
}

#[test]
fn diverging_renames_keep_both_files_and_never_wedge() {
    // Both devices retitle the same note differently while offline: the note
    // forks into two paths. Accepted outcome (the duplicate-id flag surfaces
    // the fork at index time): both files survive, nothing wedges.
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    let base = "# Shared\n\n- line one\n- line two\n- line three\n";
    write(root_a, "notes/01arz3ndektsv4rrffq69g5fav.md", base);
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();

    let root_b = second_device(&fixture);
    fs::remove_file(root_b.join("notes/01arz3ndektsv4rrffq69g5fav.md")).unwrap();
    write(
        &root_b,
        "notes/title-b.md",
        "# Title B\n\n- line one\n- line two\n- line three\n",
    );
    commit_all(&root_b, "b rename", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    fs::remove_file(root_a.join("notes/01arz3ndektsv4rrffq69g5fav.md")).unwrap();
    write(
        root_a,
        "notes/title-a.md",
        "# Title A\n\n- line one\n- line two\n- line three\n",
    );
    commit_all(root_a, "a rename", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a, None, &[]).unwrap();

    // Whatever the merge classifies this as, the invariants hold: no wedge,
    // both titles' content present, the old path gone, and the result pushes.
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean, "{merged:?}");
    assert!(root_a.join("notes/title-a.md").exists(), "{merged:?}");
    assert!(root_a.join("notes/title-b.md").exists(), "{merged:?}");
    assert!(!root_a.join("notes/01arz3ndektsv4rrffq69g5fav.md").exists());
    assert!(read(root_a, "notes/title-a.md").contains("Title A"));
    assert!(read(root_a, "notes/title-b.md").contains("Title B"));
    assert!(push(root_a, None, &[]).unwrap().pushed);
}

/// A graph whose `finance/secure` is a symlink into a raw store outside it,
/// plus a real `people/secure/` folder — the graph's `.gitignore` is the
/// stock default, which knows nothing about either.
#[cfg(unix)]
fn graph_with_local_only_folders(base: &Path, name: &str) -> PathBuf {
    let root = base.join(name);
    scaffold_graph(&root);
    setup(&root, None, None).unwrap();
    let raw = base.join(format!("{name}-raw"));
    write(&raw, "finance/secure/bank.md", "# Bank\n\naccount 1234\n");
    fs::create_dir_all(root.join("finance")).unwrap();
    std::os::unix::fs::symlink(raw.join("finance/secure"), root.join("finance/secure")).unwrap();
    write(&root, "people/secure/passport.md", "# Passport\n");
    write(&root, "notes/public.md", "# Public\n");
    assert!(!read(&root, ".gitignore").contains("secure"));
    root
}

#[cfg(unix)]
#[test]
fn local_only_folders_are_never_staged_even_without_an_ignore_pattern() {
    let dir = tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();

    // Control: without the configuration the stock backup stages the link
    // itself — a blob whose content is the raw store's absolute path — and
    // the real folder's notes.
    let unguarded = graph_with_local_only_folders(&base, "unguarded");
    commit_all(&unguarded, "Update notes", MAX_FILE_BYTES, None).unwrap();
    let paths = head_tree_paths(&unguarded);
    assert!(paths.contains(&"finance/secure".to_string()), "{paths:?}");
    assert!(paths.contains(&"people/secure/passport.md".to_string()));

    let guarded = graph_with_local_only_folders(&base, "guarded");
    let folders =
        reflect_graph_paths::LocalOnlyFolders::new(["secure"], Some(&base.join("guarded-raw")))
            .unwrap();
    let outcome = commit_all(&guarded, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(outcome.committed);
    let paths = head_tree_paths(&guarded);
    assert!(paths.contains(&"notes/public.md".to_string()), "{paths:?}");
    assert!(
        !paths.iter().any(|path| path.contains("secure")),
        "a local-only folder leaked into the backup: {paths:?}"
    );

    // A later edit inside the raw store still commits nothing new.
    write(
        &base.join("guarded-raw"),
        "finance/secure/bank.md",
        "# Bank\n\nchanged\n",
    );
    write(&guarded, "people/secure/visa.md", "# Visa\n");
    let again = commit_all(&guarded, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(!again.committed, "only local-only content changed");
}

#[test]
fn tracked_files_inside_a_local_only_folder_are_frozen_not_updated() {
    // A folder committed before it was configured local-only: the ignore
    // rule cannot reach tracked paths, so the staging guard keeps every
    // later change (edits and deletions alike) out of the backup.
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "personal/secure/old.md", "# Old\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES, None).unwrap();

    let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap();
    write(
        root,
        "personal/secure/old.md",
        "# Old\n\nnew private line\n",
    );
    write(root, "notes/a.md", "# A\n");
    commit_all(root, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    let repo = Repository::open(root).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    let blob = tree
        .get_path(Path::new("personal/secure/old.md"))
        .unwrap()
        .to_object(&repo)
        .unwrap()
        .peel_to_blob()
        .unwrap();
    assert_eq!(blob.content(), b"# Old\n");

    fs::remove_file(root.join("personal/secure/old.md")).unwrap();
    commit_all(root, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(head_tree_paths(root).contains(&"personal/secure/old.md".to_string()));
}

/// Commit `files` on top of `root`'s HEAD straight into the object store
/// (the working tree is untouched), so a test can author paths a
/// case-folding filesystem could never hold side by side.
fn commit_files_directly(root: &Path, files: &[(&str, &str)]) {
    let repo = Repository::open(root).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let mut update = git2::build::TreeUpdateBuilder::new();
    for (path, contents) in files {
        let blob = repo.blob(contents.as_bytes()).unwrap();
        update.upsert(*path, blob, git2::FileMode::Blob);
    }
    let tree = repo
        .find_tree(update.create_updated(&repo, &head.tree().unwrap()).unwrap())
        .unwrap();
    let sig = git2::Signature::now("Device B", "b@example.invalid").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "from b", &tree, &[&head])
        .unwrap();
}

fn head_blob(root: &Path, rel: &str) -> Vec<u8> {
    let repo = Repository::open(root).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    let entry = tree.get_path(Path::new(rel)).unwrap();
    let blob = repo.find_blob(entry.id()).unwrap();
    blob.content().to_vec()
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

const LOCAL_EDIT: &str = "# X\n\nlocal private edit\n";

/// Device A committed `finance/secure/x.md` as a real folder, then made it
/// local-only: moved it into a raw store, linked it back, and edited the
/// raw copy (a frozen local edit Git must never see or revert). Device B is
/// an unconfigured clone from before the migration.
#[cfg(unix)]
struct Migrated {
    fixture: Fixture,
    raw: PathBuf,
    folders: reflect_graph_paths::LocalOnlyFolders,
    root_b: PathBuf,
}

#[cfg(unix)]
fn migrated(ignorecase: bool) -> Migrated {
    let fixture = fixture();
    let root_a = fixture.graph_a.clone();
    write(&root_a, "finance/secure/x.md", "# X\n\noriginal\n");
    write(&root_a, "notes/a.md", "# A\n");
    commit_all(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(&root_a, None, &[]).unwrap();
    let root_b = second_device(&fixture);

    let raw = fixture._dir.path().canonicalize().unwrap().join("raw");
    fs::create_dir_all(raw.join("finance")).unwrap();
    fs::rename(root_a.join("finance/secure"), raw.join("finance/secure")).unwrap();
    std::os::unix::fs::symlink(raw.join("finance/secure"), root_a.join("finance/secure")).unwrap();
    Repository::open(&root_a)
        .unwrap()
        .config()
        .unwrap()
        .set_bool("core.ignorecase", ignorecase)
        .unwrap();
    write(&raw, "finance/secure/x.md", LOCAL_EDIT);
    let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap();
    // The sync cycle commits first: nothing local-only is staged.
    let commit = commit_all(&root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(!commit.committed);
    Migrated {
        fixture,
        raw,
        folders,
        root_b,
    }
}

#[cfg(unix)]
fn raw_edit_survived(migrated: &Migrated) -> bool {
    is_symlink(&migrated.fixture.graph_a.join("finance/secure"))
        && fs::read_to_string(migrated.raw.join("finance/secure/x.md"))
            .ok()
            .as_deref()
            == Some(LOCAL_EDIT)
}

#[cfg(unix)]
#[test]
fn a_fast_forward_never_touches_a_migrated_local_only_folder() {
    for ignorecase in [true, false] {
        let migrated = migrated(ignorecase);
        let root_a = &migrated.fixture.graph_a;
        write(&migrated.root_b, "notes/a.md", "# A\n\nedited on b\n");
        commit_all(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
        push(&migrated.root_b, None, &[]).unwrap();

        fetch(root_a, None).unwrap();
        let merged = merge_remote(root_a, Some(&migrated.folders), &[]).unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert!(raw_edit_survived(&migrated), "ignorecase={ignorecase}");
        assert_eq!(read(root_a, "notes/a.md"), "# A\n\nedited on b\n");
        assert!(merged.frozen_paths.is_empty(), "{merged:?}");
        let repo = Repository::open(root_a).unwrap();
        assert_eq!(
            repo.head().unwrap().target(),
            repo.refname_to_id("refs/remotes/origin/main").ok()
        );
        let again = commit_all(
            root_a,
            "Update notes",
            MAX_FILE_BYTES,
            Some(&migrated.folders),
        );
        assert!(!again.unwrap().committed);
    }
}

/// Control: without the configuration a fast-forward still writes only the
/// paths the other device changed. (The forced checkout of HEAD it replaced
/// "restored" the tracked file here, through the link or by replacing it.)
/// When the other device does change a path behind the link, the link is
/// moved aside, never written through.
#[cfg(unix)]
#[test]
fn without_the_configuration_a_fast_forward_writes_only_what_changed() {
    for ignorecase in [true, false] {
        let migrated = migrated(ignorecase);
        let root_a = &migrated.fixture.graph_a;
        write(&migrated.root_b, "notes/a.md", "# A\n\nedited on b\n");
        commit_all(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
        push(&migrated.root_b, None, &[]).unwrap();
        fetch(root_a, None).unwrap();
        let merged = merge_remote(root_a, None, &[]).unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert_eq!(read(root_a, "notes/a.md"), "# A\n\nedited on b\n");
        assert!(raw_edit_survived(&migrated), "ignorecase={ignorecase}");

        write(
            &migrated.root_b,
            "finance/secure/x.md",
            "# X\n\nedited on b\n",
        );
        commit_all(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
        push(&migrated.root_b, None, &[]).unwrap();
        fetch(root_a, None).unwrap();
        let merged = merge_remote(root_a, None, &[]).unwrap();
        assert_eq!(
            fs::read_to_string(migrated.raw.join("finance/secure/x.md")).unwrap(),
            LOCAL_EDIT,
            "ignorecase={ignorecase}"
        );
        assert!(is_symlink(&root_a.join("finance/secure (this device)")));
        assert_eq!(read(root_a, "finance/secure/x.md"), "# X\n\nedited on b\n");
        assert_eq!(merged.displaced.len(), 1, "{merged:?}");
        assert_eq!(merged.displaced[0].from, "finance/secure");
    }
}

/// A never-tracked link, and a remote that adds files inside it: under its
/// own name and, where the filesystem folds, under a folded spelling.
#[cfg(unix)]
fn link_with_remote_additions() -> (
    Fixture,
    PathBuf,
    reflect_graph_paths::LocalOnlyFolders,
    bool,
) {
    let fixture = fixture();
    let root_a = fixture.graph_a.clone();
    write(&root_a, "notes/a.md", "# A\n");
    commit_all(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(&root_a, None, &[]).unwrap();
    let root_b = second_device(&fixture);

    let raw = fixture._dir.path().canonicalize().unwrap().join("raw");
    write(&raw, "finance/secure/bank.md", "# Bank\n");
    fs::create_dir_all(root_a.join("finance")).unwrap();
    std::os::unix::fs::symlink(raw.join("finance/secure"), root_a.join("finance/secure")).unwrap();
    let folds = root_a.join("finance/\u{17f}ecure").exists();
    let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap();

    commit_files_directly(
        &root_b,
        &[
            ("finance/secure/remote.md", "# Remote\n"),
            ("finance/\u{17f}ecure/folded.md", "# Folded\n"),
            ("notes/b.md", "# B\n"),
        ],
    );
    push(&root_b, None, &[]).unwrap();
    fetch(&root_a, None).unwrap();
    (fixture, raw, folders, folds)
}

/// The link was never tracked here, so following the other device's files
/// into the index would keep them in every later backup: the pull pauses,
/// naming each such folder, before anything is written through the link,
/// tracked, or checked out.
#[cfg(unix)]
#[test]
fn remote_additions_inside_a_local_only_link_pause_the_pull() {
    let (fixture, raw, folders, folds) = link_with_remote_additions();
    let root_a = &fixture.graph_a;
    let before = snapshot(root_a);
    let message = paused_message(merge_remote(root_a, Some(&folders), &[]).unwrap_err());
    assert!(message.contains("\"finance/secure\""), "{message}");
    if folds {
        assert!(message.contains("\"finance/\u{17f}ecure\""), "{message}");
    }

    let mut raw_files: Vec<_> = fs::read_dir(raw.join("finance/secure"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    raw_files.sort();
    assert_eq!(raw_files, vec!["bank.md"]);
    assert!(is_symlink(&root_a.join("finance/secure")));
    assert_eq!(snapshot(root_a), before);
    assert_no_merge_state(root_a);
    let again = commit_all(root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(!again.committed);
}

#[cfg(unix)]
#[test]
fn without_the_configuration_remote_additions_land_in_the_raw_store() {
    let (fixture, raw, _, _) = link_with_remote_additions();
    let root_a = &fixture.graph_a;
    let result = merge_remote(root_a, None, &[]);
    assert!(
        result.is_err()
            || raw.join("finance/secure/remote.md").exists()
            || !is_symlink(&root_a.join("finance/secure")),
        "{result:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_diverged_merge_holds_local_only_paths_and_history_follows_the_remote() {
    let migrated = migrated(true);
    let root_a = &migrated.fixture.graph_a;
    write(root_a, "notes/b.md", "# B\n");
    let local = commit_all(root_a, "a edit", MAX_FILE_BYTES, Some(&migrated.folders)).unwrap();
    assert!(local.committed);

    write(
        &migrated.root_b,
        "finance/secure/x.md",
        "# X\n\nedited on b\n",
    );
    write(&migrated.root_b, "finance/secure/new.md", "# New\n");
    write(&migrated.root_b, "notes/a.md", "# A\n\nedited on b\n");
    commit_all(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push(&migrated.root_b, None, &[]).unwrap();

    fetch(root_a, None).unwrap();
    let merged = merge_remote(root_a, Some(&migrated.folders), &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert!(raw_edit_survived(&migrated));
    assert!(!migrated.raw.join("finance/secure/new.md").exists());
    assert_eq!(read(root_a, "notes/a.md"), "# A\n\nedited on b\n");
    assert_eq!(read(root_a, "notes/b.md"), "# B\n");
    let mut frozen = merged.frozen_paths.clone();
    frozen.sort();
    assert_eq!(frozen, vec!["finance/secure/new.md", "finance/secure/x.md"]);
    assert_eq!(
        merged
            .changed_files
            .iter()
            .map(|change| change.path.as_str())
            .collect::<Vec<_>>(),
        vec!["notes/a.md"]
    );

    // History has both parents and the other device's versions.
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
    assert_eq!(
        Some(head.parent_id(1).unwrap()),
        repo.refname_to_id("refs/remotes/origin/main").ok()
    );
    assert_eq!(
        head_blob(root_a, "finance/secure/x.md"),
        b"# X\n\nedited on b\n"
    );
    assert_eq!(head_blob(root_a, "finance/secure/new.md"), b"# New\n");
    let again = commit_all(
        root_a,
        "Update notes",
        MAX_FILE_BYTES,
        Some(&migrated.folders),
    )
    .unwrap();
    assert!(!again.committed);
    assert!(push(root_a, None, &[]).unwrap().pushed);
}

#[cfg(unix)]
#[test]
fn without_the_configuration_a_diverged_merge_refuses_or_clobbers() {
    let migrated = migrated(true);
    let root_a = &migrated.fixture.graph_a;
    write(root_a, "notes/b.md", "# B\n");
    commit_all(root_a, "a edit", MAX_FILE_BYTES, Some(&migrated.folders)).unwrap();
    write(
        &migrated.root_b,
        "finance/secure/x.md",
        "# X\n\nedited on b\n",
    );
    commit_all(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push(&migrated.root_b, None, &[]).unwrap();
    fetch(root_a, None).unwrap();
    let result = merge_remote(root_a, None, &[]);
    assert!(
        result.is_err() || !raw_edit_survived(&migrated),
        "{result:?}"
    );
}

/// Command tier: `git_merge_remote` and `git_commit_all` take the open
/// graph's local-only folders from `GraphState`, with a control session
/// that has none.
#[cfg(unix)]
#[test]
fn the_git_commands_take_local_only_folders_from_the_open_graph() {
    use tauri::Manager;
    for configured in [true, false] {
        let (fixture, raw, folders, _) = link_with_remote_additions();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(crate::fs::GraphState::default());
        {
            let state: tauri::State<crate::fs::GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(fixture.graph_a.clone());
            inner.set_local_only(configured.then(|| folders.clone()));
        }
        let merged = tauri::async_runtime::block_on(super::git_merge_remote(
            1,
            app.handle().clone(),
            app.state(),
        ));
        let committed = tauri::async_runtime::block_on(super::git_commit_all(
            "Update notes".to_string(),
            1,
            app.state(),
        ));
        if configured {
            // The pull would start tracking the never-tracked link's files,
            // so it pauses before writing anything.
            let message = paused_message(merged.expect_err("paused"));
            assert!(message.contains("\"finance/secure\""), "{message}");
            assert!(!raw.join("finance/secure/remote.md").exists());
            assert!(is_symlink(&fixture.graph_a.join("finance/secure")));
            assert!(!committed.unwrap().committed);
            assert!(!head_tree_paths(&fixture.graph_a).contains(&"finance/secure".to_string()));
        } else {
            // Control: the stock pull writes through (or replaces) the link,
            // and the stock commit stages what is left there.
            assert!(
                merged.is_err()
                    || raw.join("finance/secure/remote.md").exists()
                    || !is_symlink(&fixture.graph_a.join("finance/secure"))
            );
        }
    }
}

/// Command tier: with the settings file unreadable at open, which folders
/// are local-only is unknown, so commit and merge refuse loudly; the control
/// session (configuration known, here none) commits.
#[test]
fn sync_refuses_while_the_local_only_configuration_is_unknown() {
    use tauri::Manager;
    for unknown in [true, false] {
        let fixture = fixture();
        write(&fixture.graph_a, "notes/a.md", "# A\n");
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(crate::fs::GraphState::default());
        {
            let state: tauri::State<crate::fs::GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(fixture.graph_a.clone());
            if unknown {
                inner.set_local_only_unknown();
            }
        }
        let committed = tauri::async_runtime::block_on(super::git_commit_all(
            "Update notes".to_string(),
            1,
            app.state(),
        ));
        let merged = tauri::async_runtime::block_on(super::git_merge_remote(
            1,
            app.handle().clone(),
            app.state(),
        ));
        if unknown {
            let message = format!("{:?}", committed.expect_err("commit refused"));
            assert!(message.contains("Sync is paused"), "{message}");
            assert!(merged.is_err());
            let repo = Repository::open(&fixture.graph_a).unwrap();
            assert!(repo
                .head()
                .ok()
                .and_then(|head| head.peel_to_commit().ok())
                .is_none());
        } else {
            assert!(committed.unwrap().committed);
            assert!(head_tree_paths(&fixture.graph_a).contains(&"notes/a.md".to_string()));
        }
    }
}

const LINK: i32 = 0o120000;
const FILE: i32 = 0o100644;

/// Commit on top of `root`'s HEAD by editing a flattened index of its tree,
/// leaving the working tree alone: `(path, Some((bytes, mode)))` writes a file
/// or link at `path`, `(path, None)` removes it; either way whatever sat at
/// or under `path` goes first, so a test can change an entry's type.
/// One edit for [`commit_index_edits`]: the bytes and mode to write, or
/// `None` to remove.
type IndexEdit<'a> = (&'a str, Option<(&'a [u8], i32)>);

fn commit_index_edits(root: &Path, edits: &[IndexEdit<'_>]) {
    let repo = Repository::open(root).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let mut index = git2::Index::new().unwrap();
    index.read_tree(&head.tree().unwrap()).unwrap();
    for (path, edit) in edits {
        if index.get_path(Path::new(path), 0).is_some() {
            index.remove_path(Path::new(path)).unwrap();
        }
        index.remove_dir(Path::new(path), 0).unwrap();
        if let Some((bytes, mode)) = edit {
            index
                .add(&git2::IndexEntry {
                    ctime: git2::IndexTime::new(0, 0),
                    mtime: git2::IndexTime::new(0, 0),
                    dev: 0,
                    ino: 0,
                    mode: *mode as u32,
                    uid: 0,
                    gid: 0,
                    file_size: 0,
                    id: repo.blob(bytes).unwrap(),
                    flags: 0,
                    flags_extended: 0,
                    path: path.as_bytes().to_vec(),
                })
                .unwrap();
        }
    }
    let tree = repo.find_tree(index.write_tree_to(&repo).unwrap()).unwrap();
    let sig = git2::Signature::now("Device B", "b@example.invalid").unwrap();
    repo.commit(Some("HEAD"), &sig, &sig, "from b", &tree, &[&head])
        .unwrap();
}

fn index_paths(root: &Path) -> Vec<String> {
    let index = Repository::open(root).unwrap().index().unwrap();
    index
        .iter()
        .map(|entry| String::from_utf8_lossy(&entry.path).into_owned())
        .collect()
}

/// After a pull: the next commit is clean and a further pull still works.
#[cfg(unix)]
fn assert_sync_keeps_flowing(
    root_a: &Path,
    root_b: &Path,
    folders: &reflect_graph_paths::LocalOnlyFolders,
) {
    let again = commit_all(root_a, "Update notes", MAX_FILE_BYTES, Some(folders)).unwrap();
    assert!(!again.committed, "the pull left the index off HEAD");
    commit_index_edits(root_b, &[("notes/later.md", Some((b"# Later\n", FILE)))]);
    push(root_b, None, &[]).unwrap();
    fetch(root_a, None).unwrap();
    merge_remote(root_a, Some(folders), &[]).expect("a later pull");
    assert_eq!(read(root_a, "notes/later.md"), "# Later\n");
}

/// Device A pulls the other device's committed link before the folder is
/// local-only here, so A's history tracks the unit; then A points its own
/// link into a raw store and configures the folder.
#[cfg(unix)]
fn track_the_link_then_make_it_local_only(
    fixture: &Fixture,
    root_a: &Path,
) -> (PathBuf, reflect_graph_paths::LocalOnlyFolders) {
    fetch(root_a, None).unwrap();
    merge_remote(root_a, None, &[]).expect("pull the link");
    let raw = fixture._dir.path().canonicalize().unwrap().join("raw");
    write(&raw, "finance/secure/bank.md", "# Bank\n");
    fs::remove_file(root_a.join("finance/secure")).unwrap();
    std::os::unix::fs::symlink(raw.join("finance/secure"), root_a.join("finance/secure")).unwrap();
    let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap();
    (raw, folders)
}

#[cfg(unix)]
#[test]
fn a_local_only_link_that_becomes_a_folder_upstream_never_wedges_a_pull() {
    for diverged in [false, true] {
        let fixture = fixture();
        let root_a = fixture.graph_a.clone();
        write(&root_a, "notes/a.md", "# A\n");
        commit_all(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
        push(&root_a, None, &[]).unwrap();
        let root_b = second_device(&fixture);
        // Another device committed its own link (it has no configuration).
        commit_index_edits(
            &root_b,
            &[("finance/secure", Some((b"/elsewhere/secure", LINK)))],
        );
        push(&root_b, None, &[]).unwrap();
        let (raw, folders) = track_the_link_then_make_it_local_only(&fixture, &root_a);

        // Upstream, the link becomes a real folder.
        commit_index_edits(
            &root_b,
            &[
                ("finance/secure", None),
                ("finance/secure/x.md", Some((b"# X\n", FILE))),
            ],
        );
        push(&root_b, None, &[]).unwrap();
        if diverged {
            write(&root_a, "notes/b.md", "# B\n");
            assert!(
                commit_all(&root_a, "a edit", MAX_FILE_BYTES, Some(&folders))
                    .unwrap()
                    .committed
            );
        }
        fetch(&root_a, None).unwrap();
        let merged = merge_remote(&root_a, Some(&folders), &[]).expect("pull the folder");
        assert!(
            merged
                .frozen_paths
                .contains(&"finance/secure/x.md".to_string()),
            "{merged:?}"
        );
        assert!(is_symlink(&root_a.join("finance/secure")));
        let mut raw_files: Vec<_> = fs::read_dir(raw.join("finance/secure"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        raw_files.sort();
        assert_eq!(raw_files, vec!["bank.md"]);
        let paths = index_paths(&root_a);
        assert!(
            paths.contains(&"finance/secure/x.md".to_string()),
            "{paths:?}"
        );
        assert!(!paths.contains(&"finance/secure".to_string()), "{paths:?}");
        assert_sync_keeps_flowing(&root_a, &root_b, &folders);
    }
}

#[cfg(unix)]
#[test]
fn a_local_only_folder_that_becomes_a_link_upstream_never_wedges_a_pull() {
    for diverged in [false, true] {
        let migrated = migrated(true);
        let root_a = &migrated.fixture.graph_a;
        commit_index_edits(
            &migrated.root_b,
            &[("finance/secure", Some((b"/elsewhere", LINK)))],
        );
        push(&migrated.root_b, None, &[]).unwrap();
        if diverged {
            write(root_a, "notes/b.md", "# B\n");
            assert!(
                commit_all(root_a, "a edit", MAX_FILE_BYTES, Some(&migrated.folders))
                    .unwrap()
                    .committed
            );
        }
        fetch(root_a, None).unwrap();
        let merged = merge_remote(root_a, Some(&migrated.folders), &[]).expect("pull the link");
        assert!(
            merged.frozen_paths.contains(&"finance/secure".to_string()),
            "{merged:?}"
        );
        assert!(raw_edit_survived(&migrated));
        let paths = index_paths(root_a);
        assert!(paths.contains(&"finance/secure".to_string()), "{paths:?}");
        assert!(
            !paths.contains(&"finance/secure/x.md".to_string()),
            "{paths:?}"
        );
        assert_sync_keeps_flowing(root_a, &migrated.root_b, &migrated.folders);
    }
}

/// Device A keeps a never-committed local-only folder inside `people/`;
/// upstream, `people/` becomes a file. Checking that file out would delete
/// the folder, notes and all.
#[cfg(unix)]
fn folder_replaced_by_a_file(diverged: bool) -> (Fixture, reflect_graph_paths::LocalOnlyFolders) {
    let fixture = fixture();
    let root_a = fixture.graph_a.clone();
    write(&root_a, "people/plan.md", "# Plan\n");
    commit_all(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(&root_a, None, &[]).unwrap();
    let root_b = second_device(&fixture);
    Repository::open(&root_a)
        .unwrap()
        .config()
        .unwrap()
        .set_bool("core.ignorecase", true)
        .unwrap();
    write(&root_a, "people/secure/visa.md", "# Visa\n");
    let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap();
    commit_index_edits(&root_b, &[("people", Some((b"now a file\n", FILE)))]);
    push(&root_b, None, &[]).unwrap();
    if diverged {
        write(&root_a, "notes/b.md", "# B\n");
        assert!(
            commit_all(&root_a, "a edit", MAX_FILE_BYTES, Some(&folders))
                .unwrap()
                .committed
        );
    }
    fetch(&root_a, None).unwrap();
    (fixture, folders)
}

#[cfg(unix)]
#[test]
fn a_pull_refuses_to_replace_a_folder_holding_a_local_only_folder() {
    for diverged in [false, true] {
        let (fixture, folders) = folder_replaced_by_a_file(diverged);
        let root_a = &fixture.graph_a;
        let head = Repository::open(root_a).unwrap().head().unwrap().target();
        let err = merge_remote(root_a, Some(&folders), &[]).expect_err("refused");
        assert!(format!("{err:?}").contains("people"), "{err:?}");
        assert_eq!(read(root_a, "people/secure/visa.md"), "# Visa\n");
        let repo = Repository::open(root_a).unwrap();
        assert_eq!(repo.head().unwrap().target(), head);
        assert_eq!(repo.state(), git2::RepositoryState::Clean);
    }
}

#[cfg(unix)]
#[test]
fn without_the_configuration_a_pull_deletes_the_folder_or_fails() {
    let (fixture, _) = folder_replaced_by_a_file(false);
    let root_a = &fixture.graph_a;
    let result = merge_remote(root_a, None, &[]);
    assert!(
        result.is_err() || !root_a.join("people/secure/visa.md").exists(),
        "{result:?}"
    );
}

/// A pull whose checkout fails part-way leaves the index and the ref
/// together on the old commit, and the next pull goes through.
#[cfg(unix)]
#[test]
fn a_failed_pull_leaves_the_index_and_ref_together_and_the_next_one_works() {
    use std::os::unix::fs::PermissionsExt;
    let migrated = migrated(true);
    let root_a = &migrated.fixture.graph_a;
    write(&root_a.join("people"), "plan.md", "# Plan\n");
    commit_all(root_a, "plan", MAX_FILE_BYTES, Some(&migrated.folders)).unwrap();
    push(root_a, None, &[]).unwrap();
    fetch(&migrated.root_b, None).unwrap();
    merge_remote(&migrated.root_b, None, &[]).unwrap();
    commit_index_edits(
        &migrated.root_b,
        &[
            ("notes/a.md", Some((b"# A\n\nedited on b\n", FILE))),
            ("people/plan.md", Some((b"# Plan\n\nedited on b\n", FILE))),
        ],
    );
    push(&migrated.root_b, None, &[]).unwrap();
    fetch(root_a, None).unwrap();

    let repo = Repository::open(root_a).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    let locked = root_a.join("people");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
    let failed = merge_remote(root_a, Some(&migrated.folders), &[]);
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err(), "{failed:?}");
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.head().unwrap().target(), Some(head));
    let mut index = repo.index().unwrap();
    let head_tree = repo.find_commit(head).unwrap().tree_id();
    assert_eq!(
        index.write_tree().unwrap(),
        head_tree,
        "the index left HEAD"
    );

    let merged = merge_remote(root_a, Some(&migrated.folders), &[]).expect("the retry");
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(root_a, "people/plan.md"), "# Plan\n\nedited on b\n");
    assert!(raw_edit_survived(&migrated));
    let again = commit_all(
        root_a,
        "Update notes",
        MAX_FILE_BYTES,
        Some(&migrated.folders),
    );
    assert!(!again.unwrap().committed);
}

/// The index write itself fails after a successful checkout (a stale
/// index.lock): HEAD and the index stay on the old commit, and the retry
/// goes through with nothing frozen disturbed.
#[cfg(unix)]
#[test]
fn a_pull_whose_index_write_fails_leaves_head_and_the_retry_works() {
    let migrated = migrated(true);
    let root_a = &migrated.fixture.graph_a;
    commit_index_edits(
        &migrated.root_b,
        &[("notes/a.md", Some((b"# A\n\nedited on b\n", FILE)))],
    );
    push(&migrated.root_b, None, &[]).unwrap();
    fetch(root_a, None).unwrap();

    let repo = Repository::open(root_a).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    let lock = root_a.join(".git/index.lock");
    fs::write(&lock, b"").unwrap();
    let failed = merge_remote(root_a, Some(&migrated.folders), &[]);
    fs::remove_file(&lock).unwrap();
    assert!(failed.is_err(), "{failed:?}");
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.head().unwrap().target(), Some(head));
    let head_tree = repo.find_commit(head).unwrap().tree_id();
    assert_eq!(repo.index().unwrap().write_tree().unwrap(), head_tree);

    let merged = merge_remote(root_a, Some(&migrated.folders), &[]).expect("the retry");
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(root_a, "notes/a.md"), "# A\n\nedited on b\n");
    assert!(raw_edit_survived(&migrated));
    let again = commit_all(
        root_a,
        "Update notes",
        MAX_FILE_BYTES,
        Some(&migrated.folders),
    );
    assert!(!again.unwrap().committed);
}

/// A local-only link deleted upstream: the pull drops its index entry (no
/// stale entry left behind), never touches the link here, and the next
/// commit is clean, on both arms.
#[cfg(unix)]
#[test]
fn a_local_only_link_deleted_upstream_leaves_no_stale_index_entry() {
    for diverged in [false, true] {
        let fixture = fixture();
        let root_a = fixture.graph_a.clone();
        write(&root_a, "notes/a.md", "# A\n");
        commit_all(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
        push(&root_a, None, &[]).unwrap();
        let root_b = second_device(&fixture);
        commit_index_edits(
            &root_b,
            &[("finance/secure", Some((b"/elsewhere/secure", LINK)))],
        );
        push(&root_b, None, &[]).unwrap();
        let (raw, folders) = track_the_link_then_make_it_local_only(&fixture, &root_a);
        assert!(index_paths(&root_a).contains(&"finance/secure".to_string()));

        commit_index_edits(&root_b, &[("finance/secure", None)]);
        push(&root_b, None, &[]).unwrap();
        if diverged {
            write(&root_a, "notes/b.md", "# B\n");
            assert!(
                commit_all(&root_a, "a edit", MAX_FILE_BYTES, Some(&folders))
                    .unwrap()
                    .committed
            );
        }
        fetch(&root_a, None).unwrap();
        let merged = merge_remote(&root_a, Some(&folders), &[]).expect("pull the deletion");
        assert!(
            merged.frozen_paths.contains(&"finance/secure".to_string()),
            "{merged:?}"
        );
        assert!(!index_paths(&root_a).contains(&"finance/secure".to_string()));
        assert!(!head_tree_paths(&root_a).contains(&"finance/secure".to_string()));
        assert!(is_symlink(&root_a.join("finance/secure")));
        assert_eq!(read(&raw, "finance/secure/bank.md"), "# Bank\n");
        let again = commit_all(&root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
        assert!(!again.committed);
    }
}

// ---- the history guard ------------------------------------------------------
// Sync never joins a history root the graph has not accepted, and a pull
// never starts tracking a local-only folder this device's history does not
// track. Both pause before anything changes.

/// A commit holding `files` and no parents, written into the repository at
/// `path` (a graph or the bare remote) without moving any ref: the start of
/// a separate history.
fn separate_root(path: &Path, files: &[(&str, &str)]) -> git2::Oid {
    let repo = Repository::open(path).unwrap();
    let empty = repo
        .find_tree(repo.treebuilder(None).unwrap().write().unwrap())
        .unwrap();
    let mut update = git2::build::TreeUpdateBuilder::new();
    for (rel, contents) in files {
        let blob = repo.blob(contents.as_bytes()).unwrap();
        update.upsert(*rel, blob, git2::FileMode::Blob);
    }
    let tree = repo
        .find_tree(update.create_updated(&repo, &empty).unwrap())
        .unwrap();
    let sig = git2::Signature::now("Old device", "old@example.invalid").unwrap();
    repo.commit(None, &sig, &sig, "a separate history", &tree, &[])
        .unwrap()
}

/// Point the remote's `main` at a separate history holding `files`, as a
/// device that pushes its own history over the backup leaves it. Returns
/// that history's root.
fn replace_remote_history(fixture: &Fixture, files: &[(&str, &str)]) -> git2::Oid {
    let bare = Path::new(&fixture.remote_url);
    let root = separate_root(bare, files);
    Repository::open(bare)
        .unwrap()
        .reference("refs/heads/main", root, true, "another history")
        .unwrap();
    root
}

/// Merge a separate history holding `files` into `root`'s HEAD, the way a
/// device without the guard joins two histories (the upstream app, plain
/// Git), straight into the object store. Returns that history's root.
fn merge_separate_history(root: &Path, files: &[(&str, &str)]) -> git2::Oid {
    let separate = separate_root(root, files);
    let repo = Repository::open(root).unwrap();
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    let mut update = git2::build::TreeUpdateBuilder::new();
    for (rel, contents) in files {
        let blob = repo.blob(contents.as_bytes()).unwrap();
        update.upsert(*rel, blob, git2::FileMode::Blob);
    }
    let tree = repo
        .find_tree(update.create_updated(&repo, &head.tree().unwrap()).unwrap())
        .unwrap();
    let other = repo.find_commit(separate).unwrap();
    let sig = git2::Signature::now("Device B", "b@example.invalid").unwrap();
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        "Merge changes from other devices",
        &tree,
        &[&head, &other],
    )
    .unwrap();
    separate
}

/// Push `root`'s `main` the way a device without the guard does.
fn push_unguarded(root: &Path) {
    let repo = Repository::open(root).unwrap();
    let mut remote = repo.find_remote("origin").unwrap();
    remote
        .push(&["refs/heads/main:refs/heads/main"], None)
        .unwrap();
}

fn remote_main(fixture: &Fixture) -> git2::Oid {
    Repository::open(&fixture.remote_url)
        .unwrap()
        .refname_to_id("refs/heads/main")
        .unwrap()
}

/// Everything a paused pull must leave as it was: HEAD, the index, the
/// repository state, and every file in the graph (a link by its target).
#[derive(Debug, PartialEq)]
struct Snapshot {
    head: Option<git2::Oid>,
    index_tree: git2::Oid,
    state: git2::RepositoryState,
    files: Vec<(String, Vec<u8>)>,
}

fn snapshot(root: &Path) -> Snapshot {
    let repo = Repository::open(root).unwrap();
    let mut files: Vec<(String, Vec<u8>)> = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.file_name() != std::ffi::OsStr::new(".git"))
        .map(Result::unwrap)
        .filter(|entry| !entry.file_type().is_dir())
        .map(|entry| {
            let rel = entry.path().strip_prefix(root).unwrap();
            let bytes = if entry.file_type().is_symlink() {
                fs::read_link(entry.path())
                    .unwrap()
                    .to_string_lossy()
                    .into_owned()
                    .into_bytes()
            } else {
                fs::read(entry.path()).unwrap()
            };
            (rel.to_string_lossy().into_owned(), bytes)
        })
        .collect();
    files.sort();
    Snapshot {
        head: repo.head().ok().and_then(|head| head.target()),
        index_tree: repo.index().unwrap().write_tree().unwrap(),
        state: repo.state(),
        files,
    }
}

fn assert_no_merge_state(root: &Path) {
    assert_eq!(
        Repository::open(root).unwrap().state(),
        git2::RepositoryState::Clean
    );
    for name in ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"] {
        assert!(!root.join(".git").join(name).exists(), "{name} left behind");
    }
}

/// The message of a sync pause: an `Io` error that says so up front.
fn paused_message(err: crate::error::AppError) -> String {
    let crate::error::AppError::Io { message } = err else {
        panic!("expected an Io error, got {err:?}");
    };
    assert!(message.starts_with("Sync paused:"), "{message}");
    message
}

#[test]
fn unrelated_histories_pause_the_merge() {
    for configured in [false, true] {
        let fixture = fixture();
        let root_a = &fixture.graph_a;
        write(root_a, "notes/a.md", "# A\n");
        commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
        let own = head_oid(root_a);
        push(root_a, None, &[]).unwrap();
        // The backup now holds a separate history, a local-only folder and
        // all (a device still on a replaced history pushed it back).
        let separate = replace_remote_history(
            &fixture,
            &[
                ("notes/old.md", "# Old\n"),
                ("people/secure/old.md", "# Old secret\n"),
            ],
        );
        let folders = configured
            .then(|| reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap());
        write(root_a, "notes/b.md", "# B\n");
        commit_all(root_a, "a edit", MAX_FILE_BYTES, folders.as_ref()).unwrap();
        if configured {
            write(root_a, "people/secure/visa.md", "# Visa\n");
        }
        fetch(root_a, None).unwrap();
        let before = snapshot(root_a);

        let message = paused_message(merge_remote(root_a, folders.as_ref(), &[]).unwrap_err());
        assert!(message.contains("acceptedHistoryRoots"), "{message}");
        assert!(message.contains(&separate.to_string()), "{message}");
        // Joining would upload this graph's own root: it is named too.
        assert!(message.contains(&own.to_string()), "{message}");
        assert_eq!(snapshot(root_a), before, "configured={configured}");
        assert_no_merge_state(root_a);
    }
}

#[test]
fn an_incoming_fast_forward_that_adds_a_root_pauses() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();
    // Device B merges two separate histories in and pushes the result: for
    // A it is a fast-forward, shared base and all.
    let root_b = second_device(&fixture);
    let first = merge_separate_history(&root_b, &[("notes/old.md", "# Old\n")]);
    let second = merge_separate_history(&root_b, &[("notes/older.md", "# Older\n")]);
    push_unguarded(&root_b);

    fetch(root_a, None).unwrap();
    let before = snapshot(root_a);
    let message = paused_message(merge_remote(root_a, None, &[]).unwrap_err());
    assert!(
        message.contains(&first.to_string()) && message.contains(&second.to_string()),
        "{message}"
    );
    assert_eq!(snapshot(root_a), before);
    assert_no_merge_state(root_a);

    // Every root must be accepted: one listed still pauses on the other.
    let message = paused_message(merge_remote(root_a, None, &[first]).unwrap_err());
    assert!(message.contains(&second.to_string()), "{message}");
    assert!(!message.contains(&first.to_string()), "{message}");
    assert_eq!(snapshot(root_a), before);

    let merged = merge_remote(root_a, None, &[first, second]).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(root_a, "notes/old.md"), "# Old\n");
    assert_eq!(read(root_a, "notes/older.md"), "# Older\n");
}

#[test]
fn accepted_roots_let_separate_histories_join() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    let own = head_oid(root_a);
    push(root_a, None, &[]).unwrap();
    // Another device on this graph's history, from before the join.
    let root_b = second_device(&fixture);
    let separate = replace_remote_history(&fixture, &[("notes/old.md", "# Old\n")]);
    fetch(root_a, None).unwrap();

    let merged = merge_remote(root_a, None, &[separate]).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert_eq!(read(root_a, "notes/old.md"), "# Old\n");
    assert_eq!(read(root_a, "notes/a.md"), "# A\n");
    assert_no_merge_state(root_a);

    // The joined history uploads once this graph's own root is accepted too.
    let refused = push(root_a, None, &[separate]).unwrap();
    assert!(!refused.pushed && !refused.non_fast_forward, "{refused:?}");
    let message = refused.rejection_message.unwrap_or_default();
    assert!(message.contains(&own.to_string()), "{message}");
    assert_eq!(remote_main(&fixture), separate);
    assert!(push(root_a, None, &[separate, own]).unwrap().pushed);
    assert_eq!(remote_main(&fixture), head_oid(root_a));

    // Both roots are now in the history on both sides, so later syncs never
    // check them again: with nothing accepted, sync keeps flowing.
    write(root_a, "notes/a.md", "# A\n\nafter the join\n");
    commit_all(root_a, "Update notes", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();
    let again = merge_remote(root_a, None, &[]).unwrap();
    assert!(matches!(again.kind, MergeKind::UpToDate), "{again:?}");
    assert!(push(root_a, None, &[]).unwrap().pushed);

    // The other device accepts the joined root for the one pull that brings
    // it in, then syncs both ways with nothing accepted.
    fetch(&root_b, None).unwrap();
    let message = paused_message(merge_remote(&root_b, None, &[]).unwrap_err());
    assert!(message.contains(&separate.to_string()), "{message}");
    let joined = merge_remote(&root_b, None, &[separate]).unwrap();
    assert!(matches!(joined.kind, MergeKind::FastForward), "{joined:?}");
    write(&root_b, "notes/b.md", "# B\n");
    commit_all(&root_b, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert!(push(&root_b, None, &[]).unwrap().pushed);
    fetch(root_a, None).unwrap();
    let pulled = merge_remote(root_a, None, &[]).unwrap();
    assert!(matches!(pulled.kind, MergeKind::FastForward), "{pulled:?}");
    assert_eq!(read(root_a, "notes/b.md"), "# B\n");
    assert!(head_tree_paths(root_a).contains(&"notes/old.md".to_string()));
}

/// Once the backup holds a separate history, the next edit's push (commit,
/// then push, with no fetch) shares no history with the backup's branch: it
/// is non-fast-forward before anything is uploaded, so the engine pulls,
/// and the pull's pause, with the recovery that fits, is what the user sees
/// rather than a push refusal naming this graph's own root.
#[test]
fn a_push_against_a_separate_history_pulls_first() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    let own = head_oid(root_a);
    push(root_a, None, &[]).unwrap();
    let separate = replace_remote_history(&fixture, &[("notes/old.md", "# Old\n")]);
    fetch(root_a, None).unwrap();
    paused_message(merge_remote(root_a, None, &[]).unwrap_err());

    write(root_a, "notes/b.md", "# B\n");
    commit_all(root_a, "Update notes", MAX_FILE_BYTES, None).unwrap();
    let before = snapshot(root_a);
    let outcome = push(root_a, None, &[]).unwrap();
    assert!(!outcome.pushed && outcome.non_fast_forward, "{outcome:?}");
    assert_eq!(remote_main(&fixture), separate);

    fetch(root_a, None).unwrap();
    let message = paused_message(merge_remote(root_a, None, &[]).unwrap_err());
    assert!(message.contains(&separate.to_string()), "{message}");
    assert!(message.contains(&own.to_string()), "{message}");
    assert!(
        message.contains("re-clone this graph from the backup; otherwise restore"),
        "{message}"
    );
    assert_eq!(snapshot(root_a), before);
    assert_eq!(remote_main(&fixture), separate);
}

/// The guard checks a push against the last-fetched remote branch, while
/// the server packs it against its live branch. Here the backup is
/// restored to drop a separate root this graph took in (it adopted the
/// backup with no history of its own, which checks nothing). The stale
/// fetch still reaches that root, so the server's moved branch stops the
/// push before anything is uploaded, and after the pull the guard refuses
/// the root instead of fast-forwarding it back onto the backup.
#[test]
fn a_push_checks_the_servers_branch_not_a_stale_fetch() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();
    let restored = remote_main(&fixture);
    let root_b = second_device(&fixture);
    let separate = merge_separate_history(&root_b, &[("notes/old.md", "# Old\n")]);
    push_unguarded(&root_b);
    let root_c = fixture._dir.path().join("graph-c");
    scaffold_graph(&root_c);
    setup(&root_c, Some(fixture.remote_url.clone()), None).unwrap();
    fetch(&root_c, None).unwrap();
    merge_remote(&root_c, None, &[]).unwrap();
    assert_eq!(read(&root_c, "notes/old.md"), "# Old\n");
    Repository::open(&fixture.remote_url)
        .unwrap()
        .reference("refs/heads/main", restored, true, "restore the backup")
        .unwrap();

    write(&root_c, "notes/c.md", "# C\n");
    commit_all(&root_c, "Update notes", MAX_FILE_BYTES, None).unwrap();
    let outcome = push(&root_c, None, &[]).unwrap();
    assert!(!outcome.pushed && outcome.non_fast_forward, "{outcome:?}");
    assert_eq!(remote_main(&fixture), restored);

    fetch(&root_c, None).unwrap();
    let merged = merge_remote(&root_c, None, &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::UpToDate), "{merged:?}");
    let refused = push(&root_c, None, &[]).unwrap();
    assert!(!refused.pushed && !refused.non_fast_forward, "{refused:?}");
    let message = refused.rejection_message.unwrap_or_default();
    assert!(message.contains(&separate.to_string()), "{message}");
    assert_eq!(remote_main(&fixture), restored);
}

#[test]
fn push_refuses_a_local_range_that_adds_a_root() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();
    let pushed = remote_main(&fixture);

    // This graph's history picks up a separate root (a merge made with
    // plain Git): the push is refused before it reaches the remote, as data
    // that never triggers the pull-and-retry loop.
    let separate = merge_separate_history(root_a, &[("notes/old.md", "# Old\n")]);
    let refused = push(root_a, None, &[]).unwrap();
    assert!(!refused.pushed, "{refused:?}");
    assert!(!refused.non_fast_forward, "{refused:?}");
    let message = refused.rejection_message.unwrap_or_default();
    assert!(message.starts_with("Sync paused:"), "{message}");
    assert!(message.contains(&separate.to_string()), "{message}");
    assert!(message.contains("acceptedHistoryRoots"), "{message}");
    assert_eq!(remote_main(&fixture), pushed);

    assert!(push(root_a, None, &[separate]).unwrap().pushed);
    assert_eq!(remote_main(&fixture), head_oid(root_a));
}

#[test]
fn a_fresh_repo_first_push_and_an_unborn_pull_still_work() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    // The first push (no remote branch yet) carries this graph's own root,
    // here with a folder another device keeps local-only.
    write(root_a, "notes/a.md", "# A\n");
    write(root_a, "people/secure/passport.md", "# Passport\n");
    commit_all(root_a, "first", MAX_FILE_BYTES, None).unwrap();
    let merged = merge_remote(root_a, None, &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::UpToDate), "{merged:?}");
    assert!(push(root_a, None, &[]).unwrap().pushed);

    // A fresh graph (unborn HEAD) adopts that history with nothing accepted
    // and, with folders configured, without writing the local-only folder.
    for configured in [false, true] {
        let root = fixture._dir.path().join(format!("fresh-{configured}"));
        scaffold_graph(&root);
        setup(&root, Some(fixture.remote_url.clone()), None).unwrap();
        fetch(&root, None).unwrap();
        let folders = configured
            .then(|| reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap());
        let merged = merge_remote(&root, folders.as_ref(), &[]).unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert_eq!(read(&root, "notes/a.md"), "# A\n");
        assert_eq!(root.join("people/secure/passport.md").exists(), !configured);
        assert_eq!(head_oid(&root), remote_main(&fixture));
        write(&root, &format!("notes/fresh-{configured}.md"), "# Fresh\n");
        commit_all(&root, "Update notes", MAX_FILE_BYTES, folders.as_ref()).unwrap();
        assert!(push(&root, None, &[]).unwrap().pushed, "{configured}");
    }
}

#[test]
fn a_pull_that_adds_entries_under_a_local_only_folder_pauses() {
    for diverged in [false, true] {
        let fixture = fixture();
        let root_a = &fixture.graph_a;
        write(root_a, "notes/a.md", "# A\n");
        commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
        push(root_a, None, &[]).unwrap();
        // Another device, with no configuration, commits a folder this
        // graph keeps local-only and never tracked.
        let root_b = second_device(&fixture);
        write(&root_b, "people/secure/passport.md", "# Passport\n");
        write(&root_b, "notes/b.md", "# B\n");
        commit_all(&root_b, "b adds", MAX_FILE_BYTES, None).unwrap();
        push(&root_b, None, &[]).unwrap();

        let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap();
        write(root_a, "people/secure/visa.md", "# Visa\n");
        if diverged {
            write(root_a, "notes/c.md", "# C\n");
            let local = commit_all(root_a, "a edit", MAX_FILE_BYTES, Some(&folders)).unwrap();
            assert!(local.committed);
        }
        fetch(root_a, None).unwrap();
        let before = snapshot(root_a);
        let message = paused_message(merge_remote(root_a, Some(&folders), &[]).unwrap_err());
        assert!(message.contains("\"people/secure\""), "{message}");
        assert!(message.contains("git rm -r --cached"), "{message}");
        assert_eq!(snapshot(root_a), before, "diverged={diverged}");
        assert_no_merge_state(root_a);
    }
}

#[test]
fn a_pull_that_updates_an_already_tracked_local_only_path_proceeds() {
    for diverged in [false, true] {
        let fixture = fixture();
        let root_a = &fixture.graph_a;
        // Committed before the folder became local-only on this device.
        write(root_a, "people/secure/old.md", "# Old\n");
        write(root_a, "notes/a.md", "# A\n");
        commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
        push(root_a, None, &[]).unwrap();
        let root_b = second_device(&fixture);
        write(&root_b, "people/secure/old.md", "# Old\n\nedited on b\n");
        commit_all(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
        push(&root_b, None, &[]).unwrap();

        let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap();
        write(root_a, "people/secure/old.md", LOCAL_EDIT);
        if diverged {
            write(root_a, "notes/c.md", "# C\n");
            let local = commit_all(root_a, "a edit", MAX_FILE_BYTES, Some(&folders)).unwrap();
            assert!(local.committed);
        }
        fetch(root_a, None).unwrap();
        let merged = merge_remote(root_a, Some(&folders), &[]).unwrap();
        assert_eq!(
            merged.frozen_paths,
            vec!["people/secure/old.md"],
            "{merged:?}"
        );
        assert_eq!(read(root_a, "people/secure/old.md"), LOCAL_EDIT);
        assert_eq!(
            head_blob(root_a, "people/secure/old.md"),
            b"# Old\n\nedited on b\n"
        );
        let again = commit_all(root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
        assert!(!again.committed, "diverged={diverged}");
    }
}

/// The documented way out of a re-tracked local-only folder: untrack it
/// (`git rm -r --cached`) and commit. A diverged pull from a device that
/// still tracks it, unchanged since the shared base, keeps it untracked and
/// does not pause, so the untracking reaches the backup.
#[test]
fn an_untracked_local_only_folder_stays_untracked_through_a_diverged_pull() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "people/secure/old.md", "# Old\n");
    write(root_a, "notes/a.md", "# A\n");
    commit_all(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push(root_a, None, &[]).unwrap();
    let root_b = second_device(&fixture);
    write(&root_b, "notes/a.md", "# A\n\nedited on b\n");
    commit_all(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();

    let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap();
    {
        let repo = Repository::open(root_a).unwrap();
        let mut index = repo.index().unwrap();
        index.remove_dir(Path::new("people/secure"), 0).unwrap();
        index.write().unwrap();
    }
    let untracked = commit_all(root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(untracked.committed);
    fetch(root_a, None).unwrap();

    let merged = merge_remote(root_a, Some(&folders), &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert_eq!(read(root_a, "notes/a.md"), "# A\n\nedited on b\n");
    assert_eq!(read(root_a, "people/secure/old.md"), "# Old\n");
    assert!(!head_tree_paths(root_a).contains(&"people/secure/old.md".to_string()));
    assert!(push(root_a, None, &[]).unwrap().pushed);
}

/// Command tier: `git_merge_remote` and `git_push` take the open graph's
/// accepted history roots from `GraphState`, against a control session that
/// accepts none.
#[test]
fn the_git_commands_take_accepted_roots_from_the_open_graph() {
    use tauri::Manager;
    for accepted in [false, true] {
        // A pull that would bring in a separate root.
        let fixture = fixture();
        let root_a = fixture.graph_a.clone();
        write(&root_a, "notes/a.md", "# A\n");
        commit_all(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
        push(&root_a, None, &[]).unwrap();
        let root_b = second_device(&fixture);
        let incoming = merge_separate_history(&root_b, &[("notes/old.md", "# Old\n")]);
        push_unguarded(&root_b);
        fetch(&root_a, None).unwrap();
        // A push that would upload one, from another graph.
        let other = self::fixture();
        write(&other.graph_a, "notes/a.md", "# A\n");
        commit_all(&other.graph_a, "base", MAX_FILE_BYTES, None).unwrap();
        push(&other.graph_a, None, &[]).unwrap();
        let outgoing = merge_separate_history(&other.graph_a, &[("notes/old.md", "# Old\n")]);

        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(crate::fs::GraphState::default());
        let open = |root: &Path, generation: u64| {
            let state: tauri::State<crate::fs::GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = generation;
            inner.root = Some(root.to_path_buf());
            inner.set_accepted_history_roots(if accepted {
                vec![incoming, outgoing]
            } else {
                Vec::new()
            });
        };

        open(&root_a, 1);
        let merged = tauri::async_runtime::block_on(super::git_merge_remote(
            1,
            app.handle().clone(),
            app.state(),
        ));
        open(&other.graph_a, 2);
        let pushed = tauri::async_runtime::block_on(super::git_push(None, 2, app.state()))
            .expect("a push outcome");
        if accepted {
            assert!(matches!(merged.unwrap().kind, MergeKind::FastForward));
            assert!(pushed.pushed, "{pushed:?}");
        } else {
            let message = paused_message(merged.expect_err("paused"));
            assert!(message.contains(&incoming.to_string()), "{message}");
            assert!(!pushed.pushed && !pushed.non_fast_forward, "{pushed:?}");
            let message = pushed.rejection_message.unwrap_or_default();
            assert!(message.contains(&outgoing.to_string()), "{message}");
        }
    }
}

/// Pull safety: displacement, deferral, the write guard, and rollback.
mod displacement;
