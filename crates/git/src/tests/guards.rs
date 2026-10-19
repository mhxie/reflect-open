//! The sync guards a graph's backup applies beyond the merge itself: its
//! local-only folders are never staged and never written by a pull, a pull
//! or push that would join a history root the graph has not accepted
//! pauses, an incoming path Reflect never writes pauses, and a merged text
//! at or above the size limit is never committed.

use std::path::{Path, PathBuf};

use reflect_graph_paths::LocalOnlyFolders;
use reflect_types::AppError;

use super::super::merge::{MergeOutcome, merge_remote_with};
use super::*;

/// Commit with the graph's local-only folders.
pub(super) fn commit_with(
    root: &Path,
    message: &str,
    max_file_bytes: u64,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<CommitOutcome> {
    super::super::commit_all(root, message, max_file_bytes, local_only)
}

/// Push with the graph's accepted history roots.
pub(super) fn push_with(
    root: &Path,
    credential: Option<GitCredential>,
    accepted_roots: &[git2::Oid],
) -> AppResult<PushOutcome> {
    super::super::push(root, credential, accepted_roots)
}

/// Pull with the graph's local-only folders and accepted roots, at the
/// default size limit.
pub(super) fn pull_with(
    root: &Path,
    local_only: Option<&LocalOnlyFolders>,
    accepted_roots: &[git2::Oid],
) -> AppResult<MergeOutcome> {
    let policy = PullPolicy {
        local_only,
        accepted_roots,
        max_file_bytes: MAX_FILE_BYTES,
    };
    merge_remote_with(root, &policy)
}

pub(super) fn head_oid(root: &Path) -> git2::Oid {
    Repository::open(root)
        .unwrap()
        .head()
        .unwrap()
        .target()
        .unwrap()
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
    commit_with(root, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert_eq!(head_message(root), "Add private note");
}

/// The guardrail measures a link, never what it points at: Git records a
/// symlink as its target path, so a link to a large file is backed up (and
/// retargeted) like any other, and never reported as withheld.
#[cfg(unix)]
#[test]
fn a_link_to_a_large_file_is_never_withheld() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    commit_with(root, "scaffold", MAX_FILE_BYTES, None).unwrap();
    let outside = fixture._dir.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("huge.bin"), "0123456789abcdef").unwrap();
    fs::write(outside.join("other.bin"), "0123456789abcdef").unwrap();
    std::os::unix::fs::symlink(outside.join("huge.bin"), root.join("assets/link.bin")).unwrap();

    let outcome = commit_with(root, "link", 10, None).unwrap();
    assert!(outcome.committed);
    assert!(outcome.skipped_large_files.is_empty(), "{outcome:?}");
    assert!(head_tree_paths(root).contains(&"assets/link.bin".to_string()));

    fs::remove_file(root.join("assets/link.bin")).unwrap();
    std::os::unix::fs::symlink(outside.join("other.bin"), root.join("assets/link.bin")).unwrap();
    let outcome = commit_with(root, "retarget", 10, None).unwrap();
    assert!(outcome.committed, "a retargeted link must be backed up");
    assert!(outcome.skipped_large_files.is_empty(), "{outcome:?}");
}

