//! Pull safety (see `git::displace`): a pull never overwrites bytes that
//! were never committed. It moves them to `name (this device).ext`, defers
//! when a save raced the cycle's commit, pauses on a path it must not write,
//! and puts everything back when it fails. Collisions run without and with
//! local-only folders on device A.

#![cfg(unix)]

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use super::*;

const DAILY: &str = "daily/2026-10-04.md";
const DAILY_COPY: &str = "daily/2026-10-04 (this device).md";
const LOCKED: &str = "---\nprivate: true\n---\n# Plan\n\nonly on this Mac\n";

/// Device A with a committed, pushed base, plus local-only folders when
/// `configured`: a `finance/secure` link into a raw store and a real
/// `people/secure/` folder, kept out of every commit.
struct Device {
    fixture: Fixture,
    folders: Option<LocalOnlyFolders>,
    raw: PathBuf,
}

impl Device {
    fn new(configured: bool) -> Self {
        let fixture = fixture();
        let root = fixture.graph_a.clone();
        let raw = fixture._dir.path().canonicalize().unwrap().join("raw");
        write(&root, "notes/a.md", "# A\n");
        let folders = configured.then(|| {
            write(&raw, "finance/secure/bank.md", "# Bank\n");
            fs::create_dir_all(root.join("finance")).unwrap();
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
        push(device.root(), None, &[]).unwrap();
        device
    }

    fn root(&self) -> &Path {
        &self.fixture.graph_a
    }

    fn folders(&self) -> Option<&LocalOnlyFolders> {
        self.folders.as_ref()
    }

    fn commit(&self) -> bool {
        commit_all(self.root(), "Update notes", MAX_FILE_BYTES, self.folders())
            .unwrap()
            .committed
    }

    fn pull(&self) -> MergeOutcome {
        fetch(self.root(), None).unwrap();
        merge_remote(self.root(), self.folders(), &[]).unwrap()
    }

    /// The local-only folders are exactly as configured, whatever the pull
    /// did around them.
    fn assert_local_only_untouched(&self) {
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

/// Another device that pushes `files` (path, contents) in one commit.
fn push_from_b(device: &Device, files: &[(&str, &str)]) -> PathBuf {
    let root_b = second_device(&device.fixture);
    for (path, contents) in files {
        write(&root_b, path, contents);
    }
    commit_all(&root_b, "from b", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();
    root_b
}

fn displaced(from: &str, to: &str) -> DisplacedFile {
    DisplacedFile {
        from: from.to_string(),
        to: to.to_string(),
        kept_out: false,
        tracked: false,
        different_note: false,
    }
}

fn changed_paths(merged: &MergeOutcome) -> Vec<&str> {
    merged
        .changed_files
        .iter()
        .map(|change| change.path.as_str())
        .collect()
}

fn parked_entries(root: &Path) -> Vec<String> {
    let Ok(listing) = fs::read_dir(root.join(".reflect/tmp")) else {
        return Vec::new();
    };
    listing
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with("displaced-"))
        .collect()
}

/// The repository index as a tree: after a pull it must equal HEAD's.
fn index_tree(root: &Path) -> git2::Oid {
    Repository::open(root)
        .unwrap()
        .index()
        .unwrap()
        .write_tree()
        .unwrap()
}

fn head_tree(root: &Path) -> git2::Oid {
    Repository::open(root)
        .unwrap()
        .head()
        .unwrap()
        .peel_to_tree()
        .unwrap()
        .id()
}

// ---- collisions, without and with local-only folders --------------------

#[test]
fn a_fast_forward_never_overwrites_an_untracked_note() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        push_from_b(&device, &[(DAILY, "# Today from the phone\n")]);
        write(root, DAILY, "# Today on this Mac\n");

        let merged = device.pull();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert_eq!(read(root, DAILY), "# Today from the phone\n");
        assert_eq!(read(root, DAILY_COPY), "# Today on this Mac\n");
        assert_eq!(merged.displaced, vec![displaced(DAILY, DAILY_COPY)]);
        let changed = changed_paths(&merged);
        assert!(changed.contains(&DAILY) && changed.contains(&DAILY_COPY));
        let copy = merged
            .changed_files
            .iter()
            .find(|change| change.path == DAILY_COPY)
            .unwrap();
        assert!(copy.modified_ms.is_some(), "{merged:?}");
        assert_eq!(index_tree(root), head_tree(root), "configured={configured}");
        device.assert_local_only_untouched();
        // The copy is an ordinary new note: the next commit backs it up.
        assert!(device.commit());
        assert!(head_tree_paths(root).contains(&DAILY_COPY.to_string()));
    }
}

#[test]
fn a_diverged_merge_never_overwrites_or_stalls() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        push_from_b(&device, &[(DAILY, "# Today from the phone\n")]);
        write(root, "notes/a.md", "# A\n\nedited here\n");
        assert!(device.commit());
        write(root, DAILY, "# Today on this Mac\n");

        let merged = device.pull();
        assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
        assert_eq!(read(root, DAILY), "# Today from the phone\n");
        assert_eq!(read(root, DAILY_COPY), "# Today on this Mac\n");
        assert_eq!(read(root, "notes/a.md"), "# A\n\nedited here\n");
        assert_eq!(merged.displaced, vec![displaced(DAILY, DAILY_COPY)]);
        assert!(changed_paths(&merged).contains(&DAILY_COPY));
        assert_no_merge_state(root);
        device.assert_local_only_untouched();
        assert!(push(root, None, &[]).unwrap().pushed);
    }
}

#[test]
fn an_unborn_repo_pull_displaces_untracked_notes() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let fresh = device.fixture._dir.path().join("fresh");
        scaffold_graph(&fresh);
        setup(&fresh, Some(device.fixture.remote_url.clone()), None).unwrap();
        write(&fresh, "notes/a.md", "# A written here first\n");
        fetch(&fresh, None).unwrap();

        let merged = merge_remote(&fresh, device.folders(), &[]).unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert_eq!(read(&fresh, "notes/a.md"), "# A\n");
        assert_eq!(
            read(&fresh, "notes/a (this device).md"),
            "# A written here first\n"
        );
        assert_eq!(
            merged.displaced,
            vec![displaced("notes/a.md", "notes/a (this device).md")]
        );
        assert_eq!(head_oid(&fresh), head_oid(device.root()));
        assert_eq!(index_tree(&fresh), head_tree(&fresh));
    }
}

