//! Pull safety (see `displace`): a pull never overwrites bytes that were
//! never committed. It moves them to `name (this device).ext`, defers when a
//! save raced the cycle's commit, pauses on a path it must not write, and
//! puts everything back when it fails. Collisions run without and with
//! local-only folders on device A.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use reflect_graph_paths::LocalOnlyFolders;

use super::super::displace::DisplacedFile;
use super::super::merge::{MergeOutcome, merge_remote_displacing, seam};
use super::guards::{
    Device, FILE, assert_no_merge_state, commit_index_edits, commit_with, head_blob_bytes,
    head_oid, head_tree, index_tree, is_symlink, paused_message, push_from_b, push_with,
    remote_main, snapshot,
};
use super::*;

const DAILY: &str = "daily/2026-10-04.md";
const DAILY_COPY: &str = "daily/2026-10-04 (this device).md";
const LOCKED: &str = "---\nprivate: true\n---\n# Plan\n\nonly on this Mac\n";

/// Merge the fetched remote branch with `folders` at `max_file_bytes`, with
/// no commit first (the cycle's commit already ran), returning every entry
/// the pull left moved, on success and on failure alike.
fn pull(
    root: &Path,
    folders: Option<&LocalOnlyFolders>,
    max_file_bytes: u64,
) -> (AppResult<MergeOutcome>, Vec<DisplacedFile>) {
    let policy = PullPolicy {
        local_only: folders,
        accepted_roots: &[],
        max_file_bytes,
    };
    merge_remote_displacing(root, &policy)
}

/// [`pull`] at the default size limit, without the stranded entries.
fn pull_from(root: &Path, folders: Option<&LocalOnlyFolders>) -> AppResult<MergeOutcome> {
    pull(root, folders, MAX_FILE_BYTES).0
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
        assert!(push_with(root, None, &[]).unwrap().pushed);
    }
}