/// A merged text that reaches the size limit is never committed: the merge
/// keeps this device's version in history (the other device's is the
/// second parent), the merged text lands on disk, and the next commit
/// withholds and reports it.
#[test]
fn an_oversized_merge_is_withheld() {
    const LIMIT: u64 = 21;
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    commit_with(root_a, "scaffold", MAX_FILE_BYTES, None).unwrap();
    write(root_a, "notes/shared.md", "base line\n");
    commit_with(root_a, "base", LIMIT, None).unwrap();
    push_with(root_a, None, &[]).unwrap();

    let root_b = second_device(&fixture);
    write(&root_b, "notes/shared.md", "edited on the phone\n");
    commit_with(&root_b, "b edit", LIMIT, None).unwrap();
    push_with(&root_b, None, &[]).unwrap();

    write(root_a, "notes/shared.md", "edited on the mac\n");
    commit_with(root_a, "a edit", LIMIT, None).unwrap();
    fetch(root_a, None).unwrap();
    let policy = PullPolicy {
        max_file_bytes: LIMIT,
        ..PullPolicy::default()
    };
    let merged = merge_remote_with(root_a, &policy).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert!(
        merged
            .changed_files
            .iter()
            .any(|change| change.path == "notes/shared.md"),
        "{merged:?}"
    );
    let content = read(root_a, "notes/shared.md");
    assert!(content.len() as u64 >= LIMIT, "{content}");
    assert!(
        content.contains("mac") && content.contains("phone"),
        "{content}"
    );
    assert!(!content.contains("<<<<<<<"), "{content}");

    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.state(), git2::RepositoryState::Clean);
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
    assert_eq!(
        head_blob_bytes(root_a, "notes/shared.md"),
        b"edited on the mac\n"
    );

    let outcome = commit_with(root_a, "Update notes", LIMIT, None).unwrap();
    assert!(!outcome.committed, "{outcome:?}");
    assert_eq!(outcome.skipped_large_files.len(), 1, "{outcome:?}");
    assert_eq!(outcome.skipped_large_files[0].path, "notes/shared.md");
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
    commit_with(&unguarded, "Update notes", MAX_FILE_BYTES, None).unwrap();
    let paths = head_tree_paths(&unguarded);
    assert!(paths.contains(&"finance/secure".to_string()), "{paths:?}");
    assert!(paths.contains(&"people/secure/passport.md".to_string()));

    let guarded = graph_with_local_only_folders(&base, "guarded");
    let folders =
        reflect_graph_paths::LocalOnlyFolders::new(["secure"], Some(&base.join("guarded-raw")))
            .unwrap();
    let outcome = commit_with(&guarded, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
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
    let again = commit_with(&guarded, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(!again.committed, "only local-only content changed");
}

/// `graph_with_local_only_folders`'s configuration with `secure` editable.
#[cfg(unix)]
fn editable_secure(base: &Path, name: &str) -> reflect_graph_paths::LocalOnlyFolders {
    reflect_graph_paths::LocalOnlyFolders::new(["secure"], Some(&base.join(format!("{name}-raw"))))
        .unwrap()
        .with_editable(["secure"])
        .0
}

/// Editable local-only folders (linked and real, attachments included) and
/// Reflect's own trash and recovery stores never enter a backup commit.
#[cfg(unix)]
#[test]
fn editable_local_only_folders_and_reflect_stores_are_never_staged() {
    let dir = tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let root = graph_with_local_only_folders(&base, "graph");
    let folders = editable_secure(&base, "graph");
    write(
        &base.join("graph-raw"),
        "finance/secure/assets/scan.png",
        "png",
    );
    write(&root, "people/secure/assets/id.png", "png");
    write(&root, ".reflect/trash/0123abcd/bank.md", "# Bank\n");
    write(&root, ".reflect/recovery/0123abcd.json", "{}");

    let outcome = commit_with(&root, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(outcome.committed);
    let paths = head_tree_paths(&root);
    assert!(paths.contains(&"notes/public.md".to_string()), "{paths:?}");
    assert!(
        !paths
            .iter()
            .any(|path| path.contains("secure") || path.starts_with(".reflect")),
        "{paths:?}"
    );

    // Later edits there commit nothing.
    write(
        &base.join("graph-raw"),
        "finance/secure/bank.md",
        "# Bank\n\nedited\n",
    );
    write(&root, "people/secure/passport.md", "# Passport\n\nedited\n");
    write(&root, ".reflect/recovery/4567.json", "{}");
    let again = commit_with(&root, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(!again.committed);
}

#[test]
fn tracked_files_inside_a_local_only_folder_are_frozen_not_updated() {
    // A folder committed before it was configured local-only: the ignore
    // rule cannot reach tracked paths, so the staging guard keeps every
    // later change (edits and deletions alike) out of the backup.
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "personal/secure/old.md", "# Old\n");
    commit_with(root, "Update notes", MAX_FILE_BYTES, None).unwrap();

    let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap();
    write(
        root,
        "personal/secure/old.md",
        "# Old\n\nnew private line\n",
    );
    write(root, "notes/a.md", "# A\n");
    commit_with(root, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
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
    commit_with(root, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
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

pub(super) fn head_blob_bytes(root: &Path, rel: &str) -> Vec<u8> {
    let repo = Repository::open(root).unwrap();
    let tree = repo.head().unwrap().peel_to_tree().unwrap();
    let entry = tree.get_path(Path::new(rel)).unwrap();
    let blob = repo.find_blob(entry.id()).unwrap();
    blob.content().to_vec()
}

pub(super) fn is_symlink(path: &Path) -> bool {
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
    commit_with(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push_with(&root_a, None, &[]).unwrap();
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
    let commit = commit_with(&root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
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
        commit_with(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
        push_with(&migrated.root_b, None, &[]).unwrap();

        fetch(root_a, None).unwrap();
        let merged = pull_with(root_a, Some(&migrated.folders), &[]).unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert!(raw_edit_survived(&migrated), "ignorecase={ignorecase}");
        assert_eq!(read(root_a, "notes/a.md"), "# A\n\nedited on b\n");
        assert!(merged.frozen_paths.is_empty(), "{merged:?}");
        let repo = Repository::open(root_a).unwrap();
        assert_eq!(
            repo.head().unwrap().target(),
            repo.refname_to_id("refs/remotes/origin/main").ok()
        );
        let again = commit_with(
            root_a,
            "Update notes",
            MAX_FILE_BYTES,
            Some(&migrated.folders),
        );
        assert!(!again.unwrap().committed);
    }
}

/// Control: without the configuration a fast-forward still writes only the
/// paths the other device changed. When the other device does change a path
/// behind the link, the safe checkout never writes through it: the pull
/// refuses, or the link gives way to the other device's folder.
#[cfg(unix)]
#[test]
fn without_the_configuration_a_fast_forward_writes_only_what_changed() {
    for ignorecase in [true, false] {
        let migrated = migrated(ignorecase);
        let root_a = &migrated.fixture.graph_a;
        write(&migrated.root_b, "notes/a.md", "# A\n\nedited on b\n");
        commit_with(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
        push_with(&migrated.root_b, None, &[]).unwrap();
        fetch(root_a, None).unwrap();
        let merged = pull_with(root_a, None, &[]).unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert_eq!(read(root_a, "notes/a.md"), "# A\n\nedited on b\n");
        assert!(raw_edit_survived(&migrated), "ignorecase={ignorecase}");

        write(
            &migrated.root_b,
            "finance/secure/x.md",
            "# X\n\nedited on b\n",
        );
        commit_with(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
        push_with(&migrated.root_b, None, &[]).unwrap();
        fetch(root_a, None).unwrap();
        let merged = pull_with(root_a, None, &[]);
        assert_eq!(
            fs::read_to_string(migrated.raw.join("finance/secure/x.md")).unwrap(),
            LOCAL_EDIT,
            "ignorecase={ignorecase}"
        );
        if merged.is_ok() {
            assert!(!is_symlink(&root_a.join("finance/secure")));
            assert_eq!(read(root_a, "finance/secure/x.md"), "# X\n\nedited on b\n");
        }
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
    commit_with(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push_with(&root_a, None, &[]).unwrap();
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
    push_with(&root_b, None, &[]).unwrap();
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
    let message = paused_message(pull_with(root_a, Some(&folders), &[]).unwrap_err());
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
    let again = commit_with(root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(!again.committed);
}

#[cfg(unix)]
#[test]
fn without_the_configuration_remote_additions_land_in_the_raw_store() {
    let (fixture, raw, _, _) = link_with_remote_additions();
    let root_a = &fixture.graph_a;
    let result = pull_with(root_a, None, &[]);
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
    let local = commit_with(root_a, "a edit", MAX_FILE_BYTES, Some(&migrated.folders)).unwrap();
    assert!(local.committed);

    write(
        &migrated.root_b,
        "finance/secure/x.md",
        "# X\n\nedited on b\n",
    );
    write(&migrated.root_b, "finance/secure/new.md", "# New\n");
    write(&migrated.root_b, "notes/a.md", "# A\n\nedited on b\n");
    commit_with(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push_with(&migrated.root_b, None, &[]).unwrap();

    fetch(root_a, None).unwrap();
    let merged = pull_with(root_a, Some(&migrated.folders), &[]).unwrap();
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
        head_blob_bytes(root_a, "finance/secure/x.md"),
        b"# X\n\nedited on b\n"
    );
    assert_eq!(head_blob_bytes(root_a, "finance/secure/new.md"), b"# New\n");
    let again = commit_with(
        root_a,
        "Update notes",
        MAX_FILE_BYTES,
        Some(&migrated.folders),
    )
    .unwrap();
    assert!(!again.committed);
    assert!(push_with(root_a, None, &[]).unwrap().pushed);
}

#[cfg(unix)]
#[test]
fn without_the_configuration_a_diverged_merge_refuses_or_clobbers() {
    let migrated = migrated(true);
    let root_a = &migrated.fixture.graph_a;
    write(root_a, "notes/b.md", "# B\n");
    commit_with(root_a, "a edit", MAX_FILE_BYTES, Some(&migrated.folders)).unwrap();
    write(
        &migrated.root_b,
        "finance/secure/x.md",
        "# X\n\nedited on b\n",
    );
    commit_with(&migrated.root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push_with(&migrated.root_b, None, &[]).unwrap();
    fetch(root_a, None).unwrap();
    let result = pull_with(root_a, None, &[]);
    assert!(
        result.is_err() || !raw_edit_survived(&migrated),
        "{result:?}"
    );
}

const LINK: i32 = 0o120000;

pub(super) const FILE: i32 = 0o100644;

/// Commit on top of `root`'s HEAD by editing a flattened index of its tree,
/// leaving the working tree alone: `(path, Some((bytes, mode)))` writes a file
/// or link at `path`, `(path, None)` removes it; either way whatever sat at
/// or under `path` goes first, so a test can change an entry's type.
/// One edit for [`commit_index_edits`]: the bytes and mode to write, or
/// `None` to remove.
pub(super) type IndexEdit<'a> = (&'a str, Option<(&'a [u8], i32)>);

pub(super) fn commit_index_edits(root: &Path, edits: &[IndexEdit<'_>]) {
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
    let again = commit_with(root_a, "Update notes", MAX_FILE_BYTES, Some(folders)).unwrap();
    assert!(!again.committed, "the pull left the index off HEAD");
    commit_index_edits(root_b, &[("notes/later.md", Some((b"# Later\n", FILE)))]);
    push_with(root_b, None, &[]).unwrap();
    fetch(root_a, None).unwrap();
    pull_with(root_a, Some(folders), &[]).expect("a later pull");
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
    pull_with(root_a, None, &[]).expect("pull the link");
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
        commit_with(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
        push_with(&root_a, None, &[]).unwrap();
        let root_b = second_device(&fixture);
        // Another device committed its own link (it has no configuration).
        commit_index_edits(
            &root_b,
            &[("finance/secure", Some((b"/elsewhere/secure", LINK)))],
        );
        push_with(&root_b, None, &[]).unwrap();
        let (raw, folders) = track_the_link_then_make_it_local_only(&fixture, &root_a);

        // Upstream, the link becomes a real folder.
        commit_index_edits(
            &root_b,
            &[
                ("finance/secure", None),
                ("finance/secure/x.md", Some((b"# X\n", FILE))),
            ],
        );
        push_with(&root_b, None, &[]).unwrap();
        if diverged {
            write(&root_a, "notes/b.md", "# B\n");
            assert!(
                commit_with(&root_a, "a edit", MAX_FILE_BYTES, Some(&folders))
                    .unwrap()
                    .committed
            );
        }
        fetch(&root_a, None).unwrap();
        let merged = pull_with(&root_a, Some(&folders), &[]).expect("pull the folder");
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
        push_with(&migrated.root_b, None, &[]).unwrap();
        if diverged {
            write(root_a, "notes/b.md", "# B\n");
            assert!(
                commit_with(root_a, "a edit", MAX_FILE_BYTES, Some(&migrated.folders))
                    .unwrap()
                    .committed
            );
        }
        fetch(root_a, None).unwrap();
        let merged = pull_with(root_a, Some(&migrated.folders), &[]).expect("pull the link");
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
    commit_with(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push_with(&root_a, None, &[]).unwrap();
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
    push_with(&root_b, None, &[]).unwrap();
    if diverged {
        write(&root_a, "notes/b.md", "# B\n");
        assert!(
            commit_with(&root_a, "a edit", MAX_FILE_BYTES, Some(&folders))
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
        let err = pull_with(root_a, Some(&folders), &[]).expect_err("refused");
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
    let result = pull_with(root_a, None, &[]);
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
    commit_with(root_a, "plan", MAX_FILE_BYTES, Some(&migrated.folders)).unwrap();
    push_with(root_a, None, &[]).unwrap();
    fetch(&migrated.root_b, None).unwrap();
    pull_with(&migrated.root_b, None, &[]).unwrap();
    commit_index_edits(
        &migrated.root_b,
        &[
            ("notes/a.md", Some((b"# A\n\nedited on b\n", FILE))),
            ("people/plan.md", Some((b"# Plan\n\nedited on b\n", FILE))),
        ],
    );
    push_with(&migrated.root_b, None, &[]).unwrap();
    fetch(root_a, None).unwrap();

    let repo = Repository::open(root_a).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    let locked = root_a.join("people");
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o555)).unwrap();
    let failed = pull_with(root_a, Some(&migrated.folders), &[]);
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

    let merged = pull_with(root_a, Some(&migrated.folders), &[]).expect("the retry");
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(root_a, "people/plan.md"), "# Plan\n\nedited on b\n");
    assert!(raw_edit_survived(&migrated));
    let again = commit_with(
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
    push_with(&migrated.root_b, None, &[]).unwrap();
    fetch(root_a, None).unwrap();

    let repo = Repository::open(root_a).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    let lock = root_a.join(".git/index.lock");
    fs::write(&lock, b"").unwrap();
    let failed = pull_with(root_a, Some(&migrated.folders), &[]);
    fs::remove_file(&lock).unwrap();
    assert!(failed.is_err(), "{failed:?}");
    let repo = Repository::open(root_a).unwrap();
    assert_eq!(repo.head().unwrap().target(), Some(head));
    let head_tree = repo.find_commit(head).unwrap().tree_id();
    assert_eq!(repo.index().unwrap().write_tree().unwrap(), head_tree);

    let merged = pull_with(root_a, Some(&migrated.folders), &[]).expect("the retry");
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(root_a, "notes/a.md"), "# A\n\nedited on b\n");
    assert!(raw_edit_survived(&migrated));
    let again = commit_with(
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
        commit_with(&root_a, "base", MAX_FILE_BYTES, None).unwrap();
        push_with(&root_a, None, &[]).unwrap();
        let root_b = second_device(&fixture);
        commit_index_edits(
            &root_b,
            &[("finance/secure", Some((b"/elsewhere/secure", LINK)))],
        );
        push_with(&root_b, None, &[]).unwrap();
        let (raw, folders) = track_the_link_then_make_it_local_only(&fixture, &root_a);
        assert!(index_paths(&root_a).contains(&"finance/secure".to_string()));

        commit_index_edits(&root_b, &[("finance/secure", None)]);
        push_with(&root_b, None, &[]).unwrap();
        if diverged {
            write(&root_a, "notes/b.md", "# B\n");
            assert!(
                commit_with(&root_a, "a edit", MAX_FILE_BYTES, Some(&folders))
                    .unwrap()
                    .committed
            );
        }
        fetch(&root_a, None).unwrap();
        let merged = pull_with(&root_a, Some(&folders), &[]).expect("pull the deletion");
        assert!(
            merged.frozen_paths.contains(&"finance/secure".to_string()),
            "{merged:?}"
        );
        assert!(!index_paths(&root_a).contains(&"finance/secure".to_string()));
        assert!(!head_tree_paths(&root_a).contains(&"finance/secure".to_string()));
        assert!(is_symlink(&root_a.join("finance/secure")));
        assert_eq!(read(&raw, "finance/secure/bank.md"), "# Bank\n");
        let again = commit_with(&root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
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

pub(super) fn remote_main(fixture: &Fixture) -> git2::Oid {
    Repository::open(&fixture.remote_url)
        .unwrap()
        .refname_to_id("refs/heads/main")
        .unwrap()
}

/// Everything a paused pull must leave as it was: HEAD, the index, the
/// repository state, and every file in the graph (a link by its target).
#[derive(Debug, PartialEq)]
pub(super) struct Snapshot {
    head: Option<git2::Oid>,
    index_tree: git2::Oid,
    state: git2::RepositoryState,
    files: Vec<(String, Vec<u8>)>,
}

pub(super) fn snapshot(root: &Path) -> Snapshot {
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

pub(super) fn assert_no_merge_state(root: &Path) {
    assert_eq!(
        Repository::open(root).unwrap().state(),
        git2::RepositoryState::Clean
    );
    for name in ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"] {
        assert!(!root.join(".git").join(name).exists(), "{name} left behind");
    }
}

/// The message of a sync pause: an `Io` error that says so up front.
pub(super) fn paused_message(err: AppError) -> String {
    let AppError::Io { message, .. } = err else {
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
        commit_with(root_a, "base", MAX_FILE_BYTES, None).unwrap();
        let own = head_oid(root_a);
        push_with(root_a, None, &[]).unwrap();
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
        commit_with(root_a, "a edit", MAX_FILE_BYTES, folders.as_ref()).unwrap();
        if configured {
            write(root_a, "people/secure/visa.md", "# Visa\n");
        }
        fetch(root_a, None).unwrap();
        let before = snapshot(root_a);

        let message = paused_message(pull_with(root_a, folders.as_ref(), &[]).unwrap_err());
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
    commit_with(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push_with(root_a, None, &[]).unwrap();
    // Device B merges two separate histories in and pushes the result: for
    // A it is a fast-forward, shared base and all.
    let root_b = second_device(&fixture);
    let first = merge_separate_history(&root_b, &[("notes/old.md", "# Old\n")]);
    let second = merge_separate_history(&root_b, &[("notes/older.md", "# Older\n")]);
    push_unguarded(&root_b);

    fetch(root_a, None).unwrap();
    let before = snapshot(root_a);
    let message = paused_message(pull_with(root_a, None, &[]).unwrap_err());
    assert!(
        message.contains(&first.to_string()) && message.contains(&second.to_string()),
        "{message}"
    );
    assert_eq!(snapshot(root_a), before);
    assert_no_merge_state(root_a);

    // Every root must be accepted: one listed still pauses on the other.
    let message = paused_message(pull_with(root_a, None, &[first]).unwrap_err());
    assert!(message.contains(&second.to_string()), "{message}");
    assert!(!message.contains(&first.to_string()), "{message}");
    assert_eq!(snapshot(root_a), before);

    let merged = pull_with(root_a, None, &[first, second]).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(root_a, "notes/old.md"), "# Old\n");
    assert_eq!(read(root_a, "notes/older.md"), "# Older\n");
}

#[test]
fn accepted_roots_let_separate_histories_join() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    write(root_a, "notes/a.md", "# A\n");
    commit_with(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    let own = head_oid(root_a);
    push_with(root_a, None, &[]).unwrap();
    // Another device on this graph's history, from before the join.
    let root_b = second_device(&fixture);
    let separate = replace_remote_history(&fixture, &[("notes/old.md", "# Old\n")]);
    fetch(root_a, None).unwrap();

    let merged = pull_with(root_a, None, &[separate]).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert_eq!(read(root_a, "notes/old.md"), "# Old\n");
    assert_eq!(read(root_a, "notes/a.md"), "# A\n");
    assert_no_merge_state(root_a);

    // The joined history uploads once this graph's own root is accepted too.
    let refused = push_with(root_a, None, &[separate]).unwrap();
    assert!(!refused.pushed && !refused.non_fast_forward, "{refused:?}");
    let message = refused.rejection_message.unwrap_or_default();
    assert!(message.contains(&own.to_string()), "{message}");
    assert_eq!(remote_main(&fixture), separate);
    assert!(push_with(root_a, None, &[separate, own]).unwrap().pushed);
    assert_eq!(remote_main(&fixture), head_oid(root_a));

    // Both roots are now in the history on both sides, so later syncs never
    // check them again: with nothing accepted, sync keeps flowing.
    write(root_a, "notes/a.md", "# A\n\nafter the join\n");
    commit_with(root_a, "Update notes", MAX_FILE_BYTES, None).unwrap();
    fetch(root_a, None).unwrap();
    let again = pull_with(root_a, None, &[]).unwrap();
    assert!(matches!(again.kind, MergeKind::UpToDate), "{again:?}");
    assert!(push_with(root_a, None, &[]).unwrap().pushed);

    // The other device accepts the joined root for the one pull that brings
    // it in, then syncs both ways with nothing accepted.
    fetch(&root_b, None).unwrap();
    let message = paused_message(pull_with(&root_b, None, &[]).unwrap_err());
    assert!(message.contains(&separate.to_string()), "{message}");
    let joined = pull_with(&root_b, None, &[separate]).unwrap();
    assert!(matches!(joined.kind, MergeKind::FastForward), "{joined:?}");
    write(&root_b, "notes/b.md", "# B\n");
    commit_with(&root_b, "Update notes", MAX_FILE_BYTES, None).unwrap();
    assert!(push_with(&root_b, None, &[]).unwrap().pushed);
    fetch(root_a, None).unwrap();
    let pulled = pull_with(root_a, None, &[]).unwrap();
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
    commit_with(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    let own = head_oid(root_a);
    push_with(root_a, None, &[]).unwrap();
    let separate = replace_remote_history(&fixture, &[("notes/old.md", "# Old\n")]);
    fetch(root_a, None).unwrap();
    paused_message(pull_with(root_a, None, &[]).unwrap_err());

    write(root_a, "notes/b.md", "# B\n");
    commit_with(root_a, "Update notes", MAX_FILE_BYTES, None).unwrap();
    let before = snapshot(root_a);
    let outcome = push_with(root_a, None, &[]).unwrap();
    assert!(!outcome.pushed && outcome.non_fast_forward, "{outcome:?}");
    assert_eq!(remote_main(&fixture), separate);

    fetch(root_a, None).unwrap();
    let message = paused_message(pull_with(root_a, None, &[]).unwrap_err());
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
    commit_with(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push_with(root_a, None, &[]).unwrap();
    let restored = remote_main(&fixture);
    let root_b = second_device(&fixture);
    let separate = merge_separate_history(&root_b, &[("notes/old.md", "# Old\n")]);
    push_unguarded(&root_b);
    let root_c = fixture._dir.path().join("graph-c");
    scaffold_graph(&root_c);
    setup(&root_c, Some(fixture.remote_url.clone()), None).unwrap();
    fs::remove_file(root_c.join(".gitignore")).unwrap();
    fetch(&root_c, None).unwrap();
    pull_with(&root_c, None, &[]).unwrap();
    assert_eq!(read(&root_c, "notes/old.md"), "# Old\n");
    Repository::open(&fixture.remote_url)
        .unwrap()
        .reference("refs/heads/main", restored, true, "restore the backup")
        .unwrap();

    write(&root_c, "notes/c.md", "# C\n");
    commit_with(&root_c, "Update notes", MAX_FILE_BYTES, None).unwrap();
    let outcome = push_with(&root_c, None, &[]).unwrap();
    assert!(!outcome.pushed && outcome.non_fast_forward, "{outcome:?}");
    assert_eq!(remote_main(&fixture), restored);

    fetch(&root_c, None).unwrap();
    let merged = pull_with(&root_c, None, &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::UpToDate), "{merged:?}");
    let refused = push_with(&root_c, None, &[]).unwrap();
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
    commit_with(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push_with(root_a, None, &[]).unwrap();
    let pushed = remote_main(&fixture);

    // This graph's history picks up a separate root (a merge made with
    // plain Git): the push is refused before it reaches the remote, as data
    // that never triggers the pull-and-retry loop.
    let separate = merge_separate_history(root_a, &[("notes/old.md", "# Old\n")]);
    let refused = push_with(root_a, None, &[]).unwrap();
    assert!(!refused.pushed, "{refused:?}");
    assert!(!refused.non_fast_forward, "{refused:?}");
    let message = refused.rejection_message.unwrap_or_default();
    assert!(message.starts_with("Sync paused:"), "{message}");
    assert!(message.contains(&separate.to_string()), "{message}");
    assert!(message.contains("acceptedHistoryRoots"), "{message}");
    assert_eq!(remote_main(&fixture), pushed);

    assert!(push_with(root_a, None, &[separate]).unwrap().pushed);
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
    commit_with(root_a, "first", MAX_FILE_BYTES, None).unwrap();
    let merged = pull_with(root_a, None, &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::UpToDate), "{merged:?}");
    assert!(push_with(root_a, None, &[]).unwrap().pushed);

    // A fresh graph (unborn HEAD) adopts that history with nothing accepted
    // and, with folders configured, without writing the local-only folder.
    for configured in [false, true] {
        let root = fixture._dir.path().join(format!("fresh-{configured}"));
        scaffold_graph(&root);
        setup(&root, Some(fixture.remote_url.clone()), None).unwrap();
        // The safe checkout never overwrites an untracked file, even an
        // identical one.
        fs::remove_file(root.join(".gitignore")).unwrap();
        fetch(&root, None).unwrap();
        let folders = configured
            .then(|| reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap());
        let merged = pull_with(&root, folders.as_ref(), &[]).unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert_eq!(read(&root, "notes/a.md"), "# A\n");
        assert_eq!(root.join("people/secure/passport.md").exists(), !configured);
        assert_eq!(head_oid(&root), remote_main(&fixture));
        write(&root, &format!("notes/fresh-{configured}.md"), "# Fresh\n");
        commit_with(&root, "Update notes", MAX_FILE_BYTES, folders.as_ref()).unwrap();
        assert!(push_with(&root, None, &[]).unwrap().pushed, "{configured}");
    }
}

#[test]
fn a_pull_that_adds_entries_under_a_local_only_folder_pauses() {
    for diverged in [false, true] {
        let fixture = fixture();
        let root_a = &fixture.graph_a;
        write(root_a, "notes/a.md", "# A\n");
        commit_with(root_a, "base", MAX_FILE_BYTES, None).unwrap();
        push_with(root_a, None, &[]).unwrap();
        // Another device, with no configuration, commits a folder this
        // graph keeps local-only and never tracked.
        let root_b = second_device(&fixture);
        write(&root_b, "people/secure/passport.md", "# Passport\n");
        write(&root_b, "notes/b.md", "# B\n");
        commit_with(&root_b, "b adds", MAX_FILE_BYTES, None).unwrap();
        push_with(&root_b, None, &[]).unwrap();

        let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap();
        write(root_a, "people/secure/visa.md", "# Visa\n");
        if diverged {
            write(root_a, "notes/c.md", "# C\n");
            let local = commit_with(root_a, "a edit", MAX_FILE_BYTES, Some(&folders)).unwrap();
            assert!(local.committed);
        }
        fetch(root_a, None).unwrap();
        let before = snapshot(root_a);
        let message = paused_message(pull_with(root_a, Some(&folders), &[]).unwrap_err());
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
        commit_with(root_a, "base", MAX_FILE_BYTES, None).unwrap();
        push_with(root_a, None, &[]).unwrap();
        let root_b = second_device(&fixture);
        write(&root_b, "people/secure/old.md", "# Old\n\nedited on b\n");
        commit_with(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
        push_with(&root_b, None, &[]).unwrap();

        let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap();
        write(root_a, "people/secure/old.md", LOCAL_EDIT);
        if diverged {
            write(root_a, "notes/c.md", "# C\n");
            let local = commit_with(root_a, "a edit", MAX_FILE_BYTES, Some(&folders)).unwrap();
            assert!(local.committed);
        }
        fetch(root_a, None).unwrap();
        let merged = pull_with(root_a, Some(&folders), &[]).unwrap();
        assert_eq!(
            merged.frozen_paths,
            vec!["people/secure/old.md"],
            "{merged:?}"
        );
        assert_eq!(read(root_a, "people/secure/old.md"), LOCAL_EDIT);
        assert_eq!(
            head_blob_bytes(root_a, "people/secure/old.md"),
            b"# Old\n\nedited on b\n"
        );
        let again = commit_with(root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
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
    commit_with(root_a, "base", MAX_FILE_BYTES, None).unwrap();
    push_with(root_a, None, &[]).unwrap();
    let root_b = second_device(&fixture);
    write(&root_b, "notes/a.md", "# A\n\nedited on b\n");
    commit_with(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push_with(&root_b, None, &[]).unwrap();

    let folders = reflect_graph_paths::LocalOnlyFolders::new(["secure"], None).unwrap();
    {
        let repo = Repository::open(root_a).unwrap();
        let mut index = repo.index().unwrap();
        index.remove_dir(Path::new("people/secure"), 0).unwrap();
        index.write().unwrap();
    }
    let untracked = commit_with(root_a, "Update notes", MAX_FILE_BYTES, Some(&folders)).unwrap();
    assert!(untracked.committed);
    fetch(root_a, None).unwrap();

    let merged = pull_with(root_a, Some(&folders), &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert_eq!(read(root_a, "notes/a.md"), "# A\n\nedited on b\n");
    assert_eq!(read(root_a, "people/secure/old.md"), "# Old\n");
    assert!(!head_tree_paths(root_a).contains(&"people/secure/old.md".to_string()));
    assert!(push_with(root_a, None, &[]).unwrap().pushed);
}

// ---- unsafe incoming paths --------------------------------------------------

/// A graph backed up to the fixture's remote, with local-only folders (a link
/// into a raw store and a real folder) when `configured`.
pub(super) struct Device {
    pub(super) fixture: Fixture,
    folders: Option<LocalOnlyFolders>,
    raw: PathBuf,
}

impl Device {
    pub(super) fn new(configured: bool) -> Self {
        let fixture = fixture();
        let root = fixture.graph_a.clone();
        let raw = fixture._dir.path().canonicalize().unwrap().join("raw");
        write(&root, "notes/a.md", "# A\n");
        let folders = configured.then(|| {
            write(&raw, "finance/secure/bank.md", "# Bank\n");
            fs::create_dir_all(root.join("finance")).unwrap();
            #[cfg(unix)]
            std::os::unix::fs::symlink(raw.join("finance/secure"), root.join("finance/secure"))
                .unwrap();
            write(&root, "people/secure/passport.md", "# Passport\n");
            LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap()
        });
        let device = Self {
            fixture,
            folders,
            raw,
        };
        device.commit();
        push_with(device.root(), None, &[]).unwrap();
        device
    }

    pub(super) fn root(&self) -> &Path {
        &self.fixture.graph_a
    }

    pub(super) fn folders(&self) -> Option<&LocalOnlyFolders> {
        self.folders.as_ref()
    }

    pub(super) fn commit(&self) -> bool {
        commit_with(self.root(), "Update notes", MAX_FILE_BYTES, self.folders())
            .unwrap()
            .committed
    }

    pub(super) fn pull(&self) -> MergeOutcome {
        fetch(self.root(), None).unwrap();
        pull_with(self.root(), self.folders(), &[]).unwrap()
    }

    /// The local-only folders are exactly as configured, whatever the pull
    /// did around them.
    pub(super) fn assert_local_only_untouched(&self) {
        if self.folders.is_none() {
            return;
        }
        assert!(is_symlink(&self.root().join("finance/secure")));
        assert_eq!(read(&self.raw, "finance/secure/bank.md"), "# Bank\n");
        assert_eq!(
            read(self.root(), "people/secure/passport.md"),
            "# Passport\n"
        );
    }
}

/// Commit `files` on another device of `device`'s backup and push them.
pub(super) fn push_from_b(device: &Device, files: &[(&str, &str)]) -> PathBuf {
    let root_b = second_device(&device.fixture);
    for (path, contents) in files {
        write(&root_b, path, contents);
    }
    commit_with(&root_b, "from b", MAX_FILE_BYTES, None).unwrap();
    push_with(&root_b, None, &[]).unwrap();
    root_b
}

pub(super) fn index_tree(root: &Path) -> git2::Oid {
    Repository::open(root)
        .unwrap()
        .index()
        .unwrap()
        .write_tree()
        .unwrap()
}

pub(super) fn head_tree(root: &Path) -> git2::Oid {
    Repository::open(root)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_tree()
        .unwrap()
        .id()
}

type RawEntry = (&'static str, Vec<u8>, git2::Oid);

/// Write a tree straight into the object store, entries in Git's order
/// (a tree sorts as its name plus `/`), so it can hold names libgit2's
/// tree builder refuses. Returns a commit of it on `parent`, moving no ref.
fn commit_raw_tree(repo: &Repository, mut entries: Vec<RawEntry>, parent: git2::Oid) -> git2::Oid {
    entries.sort_by_key(|(mode, name, _)| {
        let mut key = name.clone();
        if *mode == "40000" {
            key.push(b'/');
        }
        key
    });
    let mut bytes = Vec::new();
    for (mode, name, id) in &entries {
        bytes.extend_from_slice(mode.as_bytes());
        bytes.push(b' ');
        bytes.extend_from_slice(name);
        bytes.push(0);
        bytes.extend_from_slice(id.as_bytes());
    }
    let tree = repo
        .odb()
        .unwrap()
        .write(git2::ObjectType::Tree, &bytes)
        .unwrap();
    let tree = repo.find_tree(tree).unwrap();
    let parent = repo.find_commit(parent).unwrap();
    let sig = git2::Signature::now("Device B", "b@example.invalid").unwrap();
    repo.commit(None, &sig, &sig, "hostile tree", &tree, &[&parent])
        .unwrap()
}

#[derive(Clone, Copy, Debug)]
enum Hostile {
    DotDot,
    DotGit,
    RuntimeDir,
}

fn pauses_on_a_hostile_entry(hostile: Hostile, configured: bool, diverged: bool) {
    let device = Device::new(configured);
    let root = device.root();
    let repo = Repository::open(root).unwrap();
    let base = head_oid(root);
    let base_tree = repo.find_commit(base).unwrap().tree().unwrap();
    let blob = repo.blob(b"#!/bin/sh\necho owned\n").unwrap();
    let mut hooks = repo.treebuilder(None).unwrap();
    hooks.insert("config", blob, 0o100_644).unwrap();
    let hooks = hooks.write().unwrap();
    let mut entries: Vec<RawEntry> = base_tree
        .iter()
        .map(|entry| {
            let mode = if entry.kind() == Some(git2::ObjectType::Tree) {
                "40000"
            } else {
                "100644"
            };
            (mode, entry.name_bytes().to_vec(), entry.id())
        })
        .collect();
    entries.push(match hostile {
        Hostile::DotDot => ("100644", b"..".to_vec(), blob),
        Hostile::DotGit => ("40000", b".GIT".to_vec(), hooks),
        Hostile::RuntimeDir => {
            let envelope = repo.blob(br#"{"screenshotRef":"p.jpg"}"#).unwrap();
            let mut inbox = repo.treebuilder(None).unwrap();
            inbox.insert("evil.json", envelope, 0o100_644).unwrap();
            let inbox = inbox.write().unwrap();
            let mut runtime = repo.treebuilder(None).unwrap();
            runtime.insert("inbox", inbox, 0o040_000).unwrap();
            let runtime = runtime.write().unwrap();
            ("40000", ".re\u{fb02}ect".as_bytes().to_vec(), runtime)
        }
    });
    let hostile_commit = commit_raw_tree(&repo, entries, base);
    if diverged {
        write(root, "notes/b.md", "# B\n");
        assert!(device.commit());
    }
    repo.reference("refs/remotes/origin/main", hostile_commit, true, "hostile")
        .unwrap();
    let before = snapshot(root);
    let config = fs::read(root.join(".git/config")).unwrap();
    let beside = || {
        let mut names: Vec<_> = fs::read_dir(device.fixture._dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        names.sort();
        names
    };
    let beside_before = beside();

    let message = paused_message(pull_with(root, device.folders(), &[]).unwrap_err());
    assert!(message.contains("Remove that path"), "{message}");
    let reason = match hostile {
        Hostile::DotDot => "`..`",
        Hostile::DotGit => "`.git`",
        Hostile::RuntimeDir => "`.reflect`",
    };
    assert!(message.contains(reason), "{message}");
    let case = format!("{hostile:?} configured={configured} diverged={diverged}");
    assert_eq!(snapshot(root), before, "{case}");
    // `.GIT/config` is `.git/config` on a volume that folds case, and
    // `..` is the folder holding the graph.
    assert_eq!(fs::read(root.join(".git/config")).unwrap(), config);
    assert_eq!(beside(), beside_before);
    assert!(!root.join(".reflect/inbox").exists(), "{case}");
    assert_no_merge_state(root);
}

/// A remote tree with a `..`, a `.git` spelling, or a `.reflect` spelling the
/// volume folds onto the runtime folder pauses the pull before anything is
/// written, fast-forward or merge, with or without local-only folders.
#[cfg(unix)]
#[test]
fn dot_dot_and_dot_git_paths_pause_sync() {
    let cases = [(false, false), (true, false), (false, true), (true, true)];
    for hostile in [Hostile::DotDot, Hostile::DotGit, Hostile::RuntimeDir] {
        for (configured, diverged) in cases {
            pauses_on_a_hostile_entry(hostile, configured, diverged);
        }
    }
}

/// Only the other device's changes are checked: a path only this device
/// committed (here a backslash in a name) never pauses a merge.
#[cfg(unix)]
#[test]
fn a_path_only_this_device_committed_never_pauses_a_merge() {
    const BACKSLASH: &str = "notes/a\\b.md";
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        write(root, BACKSLASH, "# Backslash\n");
        assert!(device.commit());
        assert!(head_tree_paths(root).contains(&BACKSLASH.to_string()));
        push_from_b(&device, &[("notes/c.md", "# C from the phone\n")]);

        let merged = device.pull();
        assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
        assert_eq!(read(root, "notes/c.md"), "# C from the phone\n");
        assert_eq!(read(root, BACKSLASH), "# Backslash\n");
        assert_eq!(index_tree(root), head_tree(root), "configured={configured}");
        assert_no_merge_state(root);
        device.assert_local_only_untouched();
        assert!(!device.commit(), "configured={configured}");
        assert!(push_with(root, None, &[]).unwrap().pushed);
    }
}