/// A tracked note locked on this Mac after the cycle's commit holds bytes
/// the commit would keep out (once withholding lands): the pull moves them
/// to a copy, writes the index version back so the pull meets a clean file,
/// and the other device's edit takes the path.
#[test]
fn a_held_tracked_path_the_remote_writes_is_displaced_and_restored() {
    for (configured, diverged) in [(false, false), (true, false), (false, true)] {
        let device = Device::new(configured);
        let root = device.root();
        write(root, "notes/plan.md", "# Plan\n");
        assert!(device.commit());
        push(root, None, &[]).unwrap();
        push_from_b(&device, &[("notes/plan.md", "# Plan\n\nfrom the phone\n")]);
        if diverged {
            write(root, "notes/other.md", "# Other\n");
            assert!(device.commit());
        }
        write(root, "notes/plan.md", LOCKED);

        let merged = device.pull();
        let expected = if diverged {
            MergeKind::Merged
        } else {
            MergeKind::FastForward
        };
        assert_eq!(
            std::mem::discriminant(&merged.kind),
            std::mem::discriminant(&expected),
            "{merged:?}"
        );
        assert_eq!(read(root, "notes/plan.md"), "# Plan\n\nfrom the phone\n");
        assert_eq!(read(root, "notes/plan (this device).md"), LOCKED);
        assert_eq!(
            merged.displaced,
            vec![DisplacedFile {
                kept_out: true,
                tracked: true,
                ..displaced("notes/plan.md", "notes/plan (this device).md")
            }]
        );
        assert_eq!(
            head_blob(root, "notes/plan.md"),
            b"# Plan\n\nfrom the phone\n"
        );
        assert_eq!(index_tree(root), head_tree(root));
        device.assert_local_only_untouched();
    }
}

#[test]
fn a_remote_delete_of_a_held_path_keeps_the_macs_bytes_in_the_copy() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        write(root, "notes/plan.md", "# Plan\n");
        assert!(device.commit());
        push(root, None, &[]).unwrap();
        let root_b = second_device(&device.fixture);
        fs::remove_file(root_b.join("notes/plan.md")).unwrap();
        commit_all(&root_b, "b delete", MAX_FILE_BYTES, None).unwrap();
        push(&root_b, None, &[]).unwrap();
        write(root, "notes/plan.md", LOCKED);

        let merged = device.pull();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert!(!root.join("notes/plan.md").exists());
        assert_eq!(read(root, "notes/plan (this device).md"), LOCKED);
        assert_eq!(
            merged.displaced,
            vec![DisplacedFile {
                kept_out: true,
                tracked: true,
                ..displaced("notes/plan.md", "notes/plan (this device).md")
            }]
        );
        assert!(!head_tree_paths(root).contains(&"notes/plan.md".to_string()));
        device.assert_local_only_untouched();
    }
}

// ---- paths and identity ------------------------------------------------------

/// The trackedness lookup leans on this: under `core.ignorecase` the index
/// finds an entry by any case of its path.
#[test]
fn the_index_folds_case_under_core_ignorecase() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/Plan.md", "# Plan\n");
    commit_all(root, "base", MAX_FILE_BYTES, None).unwrap();
    for ignorecase in [true, false] {
        let repo = Repository::open(root).unwrap();
        repo.config()
            .unwrap()
            .set_bool("core.ignorecase", ignorecase)
            .unwrap();
        let repo = Repository::open(root).unwrap();
        let index = repo.index().unwrap();
        assert_eq!(
            index.get_path(Path::new("notes/plan.md"), 0).is_some(),
            ignorecase
        );
    }
}

/// On a volume that folds case and Unicode normalization (APFS), a note
/// spelled differently from the incoming path is the same file: it moves
/// aside under its own spelling. Elsewhere the two names are two files.
#[test]
fn case_only_and_nfd_collisions_are_displaced() {
    const NFD: &str = "notes/cafe\u{301}.md";
    const NFC: &str = "notes/caf\u{e9}.md";
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        Repository::open(root)
            .unwrap()
            .config()
            .unwrap()
            .set_bool("core.ignorecase", true)
            .unwrap();
        push_from_b(
            &device,
            &[
                ("notes/plan.md", "# Plan from the phone\n"),
                (NFC, "# Café\n"),
            ],
        );
        write(root, "notes/Plan.md", "# Plan on this Mac\n");
        write(root, NFD, "# Cafe on this Mac\n");
        let folds_case = root.join("notes/plan.md").exists();
        let folds_form = root.join(NFC).exists();

        let merged = device.pull();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        let mut expected = Vec::new();
        if folds_case {
            assert_eq!(
                read(root, "notes/Plan (this device).md"),
                "# Plan on this Mac\n"
            );
            expected.push(displaced("notes/Plan.md", "notes/Plan (this device).md"));
        } else {
            assert_eq!(read(root, "notes/Plan.md"), "# Plan on this Mac\n");
        }
        if folds_form {
            let copy = "notes/cafe\u{301} (this device).md";
            assert_eq!(read(root, copy), "# Cafe on this Mac\n");
            expected.push(displaced(NFD, copy));
        } else {
            assert_eq!(read(root, NFD), "# Cafe on this Mac\n");
        }
        assert_eq!(read(root, "notes/plan.md"), "# Plan from the phone\n");
        assert_eq!(read(root, NFC), "# Café\n");
        let mut found = merged.displaced.clone();
        found.sort_by(|left, right| left.from.cmp(&right.from));
        expected.sort_by(|left, right| left.from.cmp(&right.from));
        assert_eq!(found, expected, "case={folds_case} form={folds_form}");
        device.assert_local_only_untouched();
    }
}