/// An unborn HEAD adopts the remote's history; its untracked entries in the
/// way move aside instead of failing the checkout. The scaffold's own
/// `.gitignore` gives way to the incoming one like any hidden file.
#[test]
fn an_unborn_repo_pull_displaces_untracked_notes() {
    for configured in [false, true] {
        let device = Device::new(configured);
        let fresh = device.fixture._dir.path().join("fresh");
        scaffold_graph(&fresh);
        setup(&fresh, Some(device.fixture.remote_url.clone()), None).unwrap();
        write(&fresh, "notes/a.md", "# A written here first\n");
        fetch(&fresh, None).unwrap();

        let merged = pull_from(&fresh, device.folders()).unwrap();
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
        assert_eq!(parked_entries(&fresh), Vec::<String>::new());
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
        push_with(root, None, &[]).unwrap();
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
            head_blob_bytes(root, "notes/plan.md"),
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
        push_with(root, None, &[]).unwrap();
        let root_b = second_device(&device.fixture);
        fs::remove_file(root_b.join("notes/plan.md")).unwrap();
        commit_with(&root_b, "b delete", MAX_FILE_BYTES, None).unwrap();
        push_with(&root_b, None, &[]).unwrap();
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

/// The production cycle: `pull_all` commits first, and the bytes its commit
/// withholds (an edit at or above the size limit) move aside when the other
/// device changed the file, instead of being overwritten or kept in the
/// incoming file's way.
#[test]
fn pull_all_moves_a_withheld_oversized_edit_aside() {
    const LIMIT: u64 = 16;
    let device = Device::new(false);
    let root = device.root();
    write(root, "assets/big.bin", "small at first");
    assert!(device.commit());
    push_with(root, None, &[]).unwrap();
    push_from_b(&device, &[("assets/big.bin", "the phone's version")]);
    write(
        root,
        "assets/big.bin",
        "grown well past the size limit here",
    );
    fetch(root, None).unwrap();

    let policy = PullPolicy {
        max_file_bytes: LIMIT,
        ..PullPolicy::default()
    };
    let mut announced = Vec::new();
    let pulled = super::super::pull_all(root, "Update notes", &policy, &mut announced).unwrap();
    assert_eq!(pulled.skipped_large_files.len(), 1, "{pulled:?}");
    assert!(matches!(pulled.kind, MergeKind::FastForward), "{pulled:?}");
    assert_eq!(read(root, "assets/big.bin"), "the phone's version");
    assert_eq!(
        read(root, "assets/big (this device).bin"),
        "grown well past the size limit here"
    );
    let expected = vec![DisplacedFile {
        tracked: true,
        ..displaced("assets/big.bin", "assets/big (this device).bin")
    }];
    assert_eq!(pulled.displaced, expected);
    assert_eq!(announced, expected);
    assert!(
        pulled
            .changed_files
            .iter()
            .any(|change| change.path == "assets/big (this device).bin")
    );
}

// ---- paths and identity ------------------------------------------------------

/// The trackedness lookup leans on this: under `core.ignorecase` the index
/// finds an entry by any case of its path.
#[test]
fn the_index_folds_case_under_core_ignorecase() {
    let fixture = fixture();
    let root = &fixture.graph_a;
    write(root, "notes/Plan.md", "# Plan\n");
    commit_all(root, "base", MAX_FILE_BYTES).unwrap();
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
    push_with(&root_b, None, &[]).unwrap();
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
    push_with(&root_b, None, &[]).unwrap();
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

        let merged = pull_from(root, device.folders());
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
    push_with(root, None, &[]).unwrap();
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
    push_with(&root_b, None, &[]).unwrap();
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
        push_with(root, None, &[]).unwrap();
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
        push_with(&root_b, None, &[]).unwrap();
        write(root, "notes/.DS_Store", "finder junk");

        let merged = device.pull();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert!(merged.displaced.is_empty(), "{merged:?}");
        assert_eq!(read(root, "notes/.DS_Store"), "phone junk");
        assert!(!root.join("notes/.DS_Store (this device)").exists());
        assert_eq!(read(root, "notes/b.md"), "# B\n");
        assert_eq!(parked_entries(root), Vec::<String>::new());
        device.assert_local_only_untouched();
    }
}

/// Only a plain hidden file at the path written gives way. A hidden link
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
            push_with(&root_b, None, &[]).unwrap();
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

            let paused = pull_from(root, device.folders()).unwrap_err();
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

/// An untracked hidden plain file the other device writes over gives way
/// (the incoming file takes the path), and comes back if the pull fails.
#[test]
fn an_untracked_hidden_file_gives_way_to_the_incoming_one() {
    let device = Device::new(false);
    let root = device.root();
    let root_b = second_device(&device.fixture);
    commit_index_edits(
        &root_b,
        &[("notes/.cfg", Some((b"from the phone\n", FILE)))],
    );
    push_with(&root_b, None, &[]).unwrap();
    write(root, "notes/.cfg", "hidden, never backed up\n");

    let merged = device.pull();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert!(merged.displaced.is_empty(), "{merged:?}");
    assert_eq!(read(root, "notes/.cfg"), "from the phone\n");
    assert_eq!(parked_entries(root), Vec::<String>::new());
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
        push_with(&root_b, None, &[]).unwrap();
        write(root, "notes/sub/a.md", "# Not backed up yet\n");
        fs::create_dir_all(root.join("notes/empty")).unwrap();
        fetch(root, None).unwrap();
        let before = snapshot(root);

        let message = paused_message(pull_from(root, device.folders()).unwrap_err());
        assert!(message.contains("\"notes/sub\""), "{message}");
        assert_eq!(snapshot(root), before, "configured={configured}");
        assert_eq!(read(root, "notes/sub/a.md"), "# Not backed up yet\n");

        // Once the folder is out of the way, the empty one gives way too.
        fs::rename(root.join("notes/sub"), root.join("notes/sub-folder")).unwrap();
        let merged = pull_from(root, device.folders()).unwrap();
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
    seam::AFTER_DISPLACEMENT.set(Some(Box::new(move || {
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

        let (failed, stranded) = pull(root, device.folders(), MAX_FILE_BYTES);
        fs::set_permissions(&assets, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(failed.is_err(), "{failed:?}");
        assert!(stranded.is_empty(), "{stranded:?}");
        assert_eq!(read(root, DAILY), "# Today on this Mac\n");
        assert!(!root.join(DAILY_COPY).exists());
        assert_eq!(head_oid(root), head);
        assert_eq!(index_tree(root), head_tree(root));

        let merged = pull_from(root, device.folders()).expect("the retry");
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

        let deferred = pull_from(root, device.folders()).unwrap();
        assert!(matches!(deferred.kind, MergeKind::Deferred), "{deferred:?}");
        assert!(deferred.changed_files.is_empty() && deferred.displaced.is_empty());
        assert_eq!(snapshot(root), before);

        assert!(device.commit());
        let merged = pull_from(root, device.folders()).unwrap();
        assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
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
        push_with(root, None, &[]).unwrap();
        assert_eq!(head_blob_bytes(root, "notes/crlf.md"), b"# CRLF\n\nline\n");
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
    push_with(root, None, &[]).unwrap();
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

    let (failed, stranded) = pull(root, None, MAX_FILE_BYTES);
    fs::set_permissions(&assets, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(failed.is_err(), "{failed:?}");
    assert!(stranded.is_empty(), "{stranded:?}");
    assert_eq!(read(root, "notes/plan.md"), LOCKED);
    assert!(!root.join("notes/plan (this device).md").exists());
}

/// A forced checkout of HEAD reverted every tracked file that differed from
/// HEAD, oversized edits the backup skips included. An oversized edit the
/// pull doesn't write stays, and one it does write moves aside.
#[test]
fn ff_without_local_only_folders_keeps_untouched_oversized_edits() {
    const LIMIT: u64 = 16;
    let device = Device::new(false);
    let root = device.root();
    write(root, "assets/big.bin", "small at first");
    assert!(device.commit());
    push_with(root, None, &[]).unwrap();
    write(
        root,
        "assets/big.bin",
        "grown well past the size limit here",
    );
    let skipped = commit_with(root, "Update notes", LIMIT, None).unwrap();
    assert_eq!(skipped.skipped_large_files.len(), 1, "{skipped:?}");

    let root_b = push_from_b(&device, &[("notes/b.md", "# B\n")]);
    fetch(root, None).unwrap();
    let (merged, _) = pull(root, None, LIMIT);
    let merged = merged.unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    assert_eq!(
        read(root, "assets/big.bin"),
        "grown well past the size limit here"
    );
    assert!(merged.displaced.is_empty(), "{merged:?}");

    fetch(&root_b, None).unwrap();
    pull_from(&root_b, None).unwrap();
    write(&root_b, "assets/big.bin", "the phone's version");
    commit_with(&root_b, "b edit", MAX_FILE_BYTES, None).unwrap();
    push_with(&root_b, None, &[]).unwrap();
    fetch(root, None).unwrap();
    let (merged, _) = pull(root, None, LIMIT);
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

/// A fast-forward records the stat of every file it checks out: left zero,
/// each later commit would re-read and re-hash every pulled file,
/// attachments included.
#[test]
fn a_fast_forward_records_the_stat_of_what_it_checks_out() {
    use std::os::unix::fs::MetadataExt;
    let device = Device::new(false);
    let root = device.root();
    push_from_b(
        &device,
        &[("notes/b.md", "# B\n"), ("assets/pic.bin", "pixels")],
    );
    let merged = device.pull();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    let index = Repository::open(root).unwrap().index().unwrap();
    for path in ["notes/b.md", "assets/pic.bin"] {
        let entry = index.get_path(Path::new(path), 0).unwrap();
        let meta = fs::symlink_metadata(root.join(path)).unwrap();
        assert_eq!(u64::from(entry.file_size), meta.len(), "{path}");
        assert_eq!(i64::from(entry.mtime.seconds()), meta.mtime(), "{path}");
        assert_eq!(
            u64::from(entry.ino),
            meta.ino() & u64::from(u32::MAX),
            "{path}"
        );
    }
    assert_eq!(index_tree(root), head_tree(root));
    assert!(!device.commit());
}

/// A hidden path is no exception for bytes Git never got: a tracked hidden
/// file whose oversized edit the commit withheld moves aside when the other
/// device edits or deletes it, instead of the checkout replacing it.
#[test]
fn a_tracked_hidden_files_withheld_edit_moves_aside() {
    const LIMIT: u64 = 16;
    const CLIP: &str = ".attachments/clip.bin";
    const CLIP_COPY: &str = ".attachments/clip (this device).bin";
    const LOCAL: &str = "grown well past the size limit here";
    let edited: &[u8] = b"the phone's version";
    for remote in [Some(edited), None] {
        let device = Device::new(false);
        let root = device.root();
        write(root, CLIP, "small at first");
        assert!(device.commit());
        push_with(root, None, &[]).unwrap();
        write(root, CLIP, LOCAL);
        let skipped = commit_with(root, "Update notes", LIMIT, None).unwrap();
        assert_eq!(skipped.skipped_large_files.len(), 1, "{skipped:?}");

        let root_b = second_device(&device.fixture);
        commit_index_edits(&root_b, &[(CLIP, remote.map(|bytes| (bytes, FILE)))]);
        push_with(&root_b, None, &[]).unwrap();
        fetch(root, None).unwrap();
        let (merged, _) = pull(root, None, LIMIT);
        let merged = merged.unwrap();
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert_eq!(read(root, CLIP_COPY), LOCAL);
        match remote {
            Some(bytes) => assert_eq!(fs::read(root.join(CLIP)).unwrap(), bytes),
            None => assert!(!root.join(CLIP).exists()),
        }
        assert_eq!(
            merged.displaced,
            vec![DisplacedFile {
                tracked: true,
                ..displaced(CLIP, CLIP_COPY)
            }]
        );
    }
}

/// The ref moves only after the working tree and the index: a failed
/// checkout leaves HEAD where it was, every copy back or reported, and the
/// retry clean.
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

        let (failed, stranded) = pull(root, device.folders(), MAX_FILE_BYTES);
        fs::remove_file(&lock).unwrap();
        assert!(failed.is_err(), "{failed:?}");
        assert_eq!(head_oid(root), head);
        assert_eq!(index_tree(root), head_tree(root));
        // Whatever the checkout wrote before it failed, this device's note is
        // either back at its path or kept in its copy, reported.
        if stranded.is_empty() {
            assert_eq!(read(root, DAILY), "# Today on this Mac\n");
            assert!(!root.join(DAILY_COPY).exists());
        } else {
            assert_eq!(stranded, vec![displaced(DAILY, DAILY_COPY)]);
            assert_eq!(read(root, DAILY), "# Today from the phone\n");
            assert_eq!(read(root, DAILY_COPY), "# Today on this Mac\n");
        }

        let merged = pull_from(root, device.folders()).expect("the retry");
        assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
        assert_eq!(head_oid(root), remote_main(&device.fixture));
        assert_eq!(read(root, DAILY), "# Today from the phone\n");
        assert_eq!(read(root, DAILY_COPY), "# Today on this Mac\n");
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
        push_with(root, None, &[]).unwrap();
        let root_b = second_device(&device.fixture);
        fs::remove_file(root_b.join("notes/plan.md")).unwrap();
        commit_with(&root_b, "b delete", MAX_FILE_BYTES, None).unwrap();
        push_with(&root_b, None, &[]).unwrap();
        write(root, "notes/plan.md", LOCKED);
        fetch(root, None).unwrap();
        let head = head_oid(root);
        let lock = root.join(".git/index.lock");
        fs::write(&lock, b"").unwrap();

        let (failed, stranded) = pull(root, device.folders(), MAX_FILE_BYTES);
        fs::remove_file(&lock).unwrap();
        assert!(failed.is_err(), "{failed:?}");
        assert!(stranded.is_empty(), "configured={configured}: {stranded:?}");
        assert_eq!(read(root, "notes/plan.md"), LOCKED);
        assert!(!root.join("notes/plan (this device).md").exists());
        assert_eq!(head_oid(root), head);
        device.assert_local_only_untouched();
    }
}

/// A note created while a pull holds the graph lock lands after the pull, at
/// a path the pull already wrote, so it reports a collision instead of being
/// overwritten by the checkout.
#[test]
fn a_note_create_landing_during_a_pull_is_never_overwritten() {
    let device = Device::new(false);
    let root = device.root().to_path_buf();
    push_from_b(&device, &[("notes/new.md", "# From the phone\n")]);
    fetch(&root, None).unwrap();
    type Created = std::thread::JoinHandle<AppResult<reflect_graph_io::NoteCreateOutcome>>;
    let creator: Rc<RefCell<Option<Created>>> = Rc::new(RefCell::new(None));
    let slot = Rc::clone(&creator);
    let graph = root.clone();
    seam::AFTER_DISPLACEMENT.set(Some(Box::new(move || {
        let spawned = std::thread::spawn(move || {
            reflect_graph_io::create_note(&graph, "notes/new.md", "# Created here\n", None, || {
                Ok(())
            })
        });
        // Give the create every chance to land while the pull holds the
        // lock; without the lock it would, and the checkout would then
        // overwrite it.
        std::thread::sleep(std::time::Duration::from_millis(150));
        *slot.borrow_mut() = Some(spawned);
        Ok(())
    })));

    let merged = pull_from(&root, None).unwrap();
    assert!(matches!(merged.kind, MergeKind::FastForward), "{merged:?}");
    let created = creator.borrow_mut().take().unwrap().join().unwrap();
    assert!(
        matches!(created, Ok(reflect_graph_io::NoteCreateOutcome::Collision)),
        "{created:?}"
    );
    assert_eq!(read(&root, "notes/new.md"), "# From the phone\n");
}

/// A binary conflict copy never takes a name a file already holds: with the
/// copy's first name taken on disk, the other device's version lands at the
/// next free one.
#[test]
fn binary_conflict_copies_never_overwrite_an_existing_file() {
    let fixture = fixture();
    let root_a = &fixture.graph_a;
    fs::write(root_a.join("assets/img.bin"), b"\x00base\x01").unwrap();
    commit_all(root_a, "base", MAX_FILE_BYTES).unwrap();
    push(root_a, None).unwrap();
    let root_b = second_device(&fixture);
    fs::write(root_b.join("assets/img.bin"), b"\x00from-b\x01").unwrap();
    commit_all(&root_b, "b image", MAX_FILE_BYTES).unwrap();
    push(&root_b, None).unwrap();
    fs::write(root_a.join("assets/img.bin"), b"\x00from-a\x01").unwrap();
    commit_all(root_a, "a image", MAX_FILE_BYTES).unwrap();
    fetch(root_a, None).unwrap();
    let theirs = {
        let repo = Repository::open(root_a).unwrap();
        let remote = repo
            .find_reference("refs/remotes/origin/main")
            .unwrap()
            .peel_to_commit()
            .unwrap();
        let blob = remote
            .tree()
            .unwrap()
            .get_path(Path::new("assets/img.bin"))
            .unwrap()
            .id();
        (remote.time().seconds(), blob.to_string())
    };
    let first = reflect_graph_io::conflict::copy::free_conflict_copy_path(
        "assets/img.bin",
        &reflect_graph_io::conflict::copy::utc_stamp(theirs.0),
        &theirs.1[..8],
        |_| false,
    );
    fs::write(root_a.join(&first), b"precious").unwrap();

    let merged = pull_from(root_a, None).unwrap();
    assert!(matches!(merged.kind, MergeKind::Merged), "{merged:?}");
    assert_eq!(fs::read(root_a.join(&first)).unwrap(), b"precious");
    assert_eq!(
        fs::read(root_a.join("assets/img.bin")).unwrap(),
        b"\x00from-a\x01"
    );
    let copy = merged
        .review_paths
        .iter()
        .find(|path| path.starts_with("assets/img (conflict"))
        .expect("a conflict copy");
    assert_ne!(copy, &first);
    assert_eq!(fs::read(root_a.join(copy)).unwrap(), b"\x00from-b\x01");
}

/// A checked write in flight while its note moves aside: written first, its
/// bytes move with the note; written after, it merges with the incoming file
/// the checkout put at the path, so it never clobbers it (the copy keeps the
/// version the writer read). Both a Lock-style frontmatter patch and a
/// capture drain's append.
#[test]
fn a_patch_in_flight_never_clobbers_a_displaced_note() {
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
            let write_patch = || {
                reflect_graph_io::write_note_revision(
                    &root,
                    path,
                    patched,
                    Some(read_before),
                    None,
                    || Ok(()),
                )
            };
            let copy = path.replace(".md", " (this device).md");
            if patch_first {
                write_patch().unwrap();
                let merged = device.pull();
                assert_eq!(read(&root, &copy), patched, "{merged:?}");
                assert_eq!(merged.displaced.len(), 1, "{merged:?}");
                assert_eq!(merged.displaced[0].kept_out, patched.contains("private"));
                assert_eq!(read(&root, path), "# From the phone\n");
            } else {
                let merged = device.pull();
                assert_eq!(merged.displaced.len(), 1, "{merged:?}");
                let landed = write_patch().unwrap().merged.expect("merged");
                assert!(landed.contains("From the phone"), "{landed}");
                assert_eq!(read(&root, path), landed);
                assert_eq!(read(&root, &copy), read_before);
            }
        }
    }
}

// ---- the displaced revision guard --------------------------------------------

const GROWN: &str = "# A\n\nedited here, past the size limit\n";
const FROM_THE_PHONE: &str = "# A\n\nedited on the phone\n";
const A_COPY: &str = "notes/a (this device).md";
const SIZE_LIMIT: u64 = 16;

/// `pull_all` with a 16-byte size limit, as the production cycle runs it.
fn pull_all_limited(root: &Path) -> super::super::PullOutcome {
    let policy = PullPolicy {
        max_file_bytes: SIZE_LIMIT,
        ..PullPolicy::default()
    };
    super::super::pull_all(root, "Update notes", &policy, &mut Vec::new()).unwrap()
}

/// A device whose `notes/a.md` grew past the size limit after its last
/// backup, while the other device edited it: the pull's commit withholds
/// the local edit, so the pull moves it to `notes/a (this device).md`.
fn displaced_note() -> Device {
    let device = Device::new(false);
    let root = device.root();
    push_from_b(&device, &[("notes/a.md", FROM_THE_PHONE)]);
    write(root, "notes/a.md", GROWN);
    fetch(root, None).unwrap();
    let pulled = pull_all_limited(root);
    assert_eq!(
        pulled.displaced,
        vec![DisplacedFile {
            tracked: true,
            ..displaced("notes/a.md", A_COPY)
        }]
    );
    device
}

/// A checked save, as an open editor makes it.
fn save(
    root: &Path,
    path: &str,
    contents: &str,
    expected: &str,
) -> AppResult<reflect_graph_io::NoteWriteOutcome> {
    reflect_graph_io::write_note_revision(root, path, contents, Some(expected), None, || Ok(()))
}

/// An editor still holding the displaced revision saves at the old path:
/// refused, so its edits follow the copy instead of merging into the
/// incoming note, which stays as the other device wrote it.
#[test]
fn a_save_naming_the_displaced_revision_is_refused() {
    let device = displaced_note();
    let root = device.root();
    let refused = save(root, "notes/a.md", "# A\n\nedited here, and more\n", GROWN).unwrap_err();
    assert_eq!(refused.message(), reflect_graph_io::CHANGED_ON_DISK);
    assert_eq!(read(root, "notes/a.md"), FROM_THE_PHONE);
    assert_eq!(read(root, A_COPY), GROWN);
}

/// A save naming the incoming revision lands; one naming another stale
/// revision merges, as any checked write does.
#[test]
fn a_save_naming_another_revision_lands_or_merges() {
    let device = displaced_note();
    let root = device.root();
    let edited = "# A\n\nedited on the phone, then here\n";
    let landed = save(root, "notes/a.md", edited, FROM_THE_PHONE).unwrap();
    assert_eq!(landed.merged, None);
    assert_eq!(read(root, "notes/a.md"), edited);

    let merged = save(root, "notes/a.md", "# A\n\nlater here\n", FROM_THE_PHONE)
        .unwrap()
        .merged
        .expect("a stale revision merges");
    assert_eq!(read(root, "notes/a.md"), merged);
}

/// The editor that followed the copy saves there, checked against the same
/// revision, and lands.
#[test]
fn a_save_to_the_copy_naming_the_displaced_revision_lands() {
    let device = displaced_note();
    let root = device.root();
    let edited = "# A\n\nedited here, and more\n";
    let landed = save(root, A_COPY, edited, GROWN).unwrap();
    assert_eq!(landed.merged, None);
    assert_eq!(read(root, A_COPY), edited);
    assert_eq!(read(root, "notes/a.md"), FROM_THE_PHONE);
}

/// A retry after a stale lock passes the earlier attempt's moves back in:
/// they stay recorded although the retry moved nothing, and an entry whose
/// copy is gone is left out.
#[test]
fn a_retry_keeps_the_earlier_attempts_moves_recorded() {
    let device = displaced_note();
    let root = device.root();
    let earlier = vec![
        DisplacedFile {
            tracked: true,
            ..displaced("notes/a.md", A_COPY)
        },
        displaced("notes/gone.md", "notes/gone (this device).md"),
    ];
    let policy = PullPolicy {
        max_file_bytes: SIZE_LIMIT,
        ..PullPolicy::default()
    };
    let mut moved = earlier.clone();
    let again = super::super::pull_all(root, "Update notes", &policy, &mut moved).unwrap();
    assert!(again.displaced.is_empty(), "{again:?}");
    assert_eq!(moved, earlier);
    let refused = save(root, "notes/a.md", "# A\n\nedited here, and more\n", GROWN).unwrap_err();
    assert_eq!(refused.message(), reflect_graph_io::CHANGED_ON_DISK);
    assert_eq!(read(root, "notes/a.md"), FROM_THE_PHONE);
}

/// The next pull that moves nothing clears the record: the same save then
/// merges like any stale one.
#[test]
fn the_next_pull_that_moves_nothing_clears_the_record() {
    let device = displaced_note();
    let root = device.root();
    let again = pull_all_limited(root);
    assert!(again.displaced.is_empty(), "{again:?}");
    let merged = save(root, "notes/a.md", "# A\n\nedited here, and more\n", GROWN)
        .unwrap()
        .merged
        .expect("merged once the record is gone");
    assert_eq!(read(root, "notes/a.md"), merged);
}
