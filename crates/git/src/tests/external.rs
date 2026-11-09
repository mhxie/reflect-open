//! Links into a graph's external storage (`ExternalLinks`): a commit never
//! stages one, even while the folder is unmounted or known only by another
//! spelling, drops one an earlier commit took, and a pull that writes a
//! file at a linked path parks the link instead of keeping it as a copy.

use std::os::unix::fs::symlink;

use reflect_graph_paths::ExternalLinks;

use super::super::merge::merge_remote_with;
use super::guards::{Device, is_symlink, push_from_b, push_with};
use super::*;

const BIG: &str = "research/big.pdf";

/// An external folder beside the device's graph holding `BIG`, and a link
/// to it at `BIG` in the graph.
fn linked_folder(device: &Device) -> PathBuf {
    let external = device.root().parent().unwrap().join("ext");
    write(&external, BIG, "external bytes");
    fs::create_dir_all(device.root().join("research")).unwrap();
    symlink(external.join(BIG), device.root().join(BIG)).unwrap();
    external
}

fn commit(root: &Path, links: Option<&ExternalLinks>) -> CommitOutcome {
    let policy = super::super::CommitPolicy {
        external: links,
        ..super::super::CommitPolicy::default()
    };
    super::super::commit_all(root, "Update notes", &policy).unwrap()
}

#[test]
fn links_into_external_storage_are_never_committed() {
    let device = Device::new(false);
    let root = device.root();
    let external = linked_folder(&device);
    let links = ExternalLinks::new([external.clone()]).unwrap();
    write(root, "research/notes.md", "# Notes\n");
    // A link anywhere else is committed as it always was.
    let elsewhere = root.parent().unwrap().join("elsewhere.pdf");
    write(root.parent().unwrap(), "elsewhere.pdf", "pdf");
    symlink(&elsewhere, root.join("research/other.pdf")).unwrap();

    let outcome = commit(root, Some(&links));
    assert!(outcome.committed);
    assert!(outcome.skipped_large_files.is_empty());
    let paths = head_tree_paths(root);
    assert!(
        paths.contains(&"research/notes.md".to_string()),
        "{paths:?}"
    );
    assert!(
        paths.contains(&"research/other.pdf".to_string()),
        "{paths:?}"
    );
    assert!(!paths.contains(&BIG.to_string()), "{paths:?}");

    // Unmounted, and known only by the spelling the link uses.
    fs::rename(&external, root.parent().unwrap().join("ext-away")).unwrap();
    write(root, "research/more.md", "# More\n");
    let alias = ExternalLinks::new([PathBuf::from("/elsewhere/alias"), external]).unwrap();
    assert!(commit(root, Some(&alias)).committed);
    assert!(!head_tree_paths(root).contains(&BIG.to_string()));

    // Only the links keep it out.
    assert!(commit(root, None).committed);
    assert!(head_tree_paths(root).contains(&BIG.to_string()));
}

#[test]
fn a_link_an_earlier_commit_took_leaves_the_next_one() {
    let device = Device::new(false);
    let root = device.root();
    let external = linked_folder(&device);
    // Committed before the folder was configured.
    assert!(commit(root, None).committed);
    assert!(head_tree_paths(root).contains(&BIG.to_string()));

    let links = ExternalLinks::new([external]).unwrap();
    assert!(commit(root, Some(&links)).committed);
    assert!(!head_tree_paths(root).contains(&BIG.to_string()));
    assert!(is_symlink(&root.join(BIG)), "the link itself stays");
    // And stays out.
    write(root, "research/notes.md", "# Notes\n");
    assert!(commit(root, Some(&links)).committed);
    assert!(!head_tree_paths(root).contains(&BIG.to_string()));
}

#[test]
fn a_pull_writing_a_linked_path_parks_the_link() {
    let device = Device::new(false);
    let root = device.root();
    let external = linked_folder(&device);
    let links = ExternalLinks::new([external.clone()]).unwrap();
    commit(root, Some(&links));
    push_with(root, None, &[]).unwrap();
    push_from_b(&device, &[(BIG, "from the other device")]);

    fetch(root, None).unwrap();
    let policy = PullPolicy {
        external: Some(&links),
        ..PullPolicy::default()
    };
    let merged = merge_remote_with(root, &policy).unwrap();
    assert!(merged.displaced.is_empty(), "{merged:?}");
    assert!(!is_symlink(&root.join(BIG)));
    assert_eq!(read(root, BIG), "from the other device");
    assert!(!root.join("research/big (this device).pdf").exists());
    // The folder keeps its copy.
    assert_eq!(read(&external, BIG), "external bytes");
}

#[test]
fn a_recorded_parent_of_the_graph_never_drops_its_own_links() {
    let device = Device::new(false);
    let root = device.root();
    write(root, "notes/target.md", "# Target\n");
    symlink("target.md", root.join("notes/alias.md")).unwrap();
    assert!(commit(root, None).committed);

    let parent = root.parent().unwrap();
    let around =
        ExternalLinks::new([parent.to_path_buf(), parent.canonicalize().unwrap()]).unwrap();
    write(root, "notes/other.md", "# Other\n");
    assert!(commit(root, Some(&around)).committed);
    let paths = head_tree_paths(root);
    assert!(paths.contains(&"notes/alias.md".to_string()), "{paths:?}");
}

#[test]
fn a_committed_link_in_a_local_only_folder_stays_committed() {
    let device = Device::new(true);
    let root = device.root();
    let external = root.parent().unwrap().join("ext");
    write(&external, "people/secure/scan.pdf", "scan");
    symlink(
        external.join("people/secure/scan.pdf"),
        root.join("people/secure/scan.pdf"),
    )
    .unwrap();
    // An adopted repository tracked it before the folder was local-only.
    assert!(commit(root, None).committed);
    assert!(head_tree_paths(root).contains(&"people/secure/scan.pdf".to_string()));

    let links = ExternalLinks::new([external]).unwrap();
    let policy = super::super::CommitPolicy {
        local_only: device.folders(),
        external: Some(&links),
        ..super::super::CommitPolicy::default()
    };
    write(root, "notes/other.md", "# Other\n");
    super::super::commit_all(root, "Update notes", &policy).unwrap();
    assert!(head_tree_paths(root).contains(&"people/secure/scan.pdf".to_string()));
}