/// An incoming tree can hold two spellings of one name (NFC and NFD). On a
/// volume that folds normalization both reach this device's one note, which
/// moves once; elsewhere only the spelling it has is in the way. Either way
/// the pull lands.
#[test]
fn twin_spellings_in_one_incoming_tree_move_one_note_once() {
    const NFD: &str = "notes/cafe\u{301}.md";
    const NFC: &str = "notes/caf\u{e9}.md";
    const COPY: &str = "notes/cafe\u{301} (this device).md";
    let device = Device::new(false);
    let root = device.root();
    let root_b = second_device(&device.fixture);
    commit_index_edits(
        &root_b,
        &[
            (NFC, Some((b"# NFC from the phone\n", FILE))),
            (NFD, Some((b"# NFD from the phone\n", FILE))),
        ],
    );
    push(&root_b, None, &[]).unwrap();
    write(root, NFD, "# Mine, never committed\n");

    let merged = device.pull();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(merged.displaced, vec![displaced(NFD, COPY)]);
    assert_eq!(read(root, COPY), "# Mine, never committed\n");
    assert_eq!(index_tree(root), head_tree(root));
}

/// Names that differ only in case are one note on a volume that folds case,
/// moved once, and two notes on one that doesn't, each moved: neither is
/// ever left for the checkout to overwrite.
#[test]
fn names_differing_in_case_move_as_the_volume_sees_them() {
    let device = Device::new(false);
    let root = device.root();
    let root_b = second_device(&device.fixture);
    commit_index_edits(
        &root_b,
        &[
            ("notes/Twin.md", Some((b"# Upper from the phone\n", FILE))),
            ("notes/twin.md", Some((b"# Lower from the phone\n", FILE))),
        ],
    );
    push(&root_b, None, &[]).unwrap();
    write(root, "notes/Twin.md", "# Upper on this Mac\n");
    let folds_case = root.join("notes/twin.md").exists();
    if !folds_case {
        write(root, "notes/twin.md", "# Lower on this Mac\n");
    }

    let merged = device.pull();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(
        read(root, "notes/Twin (this device).md"),
        "# Upper on this Mac\n"
    );
    if folds_case {
        assert_eq!(
            merged.displaced,
            vec![displaced("notes/Twin.md", "notes/Twin (this device).md")]
        );
    } else {
        // The second copy's first name folds onto the first copy's.
        assert_eq!(
            merged.displaced,
            vec![
                displaced("notes/Twin.md", "notes/Twin (this device).md"),
                displaced("notes/twin.md", "notes/twin (this device 2).md"),
            ]
        );
        assert_eq!(
            read(root, "notes/twin (this device 2).md"),
            "# Lower on this Mac\n"
        );
        assert_eq!(read(root, "notes/Twin.md"), "# Upper from the phone\n");
        assert_eq!(read(root, "notes/twin.md"), "# Lower from the phone\n");
    }
}

/// An untracked `notes/sub` link where the pull writes `notes/sub/x.md`:
/// the link itself moves aside, so nothing is written through it. With
/// local-only folders configured, a path beyond a link that leaves the graph
/// is frozen, and the local-only rule pauses the pull before that: either
/// way nothing reaches the link's target.
#[test]
fn a_symlinked_parent_is_moved_never_followed() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        let outside = device.fixture._dir.path().join("outside");
        write(&outside, "x.md", "# Outside the graph\n");
        push_from_b(&device, &[("notes/sub/x.md", "# Inside\n")]);
        std::os::unix::fs::symlink(&outside, root.join("notes/sub")).unwrap();
        fetch(root, None).unwrap();

        let merged = merge_remote(root, device.folders(), &[]);
        assert_eq!(read(&outside, "x.md"), "# Outside the graph\n");
        assert_eq!(fs::read_dir(&outside).unwrap().count(), 1);
        device.assert_local_only_untouched();
        if configured {
            let message = paused_message(merged.unwrap_err());
            assert!(message.contains("\"notes/sub/x.md\""), "{message}");
            assert!(is_symlink(&root.join("notes/sub")));
            continue;
        }
        let merged = merged.unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        let aside = root.join("notes/sub (this device)");
        assert!(is_symlink(&aside));
        assert_eq!(fs::read_link(&aside).unwrap(), outside);
        assert!(!is_symlink(&root.join("notes/sub")));
        assert_eq!(read(root, "notes/sub/x.md"), "# Inside\n");
        assert_eq!(
            merged.displaced,
            vec![displaced("notes/sub", "notes/sub (this device)")]
        );
    }
}

/// One raw tree entry for [`commit_raw_tree`]: mode, name, object.
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

/// One hostile entry a raw tree can carry, each tried on its own: `..` (the
/// folder holding the graph), `.GIT` (`.git` on a volume that folds case),
/// and `.reﬂect` (the `ﬂ` ligature, which APFS folds onto the graph's own
/// `.reflect`) holding a capture envelope for the spool.
#[derive(Clone, Copy, Debug)]
enum Hostile {
    DotDot,
    DotGit,
    RuntimeDir,
}

#[test]
fn dot_dot_and_dot_git_paths_pause_sync() {
    let cases = [(false, false), (true, false), (false, true), (true, true)];
    for hostile in [Hostile::DotDot, Hostile::DotGit, Hostile::RuntimeDir] {
        for (configured, diverged) in cases {
            pauses_on_a_hostile_entry(hostile, configured, diverged);
        }
    }
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

    let message = paused_message(merge_remote(root, device.folders(), &[]).unwrap_err());
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

/// Only the paths the pull writes are validated: a name only this device
/// committed (a backslash is an ordinary character on macOS) is never
/// written by a merge, so it never pauses one, before or after the merge
/// writes anything.
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
        assert!(push(root, None, &[]).unwrap().pushed);
    }
}

/// A kept copy's name is free in HEAD, the index, the incoming tree, and
/// the write set, not only on disk.
#[test]
fn displacement_names_never_collide() {
    let device = Device::new(false);
    let root = device.root();
    write(
        root,
        "notes/plan (this device 2).md",
        "# Kept from before\n",
    );
    assert!(device.commit());
    push(root, None, &[]).unwrap();
    push_from_b(
        &device,
        &[
            ("notes/plan.md", "# Plan from the phone\n"),
            ("notes/plan (this device).md", "# The phone's own copy\n"),
        ],
    );
    write(root, "notes/plan.md", "# Plan on this Mac\n");

    let merged = device.pull();
    let copy = "notes/plan (this device 3).md";
    assert_eq!(merged.displaced, vec![displaced("notes/plan.md", copy)]);
    assert_eq!(read(root, copy), "# Plan on this Mac\n");
    assert_eq!(
        read(root, "notes/plan (this device).md"),
        "# The phone's own copy\n"
    );
    assert_eq!(
        read(root, "notes/plan (this device 2).md"),
        "# Kept from before\n"
    );
    assert_eq!(read(root, "notes/plan.md"), "# Plan from the phone\n");
}

/// A copy's name is free in every spelling the volume folds onto it: an
/// incoming file spelled in another Unicode normalization is the same name
/// on APFS, and the checkout would write it over the copy.
#[test]
fn copy_names_are_free_in_every_spelling_the_volume_folds() {
    const NFC: &str = "notes/caf\u{e9}.md";
    const THEIRS: &str = "notes/cafe\u{301} (this device).md";
    const MINE: &str = "notes/caf\u{e9} (this device 2).md";
    let device = Device::new(false);
    let root = device.root();
    let root_b = second_device(&device.fixture);
    commit_index_edits(
        &root_b,
        &[
            (NFC, Some(("# Café from the phone\n".as_bytes(), FILE))),
            (THEIRS, Some((b"# The other device's own copy\n", FILE))),
        ],
    );
    push(&root_b, None, &[]).unwrap();
    write(root, NFC, "# Café on this Mac\n");

    let merged = device.pull();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(merged.displaced, vec![displaced(NFC, MINE)]);
    assert_eq!(read(root, MINE), "# Café on this Mac\n");
    assert_eq!(read(root, THEIRS), "# The other device's own copy\n");
    assert_eq!(read(root, NFC), "# Café from the phone\n");
}

/// A name no tree knows can still be taken on disk: the exclusive rename
/// finds it and moves on, never over it.
#[test]
fn exclusive_rename_never_clobbers() {
    let device = Device::new(false);
    let root = device.root();
    push_from_b(&device, &[("notes/plan.md", "# Plan from the phone\n")]);
    write(root, "notes/plan.md", "# Plan on this Mac\n");
    write(root, "notes/plan (this device).md", "# Unrelated\n");

    let merged = device.pull();
    assert_eq!(
        merged.displaced,
        vec![displaced("notes/plan.md", "notes/plan (this device 2).md")]
    );
    assert_eq!(read(root, "notes/plan (this device).md"), "# Unrelated\n");
    assert_eq!(
        read(root, "notes/plan (this device 2).md"),
        "# Plan on this Mac\n"
    );
}

/// Two names of one hard-linked file both move: one left behind would have
/// the checkout truncate the shared file in place, the moved copy included.
#[test]
fn every_name_of_a_hard_linked_note_moves_aside() {
    let device = Device::new(false);
    let root = device.root();
    push_from_b(
        &device,
        &[
            ("notes/one.md", "# One from the phone\n"),
            ("notes/two.md", "# Two from the phone\n"),
        ],
    );
    write(root, "notes/one.md", "# Shared on this Mac\n");
    fs::hard_link(root.join("notes/one.md"), root.join("notes/two.md")).unwrap();

    let merged = device.pull();
    assert_eq!(
        merged.displaced,
        vec![
            displaced("notes/one.md", "notes/one (this device).md"),
            displaced("notes/two.md", "notes/two (this device).md"),
        ]
    );
    assert_eq!(read(root, "notes/one.md"), "# One from the phone\n");
    assert_eq!(read(root, "notes/two.md"), "# Two from the phone\n");
    assert_eq!(
        read(root, "notes/one (this device).md"),
        "# Shared on this Mac\n"
    );
    assert_eq!(
        read(root, "notes/two (this device).md"),
        "# Shared on this Mac\n"
    );
}

/// The walk names the entry in the pull's way by its own spelling, never by
/// another name of the same hard-linked file: on a volume that folds case,
/// `notes/one.md` reaches `One.md`, which moves, while `Alpha.md` (listed
/// first, same inode) stays.
#[test]
fn only_the_hard_link_in_the_way_moves() {
    let device = Device::new(false);
    let root = device.root();
    push_from_b(&device, &[("notes/one.md", "# One from the phone\n")]);
    write(root, "notes/One.md", "# Shared on this Mac\n");
    fs::hard_link(root.join("notes/One.md"), root.join("notes/Alpha.md")).unwrap();
    let folds_case = root.join("notes/one.md").exists();

    let merged = device.pull();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(read(root, "notes/Alpha.md"), "# Shared on this Mac\n");
    assert_eq!(read(root, "notes/one.md"), "# One from the phone\n");
    if folds_case {
        assert_eq!(
            merged.displaced,
            vec![displaced("notes/One.md", "notes/One (this device).md")]
        );
        assert_eq!(
            read(root, "notes/One (this device).md"),
            "# Shared on this Mac\n"
        );
    } else {
        assert!(merged.displaced.is_empty(), "{merged:?}");
        assert_eq!(read(root, "notes/One.md"), "# Shared on this Mac\n");
    }
}

// ---- other cases ---------------------------------------------------------------

#[test]
fn identical_bytes_make_no_copy() {
    for diverged in [false, true] {
        let device = Device::new(false);
        let root = device.root();
        write(root, "notes/edited.md", "# Edited\n");
        assert!(device.commit());
        push(root, None, &[]).unwrap();
        push_from_b(
            &device,
            &[
                ("notes/same.md", "# Same\n"),
                ("notes/edited.md", "# Edited\n\nthe same edit\n"),
            ],
        );
        if diverged {
            write(root, "notes/b.md", "# B\n");
            assert!(device.commit());
        }
        // Untracked and equal to the incoming file, and a tracked edit both
        // devices made identically.
        write(root, "notes/same.md", "# Same\n");
        write(root, "notes/edited.md", "# Edited\n\nthe same edit\n");

        let merged = device.pull();
        assert!(
            matches!(merged.kind, MergeKind::FastForward | MergeKind::Merged),
            "{merged:?}"
        );
        assert!(merged.displaced.is_empty(), "{merged:?}");
        assert_eq!(read(root, "notes/same.md"), "# Same\n");
        assert_eq!(read(root, "notes/edited.md"), "# Edited\n\nthe same edit\n");
        assert!(!root.join("notes/same (this device).md").exists());
        assert!(!root.join("notes/edited (this device).md").exists());
        assert_eq!(parked_entries(root), Vec::<String>::new());
    }
}

/// Hidden paths are never moved: ignored junk the other device committed
/// simply takes the path.
#[test]
fn ignored_junk_is_not_displaced() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        let root_b = second_device(&device.fixture);
        commit_index_edits(
            &root_b,
            &[
                ("notes/.DS_Store", Some((b"phone junk", FILE))),
                ("notes/b.md", Some((b"# B\n", FILE))),
            ],
        );
        push(&root_b, None, &[]).unwrap();
        write(root, "notes/.DS_Store", "finder junk");

        let merged = device.pull();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert!(merged.displaced.is_empty(), "{merged:?}");
        assert_eq!(read(root, "notes/.DS_Store"), "phone junk");
        assert!(!root.join("notes/.DS_Store (this device)").exists());
        assert_eq!(read(root, "notes/b.md"), "# B\n");
        device.assert_local_only_untouched();
    }
}

/// Only a plain hidden file at the path written is replaced. A hidden link
/// at that path, or a hidden link or file where the pull needs a folder,
/// pauses sync: libgit2 removes such an entry only where it folds case, and
/// elsewhere would write through the link. With local-only folders
/// configured, a link that leaves the graph pauses through that rule first.
#[test]
fn a_hidden_link_or_file_in_the_way_pauses_sync() {
    // (the incoming path, whether the hidden `notes/.cfg` is a link)
    let cases = [
        ("notes/.cfg", true),
        ("notes/.cfg/x.md", true),
        ("notes/.cfg/x.md", false),
    ];
    for configured in [false, true] {
        for (incoming, link) in cases {
            let device = Device::new(configured);
            let root = device.root();
            let outside = device.fixture._dir.path().join("outside");
            write(&outside, "x.md", "# Outside the graph\n");
            let root_b = second_device(&device.fixture);
            commit_index_edits(&root_b, &[(incoming, Some((b"# From the phone\n", FILE)))]);
            push(&root_b, None, &[]).unwrap();
            if link {
                let target = if incoming == "notes/.cfg" {
                    outside.join("x.md")
                } else {
                    outside.clone()
                };
                std::os::unix::fs::symlink(target, root.join("notes/.cfg")).unwrap();
            } else {
                write(root, "notes/.cfg", "hidden, never backed up\n");
            }
            fetch(root, None).unwrap();
            let before = snapshot(root);

            let paused = merge_remote(root, device.folders(), &[]).unwrap_err();
            let message = paused_message(paused);
            let case = format!("configured={configured} {incoming} link={link}");
            assert!(message.contains("\"notes/.cfg"), "{case}: {message}");
            assert_eq!(snapshot(root), before, "{case}");
            assert_eq!(read(&outside, "x.md"), "# Outside the graph\n");
            assert_eq!(fs::read_dir(&outside).unwrap().count(), 1, "{case}");
            device.assert_local_only_untouched();
        }
    }
}

#[test]
fn an_untracked_folder_where_the_remote_adds_a_file_pauses_sync() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        let root_b = second_device(&device.fixture);
        commit_index_edits(
            &root_b,
            &[
                ("notes/sub", Some((b"# Now a file\n", FILE))),
                ("notes/empty", Some((b"# Also a file\n", FILE))),
            ],
        );
        push(&root_b, None, &[]).unwrap();
        write(root, "notes/sub/a.md", "# Not backed up yet\n");
        fs::create_dir_all(root.join("notes/empty")).unwrap();
        fetch(root, None).unwrap();
        let before = snapshot(root);

        let message = paused_message(merge_remote(root, device.folders(), &[]).unwrap_err());
        assert!(message.contains("\"notes/sub\""), "{message}");
        assert_eq!(snapshot(root), before, "configured={configured}");
        assert_eq!(read(root, "notes/sub/a.md"), "# Not backed up yet\n");

        // Once the folder is out of the way, the empty one gives way too.
        fs::rename(root.join("notes/sub"), root.join("notes/sub-folder")).unwrap();
        let merged = merge_remote(root, device.folders(), &[]).unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert_eq!(read(root, "notes/sub"), "# Now a file\n");
        assert_eq!(read(root, "notes/empty"), "# Also a file\n");
        assert!(merged.displaced.is_empty(), "{merged:?}");
    }
}

/// Make the checkout that follows displacement fail on `dir`, which sorts
/// before the displaced path, so the displaced path is still free.
fn fail_the_checkout_in(dir: PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    super::super::merge::seam::AFTER_DISPLACEMENT.set(Some(Box::new(move || {
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        Ok(())
    })));
}

#[test]
fn a_failed_checkout_moves_copies_back() {
    use std::os::unix::fs::PermissionsExt;
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        push_from_b(
            &device,
            &[("assets/z.bin", "zzz"), (DAILY, "# Today from the phone\n")],
        );
        write(root, DAILY, "# Today on this Mac\n");
        fetch(root, None).unwrap();
        let head = head_oid(root);
        let assets = root.join("assets");
        fail_the_checkout_in(assets.clone());

        let (failed, stranded) = pull(root, device.folders(), &[], MAX_FILE_BYTES);
        fs::set_permissions(&assets, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(failed.is_err(), "{failed:?}");
        assert!(stranded.is_empty(), "{stranded:?}");
        assert_eq!(read(root, DAILY), "# Today on this Mac\n");
        assert!(!root.join(DAILY_COPY).exists());
        assert_eq!(head_oid(root), head);
        assert_eq!(index_tree(root), head_tree(root));

        let merged = merge_remote(root, device.folders(), &[]).expect("the retry");
        assert_eq!(merged.displaced, vec![displaced(DAILY, DAILY_COPY)]);
        assert_eq!(read(root, DAILY), "# Today from the phone\n");
        assert_eq!(read(root, "assets/z.bin"), "zzz");
        device.assert_local_only_untouched();
    }
}

/// A tracked, public note edited after the cycle's commit is a save that
/// raced it: the pull defers with nothing written, and the engine's commit
/// and second pull merge it like any other edit.
#[test]
fn a_save_racing_the_cycle_commit_defers_instead_of_displacing() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        push_from_b(&device, &[("notes/a.md", "# A\n\nedited on the phone\n")]);
        write(root, "notes/a.md", "# A\n\nedited here just now\n");
        fetch(root, None).unwrap();
        let before = snapshot(root);

        let deferred = merge_remote(root, device.folders(), &[]).unwrap();
        assert!(matches!(deferred.kind, MergeKind::Deferred), "{deferred:?}");
        assert!(deferred.changed_files.is_empty() && deferred.displaced.is_empty());
        assert_eq!(snapshot(root), before);

        assert!(device.commit());
        let merged = merge_remote(root, device.folders(), &[]).unwrap();
        assert!(
            matches!(merged.kind, MergeKind::MergedWithConflicts),
            "{merged:?}"
        );
        assert!(merged.displaced.is_empty(), "{merged:?}");
        let content = read(root, "notes/a.md");
        assert!(content.contains("edited here just now"), "{content}");
        assert!(content.contains("edited on the phone"), "{content}");
    }
}

/// Git's clean filters decide whether a tracked note differs from the
/// index, as they decide what a commit records: under `core.autocrlf` a
/// CRLF note over an LF blob is unchanged, so the pull writes the other
/// device's edit rather than deferring every cycle while each commit finds
/// nothing to record.
#[test]
fn line_ending_filters_decide_what_counts_as_changed() {
    for autocrlf in ["input", "true"] {
        let device = Device::new(false);
        let root = device.root();
        Repository::open(root)
            .unwrap()
            .config()
            .unwrap()
            .set_str("core.autocrlf", autocrlf)
            .unwrap();
        write(root, "notes/crlf.md", "# CRLF\r\n\r\nline\r\n");
        assert!(device.commit());
        push(root, None, &[]).unwrap();
        assert_eq!(head_blob(root, "notes/crlf.md"), b"# CRLF\n\nline\n");
        push_from_b(
            &device,
            &[("notes/crlf.md", "# CRLF\n\nline\n\nfrom the phone\n")],
        );
        assert!(!device.commit(), "autocrlf={autocrlf}");

        let merged = device.pull();
        assert!(
            matches!(merged.kind, MergeKind::FastForward),
            "autocrlf={autocrlf}: {merged:?}"
        );
        assert!(merged.displaced.is_empty(), "{merged:?}");
        let expected = if autocrlf == "true" {
            "# CRLF\r\n\r\nline\r\n\r\nfrom the phone\r\n"
        } else {
            "# CRLF\n\nline\n\nfrom the phone\n"
        };
        assert_eq!(read(root, "notes/crlf.md"), expected);
        assert!(!device.commit(), "autocrlf={autocrlf}");
    }
}

/// The index version written back at a moved tracked note's path is known
/// for what it is when the pull fails, even though a smudge filter changed
/// its bytes on the way out (CRLF under `core.autocrlf=true`): the moved
/// note goes back instead of staying stranded in its copy.
#[test]
fn a_failed_pull_puts_a_tracked_note_back_under_line_ending_filters() {
    use std::os::unix::fs::PermissionsExt;
    let device = Device::new(false);
    let root = device.root();
    Repository::open(root)
        .unwrap()
        .config()
        .unwrap()
        .set_str("core.autocrlf", "true")
        .unwrap();
    write(root, "notes/plan.md", "# Plan\n");
    assert!(device.commit());
    push(root, None, &[]).unwrap();
    push_from_b(
        &device,
        &[
            ("assets/z.bin", "zzz"),
            ("notes/plan.md", "# Plan\n\nfrom the phone\n"),
        ],
    );
    write(root, "notes/plan.md", LOCKED);
    fetch(root, None).unwrap();
    let assets = root.join("assets");
    fail_the_checkout_in(assets.clone());

    let (failed, stranded) = pull(root, None, &[], MAX_FILE_BYTES);
    fs::set_permissions(&assets, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err(), "{failed:?}");
    assert!(stranded.is_empty(), "{stranded:?}");
    assert_eq!(read(root, "notes/plan.md"), LOCKED);
    assert!(!root.join("notes/plan (this device).md").exists());
}

/// The forced checkout of HEAD this replaced reverted every tracked file
/// that differed from HEAD, oversized edits the backup skips included. Now
/// an oversized edit the pull doesn't write stays, and one it does write
/// moves aside.
#[test]
fn ff_without_local_only_folders_keeps_untouched_oversized_edits() {
    const LIMIT: u64 = 16;
    let device = Device::new(false);
    let root = device.root();
    write(root, "assets/big.bin", "small at first");
    assert!(device.commit());
    push(root, None, &[]).unwrap();
    write(
        root,
        "assets/big.bin",
        "grown well past the size limit here",
    );
    let skipped = commit_all(root, "Update notes", LIMIT, None).unwrap();
    assert_eq!(skipped.skipped_large_files.len(), 1, "{skipped:?}");

    let root_b = push_from_b(&device, &[("notes/b.md", "# B\n")]);
    fetch(root, None).unwrap();
    let (merged, _) = pull(root, None, &[], LIMIT);
    let merged = merged.unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(
        read(root, "assets/big.bin"),
        "grown well past the size limit here"
    );
    assert!(merged.displaced.is_empty(), "{merged:?}");

    fetch(&root_b, None).unwrap();
    merge_remote(&root_b, None, &[]).unwrap();
    write(&root_b, "assets/big.bin", "the phone's version");
    commit_all(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push(&root_b, None, &[]).unwrap();
    fetch(root, None).unwrap();
    let (merged, _) = pull(root, None, &[], LIMIT);
    let merged = merged.unwrap();
    assert_eq!(read(root, "assets/big.bin"), "the phone's version");
    assert_eq!(
        read(root, "assets/big (this device).bin"),
        "grown well past the size limit here"
    );
    assert_eq!(
        merged.displaced,
        vec![DisplacedFile {
            tracked: true,
            ..displaced("assets/big.bin", "assets/big (this device).bin")
        }]
    );
}

/// The ref moves only after the working tree and the index: a failed index
/// write leaves HEAD where it was, the copy reported, and the retry clean.
#[test]
fn the_ref_moves_last() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        push_from_b(&device, &[(DAILY, "# Today from the phone\n")]);
        write(root, DAILY, "# Today on this Mac\n");
        fetch(root, None).unwrap();
        let head = head_oid(root);
        let lock = root.join(".git/index.lock");
        fs::write(&lock, b"").unwrap();

        let (failed, stranded) = pull(root, device.folders(), &[], MAX_FILE_BYTES);
        fs::remove_file(&lock).unwrap();
        assert!(failed.is_err(), "{failed:?}");
        assert_eq!(head_oid(root), head);
        assert_eq!(index_tree(root), head_tree(root));
        // The checkout wrote the incoming note, so the copy stays, reported.
        assert_eq!(stranded, vec![displaced(DAILY, DAILY_COPY)]);
        assert_eq!(read(root, DAILY), "# Today from the phone\n");
        assert_eq!(read(root, DAILY_COPY), "# Today on this Mac\n");

        let merged = merge_remote(root, device.folders(), &[]).expect("the retry");
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert!(merged.displaced.is_empty(), "{merged:?}");
        assert_eq!(head_oid(root), remote_main(&device.fixture));
        assert_eq!(parked_entries(root), Vec::<String>::new());
    }
}

/// A failed pull moves a tracked note back even after its own checkout
/// removed the index version written back at the path (the other device
/// deleted it): the path is free again, so nothing stays stranded.
#[test]
fn a_failed_pull_after_a_remote_delete_moves_the_note_back() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let root = device.root();
        write(root, "notes/plan.md", "# Plan\n");
        assert!(device.commit());
        push(root, None, &[]).unwrap();
        let root_b = second_device(&device.fixture);
        fs::remove_file(root_b.join("notes/plan.md")).unwrap();
        commit_all(&root_b, "b delete", MAX_FILE_BYTES, None).unwrap();
        push(&root_b, None, &[]).unwrap();
        write(root, "notes/plan.md", LOCKED);
        fetch(root, None).unwrap();
        let head = head_oid(root);
        let lock = root.join(".git/index.lock");
        fs::write(&lock, b"").unwrap();

        let (failed, stranded) = pull(root, device.folders(), &[], MAX_FILE_BYTES);
        fs::remove_file(&lock).unwrap();
        assert!(failed.is_err(), "{failed:?}");
        assert!(stranded.is_empty(), "configured={configured}: {stranded:?}");
        assert_eq!(read(root, "notes/plan.md"), LOCKED);
        assert!(!root.join("notes/plan (this device).md").exists());
        assert_eq!(head_oid(root), head);
        device.assert_local_only_untouched();
    }
}

/// A note created while a pull holds the write guard lands after the pull,
/// at a path the pull already wrote, so it reports a collision instead of
/// being overwritten by the checkout.
#[test]
fn a_note_create_landing_during_a_pull_is_never_overwritten() {
    use tauri::Manager;
    let device = Device::new(false);
    let root = device.root().to_path_buf();
    push_from_b(&device, &[("notes/new.md", "# From the phone\n")]);
    fetch(&root, None).unwrap();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    app.manage(crate::fs::GraphState::default());
    {
        let state: tauri::State<crate::fs::GraphState> = app.state();
        let mut inner = state.0.lock().unwrap();
        inner.generation = 1;
        inner.root = Some(root.clone());
    }
    let handle = app.handle().clone();
    let creator: Rc<RefCell<Option<std::thread::JoinHandle<_>>>> = Rc::new(RefCell::new(None));
    let slot = Rc::clone(&creator);
    super::super::merge::seam::AFTER_DISPLACEMENT.set(Some(Box::new(move || {
        let spawned = std::thread::spawn(move || {
            let state = handle.state::<crate::fs::GraphState>();
            tauri::async_runtime::block_on(crate::fs::note_create(
                "notes/new.md".to_string(),
                "# Created here\n".to_string(),
                1,
                state,
            ))
        });
        // Give the create every chance to land while the pull holds the
        // guard; without the guard it would, and the checkout would then
        // overwrite it.
        std::thread::sleep(std::time::Duration::from_millis(150));
        *slot.borrow_mut() = Some(spawned);
        Ok(())
    })));

    let merged = merge_remote(&root, None, &[]).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    let created = creator.borrow_mut().take().unwrap().join().unwrap();
    assert!(
        matches!(created, Ok(crate::fs::NoteCreateOutcome::Collision)),
        "{created:?}"
    );
    assert_eq!(read(&root, "notes/new.md"), "# From the phone\n");
}

#[test]
fn binary_conflict_copies_never_overwrite_an_existing_file() {
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
    fs::write(root_a.join("assets/img (conflict).bin"), b"precious").unwrap();
    fetch(root_a, None).unwrap();

    let merged = merge_remote(root_a, None, &[]).unwrap();
    assert!(
        matches!(merged.kind, MergeKind::MergedWithConflicts),
        "{merged:?}"
    );
    assert_eq!(
        fs::read(root_a.join("assets/img (conflict).bin")).unwrap(),
        b"precious"
    );
    assert_eq!(
        fs::read(root_a.join("assets/img (conflict 2).bin")).unwrap(),
        b"\x00from-b\x01"
    );
    assert_eq!(
        fs::read(root_a.join("assets/img.bin")).unwrap(),
        b"\x00from-a\x01"
    );
    assert!(merged
        .conflicted_paths
        .contains(&"assets/img (conflict 2).bin".to_string()));
}

/// A checked write in flight while its note moves aside: written first, its
/// bytes move with the note; written after, it is refused, so it never
/// clobbers the incoming file (the TS patch then re-reads and re-applies).
/// Both a Lock-style frontmatter patch and a capture drain's append.
#[test]
fn a_patch_in_flight_never_clobbers_a_displaced_note() {
    use tauri::Manager;
    let patches: [(&str, &str, &str); 2] = [
        (
            "notes/plan.md",
            "# Plan\n",
            "---\nprivate: true\n---\n# Plan\n",
        ),
        (DAILY, "# Today\n", "# Today\n\n- captured\n"),
    ];
    for (path, read_before, patched) in patches {
        for patch_first in [true, false] {
            let device = Device::new(false);
            let root = device.root().to_path_buf();
            push_from_b(&device, &[(path, "# From the phone\n")]);
            write(&root, path, read_before);
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("mock app");
            app.manage(crate::fs::GraphState::default());
            {
                let state: tauri::State<crate::fs::GraphState> = app.state();
                let mut inner = state.0.lock().unwrap();
                inner.generation = 1;
                inner.root = Some(root.clone());
            }
            let write_patch = || {
                tauri::async_runtime::block_on(crate::fs::note_write(
                    path.to_string(),
                    patched.to_string(),
                    1,
                    Some(true),
                    Some(read_before.to_string()),
                    app.state(),
                ))
            };
            let copy = path.replace(".md", " (this device).md");
            if patch_first {
                write_patch().unwrap();
                let merged = device.pull();
                assert_eq!(read(&root, &copy), patched, "{merged:?}");
                assert_eq!(merged.displaced.len(), 1, "{merged:?}");
                assert_eq!(merged.displaced[0].kept_out, patched.contains("private"));
            } else {
                let merged = device.pull();
                assert_eq!(merged.displaced.len(), 1, "{merged:?}");
                let refused = write_patch().unwrap_err();
                assert!(
                    format!("{refused:?}").contains("changed on disk"),
                    "{refused:?}"
                );
                assert_eq!(read(&root, &copy), read_before);
            }
            assert_eq!(read(&root, path), "# From the phone\n");
        }
    }
}

/// Command tier: `git_merge_remote` announces every entry left displaced on
/// `note:displaced`, after a pull that landed and after one that failed.
#[test]
fn the_merge_command_announces_displaced_notes_on_both_outcomes() {
    use tauri::{Listener, Manager};
    for fail in [false, true] {
        let device = Device::new(false);
        let root = device.root().to_path_buf();
        push_from_b(&device, &[(DAILY, "# Today from the phone\n")]);
        write(&root, DAILY, "# Today on this Mac\n");
        fetch(&root, None).unwrap();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(crate::fs::GraphState::default());
        {
            let state: tauri::State<crate::fs::GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(root.clone());
        }
        let announced: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        let sink = Arc::clone(&announced);
        app.listen_any("note:displaced", move |event| {
            sink.lock()
                .unwrap()
                .push(serde_json::from_str(event.payload()).unwrap());
        });
        let lock = root.join(".git/index.lock");
        if fail {
            fs::write(&lock, b"").unwrap();
        }
        let merged = tauri::async_runtime::block_on(super::super::git_merge_remote(
            1,
            app.handle().clone(),
            app.state(),
        ));
        if fail {
            fs::remove_file(&lock).unwrap();
            assert!(merged.is_err(), "{merged:?}");
        } else {
            let merged = merged.unwrap();
            assert_eq!(merged.displaced, vec![displaced(DAILY, DAILY_COPY)]);
        }
        assert_eq!(
            *announced.lock().unwrap(),
            vec![serde_json::json!({
                "generation": 1,
                "from": DAILY,
                "to": DAILY_COPY,
                "keptOut": false,
            })],
            "fail={fail}"
        );
    }
}

#[test]
fn a_merge_finishing_after_a_graph_switch_never_announces_into_the_new_session() {
    use std::future::Future;
    use std::task::Poll;
    use tauri::{Listener, Manager};

    let device = Device::new(false);
    let root = device.root().to_path_buf();
    push_from_b(&device, &[(DAILY, "# Today from the phone\n")]);
    write(&root, DAILY, "# Today on this Mac\n");
    fetch(&root, None).unwrap();
    let next_root = device.fixture._dir.path().join("next-graph");
    write(&next_root, DAILY, "# Next graph's same-path note\n");
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    app.manage(crate::fs::GraphState::default());
    {
        let state: tauri::State<crate::fs::GraphState> = app.state();
        let mut inner = state.0.lock().unwrap();
        inner.generation = 1;
        inner.root = Some(root.clone());
    }
    let announced: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
    let sink = Arc::clone(&announced);
    app.listen_any("note:displaced", move |event| {
        sink.lock()
            .unwrap()
            .push(serde_json::from_str(event.payload()).unwrap());
    });

    let guard = crate::fs::note_write_guard();
    let mut command = Box::pin(super::super::git_merge_remote(
        1,
        app.handle().clone(),
        app.state(),
    ));
    let merged = tauri::async_runtime::block_on(async {
        // Poll through the command's generation check; its blocking merge
        // cannot finish while this thread holds the note-write guard.
        std::future::poll_fn(|context| {
            assert!(command.as_mut().poll(context).is_pending());
            Poll::Ready(())
        })
        .await;
        {
            let state: tauri::State<crate::fs::GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 2;
            inner.root = Some(next_root.clone());
        }
        drop(guard);
        command.await
    });

    let error = merged.unwrap_err();
    assert!(format!("{error:?}").contains("graph changed"), "{error:?}");
    assert!(announced.lock().unwrap().is_empty());
    assert_eq!(read(&root, DAILY), "# Today from the phone\n");
    assert_eq!(read(&root, DAILY_COPY), "# Today on this Mac\n");
    assert_eq!(read(&next_root, DAILY), "# Next graph's same-path note\n");
    assert!(!next_root.join(DAILY_COPY).exists());
}
