//! The one vault walk, shared by the desktop shell and the CLI.
//!
//! Built on the `ignore` crate (ripgrep's walker): per-entry errors instead of
//! aborting the listing, no symlink following, and `.gitignore`-aware pruning
//! so an adopted vault that is also a code checkout does not flood the index
//! with dependency trees. Classification is [`crate::classify`]; hidden-entry
//! policy lives here because the walker must keep exactly one class of
//! dot-name visible: iCloud eviction placeholders, which list as the logical
//! file they stand in for.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::UNIX_EPOCH;

use ignore::gitignore::Gitignore;
use ignore::{Match, WalkBuilder};

use crate::local_only::{LocalOnlyFolders, LocalOnlyLink};
use crate::{
    classify, evicted_logical_path, icloud_placeholder_target, is_dataless, wire_path,
    GraphPathKind,
};

/// Per-directory ignore file for user-configured exclusions, same syntax and
/// precedence as `.gitignore`.
pub const REFLECT_IGNORE_FILE: &str = ".reflectignore";

/// Machine-generated trees that are never notes, pruned at any depth. Kept
/// deliberately narrow: every name here must answer "nobody uses this as a
/// notes folder". Ambiguous names (`target`, `build`, `vendor`) are covered
/// by the `CACHEDIR.TAG` probe instead of being guessed at.
const PRUNED_DIR_NAMES: [&str; 5] = [
    "node_modules",
    "bower_components",
    "__pycache__",
    "Pods",
    "DerivedData",
];

/// Signature of the Cache Directory Tagging Specification. Cargo stamps
/// `target/` with it; any tagged directory is a rebuildable cache, not notes.
const CACHEDIR_TAG_SIGNATURE: &[u8] = b"Signature: 8a477f597d28d172789f06886806bc55";

/// One eligible file from a vault walk, in canonical wire-path form.
#[derive(Debug, Clone)]
pub struct FileEntry {
    pub path: String,
    pub size: u64,
    pub modified_ms: u64,
    /// The file is currently an iCloud eviction placeholder: present in the
    /// vault but unreadable until re-downloaded (eviction is never deletion).
    pub placeholder: bool,
}

/// One snapshot of every eligible note and supported attachment.
#[derive(Debug, Clone, Default)]
pub struct FileCatalog {
    pub notes: Vec<FileEntry>,
    pub attachments: Vec<FileEntry>,
    /// Entries the walk refused or failed to list: unreadable directories,
    /// unreadable metadata, symlinks, and default-pruned trees. Surfaced so
    /// "why isn't my file showing up" is always diagnosable.
    pub skipped: u32,
    /// Local-only links the walk followed one hop ([`walk_catalog_with`]);
    /// always empty from [`walk_catalog`].
    pub local_only_links: Vec<LocalOnlyLink>,
}

/// Recursively list every eligible note and supported attachment under `root`.
///
/// Hidden entries are pruned except iCloud eviction placeholders, which list
/// as their logical file. Symlinks are never followed and never listed. The
/// vault's own `.gitignore` files (no repository required, no global or
/// parent-directory rules) and [`REFLECT_IGNORE_FILE`] files prune subtrees;
/// [`PRUNED_DIR_NAMES`] and `CACHEDIR.TAG`-tagged directories are always
/// pruned. Every refusal is counted, never fatal: one unreadable directory
/// costs that directory, not the listing.
pub fn walk_catalog(root: &Path) -> FileCatalog {
    let mut catalog = FileCatalog::default();
    let skipped = TreeWalk::graph(root, None).run(&mut catalog);
    finish(catalog, skipped)
}

/// [`walk_catalog`] plus the graph's local-only folders: each allowed link
/// ([`LocalOnlyFolders::link_target`]) in a directory this walk entered, and
/// not itself `.reflectignore`d, is followed one hop and its target walked as
/// if it sat at the link's path. Its `.gitignore` status is not consulted (a
/// local-only folder is expected to be Git-ignored). Inside a target the
/// ordinary rules hold, with the graph-side `.reflectignore` files above the
/// link applied to the composed path; nothing is followed further, and
/// evicted (dataless) files are skipped.
pub fn walk_catalog_with(root: &Path, local_only: &LocalOnlyFolders) -> FileCatalog {
    let mut catalog = FileCatalog::default();
    let (mut skipped, links) = walk_graph_and_links(root, local_only, &mut catalog);
    for (link, ignores) in links {
        skipped += TreeWalk::local_only(&link, ignores).run(&mut catalog);
        catalog.local_only_links.push(link);
    }
    finish(catalog, skipped)
}

/// Just the allowed local-only links [`walk_catalog_with`] would follow,
/// without walking their targets (the desktop watcher's discovery).
pub fn local_only_links(root: &Path, local_only: &LocalOnlyFolders) -> Vec<LocalOnlyLink> {
    let (_, links) = walk_graph_and_links(root, local_only, &mut FileCatalog::default());
    links.into_iter().map(|(link, _)| link).collect()
}

/// The graph walk into `catalog`, then link discovery over the directories
/// it entered (none without a raw-store root). Returns the refusal count.
fn walk_graph_and_links(
    root: &Path,
    local_only: &LocalOnlyFolders,
    catalog: &mut FileCatalog,
) -> (u32, Vec<(LocalOnlyLink, AncestorIgnores)>) {
    if local_only.raw_root().is_none() {
        return (TreeWalk::graph(root, None).run(catalog), Vec::new());
    }
    let discovery = Discovery {
        visited: Arc::new(Mutex::new(vec![root.to_path_buf()])),
        folders: Arc::new(local_only.clone()),
    };
    let visited = Arc::clone(&discovery.visited);
    let mut skipped = TreeWalk::graph(root, Some(discovery)).run(catalog);
    let directories = std::mem::take(&mut *visited.lock().unwrap_or_else(PoisonError::into_inner));
    let links = discover_links(root, &directories, local_only, &mut skipped);
    (skipped, links)
}

/// What the graph walk gathers for link discovery.
#[derive(Clone)]
struct Discovery {
    /// Directories the walk enters.
    visited: Arc<Mutex<Vec<PathBuf>>>,
    /// The configured names: a symlink carrying one is left to discovery to
    /// judge (and count, if refused) instead of being counted here.
    folders: Arc<LocalOnlyFolders>,
}

/// Sort the listings into their canonical order and stamp the refusal count.
fn finish(mut catalog: FileCatalog, skipped: u32) -> FileCatalog {
    catalog
        .notes
        .sort_by(|left, right| left.path.cmp(&right.path));
    catalog
        .attachments
        .sort_by(|left, right| left.path.cmp(&right.path));
    catalog.skipped = skipped;
    catalog
}

/// One `ignore` walk feeding a catalog: the graph itself, or one local-only
/// link's target listed under the link's path.
struct TreeWalk {
    /// Where the walker starts: the graph root, or a link's canonical target.
    start: PathBuf,
    /// Wire prefix for everything under `start` (the link's path); `None`
    /// for the graph root.
    prefix: Option<String>,
    /// Link discovery's share of the graph walk.
    discovery: Option<Discovery>,
    /// Graph-side `.reflectignore` rules above a link, which a walker rooted
    /// at the link's target never reads on its own.
    ancestor_ignores: Option<Arc<AncestorIgnores>>,
}

impl TreeWalk {
    fn graph(root: &Path, discovery: Option<Discovery>) -> Self {
        Self {
            start: root.to_path_buf(),
            prefix: None,
            discovery,
            ancestor_ignores: None,
        }
    }

    fn local_only(link: &LocalOnlyLink, ignores: AncestorIgnores) -> Self {
        Self {
            start: link.target.clone(),
            prefix: Some(link.path.clone()),
            discovery: None,
            ancestor_ignores: Some(Arc::new(ignores)),
        }
    }

    /// The graph-relative path an entry under `start` lists as.
    fn composed(prefix: Option<&str>, wire: String) -> String {
        match prefix {
            Some(prefix) => format!("{prefix}/{wire}"),
            None => wire,
        }
    }

    /// Walk into `catalog`; returns how many entries were refused.
    fn run(self, catalog: &mut FileCatalog) -> u32 {
        let skipped = Arc::new(AtomicU32::new(0));
        let mut builder = WalkBuilder::new(&self.start);
        builder
            .hidden(false)
            .ignore(false)
            .parents(false)
            .git_global(false)
            .require_git(false)
            .follow_links(false)
            .add_custom_ignore_filename(REFLECT_IGNORE_FILE);
        let filter_skipped = Arc::clone(&skipped);
        let filter_start = self.start.clone();
        let filter_prefix = self.prefix.clone();
        let discovery = self.discovery.clone();
        let ancestor_ignores = self.ancestor_ignores.clone();
        builder.filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if entry.path_is_symlink() {
                let deferred = discovery
                    .as_ref()
                    .is_some_and(|discovery| discovery.folders.is_folder_name(&name));
                if !deferred {
                    filter_skipped.fetch_add(1, Ordering::Relaxed);
                }
                return false;
            }
            if name.starts_with('.') {
                return entry.file_type().is_some_and(|kind| kind.is_file())
                    && icloud_placeholder_target(&name).is_some();
            }
            let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
            if is_dir && is_pruned_dir(&name, entry.path()) {
                filter_skipped.fetch_add(1, Ordering::Relaxed);
                return false;
            }
            if let (Some(ignores), Some(prefix)) = (&ancestor_ignores, &filter_prefix) {
                let excluded = entry
                    .path()
                    .strip_prefix(&filter_start)
                    .is_ok_and(|rel| ignores.is_ignored(&Path::new(prefix).join(rel), is_dir));
                if excluded {
                    return false;
                }
            }
            if is_dir {
                if let Some(discovery) = &discovery {
                    discovery
                        .visited
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .push(entry.path().to_path_buf());
                }
            }
            true
        });

        let local_only = self.prefix.is_some();
        for result in builder.build() {
            let Ok(entry) = result else {
                skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                continue;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(&self.start) else {
                continue;
            };
            // A placeholder lists as the logical file it stands in for, unless
            // something already occupies that name (mid-download both exist).
            let listed = match evicted_logical_path(rel) {
                Some(logical_rel) => {
                    let occupied = path
                        .with_file_name(logical_rel.file_name().unwrap_or_default())
                        .symlink_metadata()
                        .is_ok();
                    if occupied {
                        None
                    } else {
                        wire_path(&logical_rel).map(|wire| (wire, true))
                    }
                }
                None => wire_path(rel).map(|wire| (wire, false)),
            };
            let Some((wire, placeholder)) = listed else {
                continue;
            };
            let wire = Self::composed(self.prefix.as_deref(), wire);
            let Some(kind) = classify(&wire) else {
                continue;
            };
            let Ok(meta) = entry.metadata() else {
                skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            // Two eviction forms fold into one flag: the legacy `.icloud`
            // stub (detected by name above) and the modern dataless file
            // (kernel flag on the real path).
            let placeholder = placeholder || is_dataless(&meta);
            if placeholder && local_only {
                // Reading an evicted raw-store file would make its provider
                // download it on demand, and the iCloud recovery paths
                // (targeted downloads) can't reach outside the graph.
                skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            let file = FileEntry {
                path: wire,
                size: meta.len(),
                modified_ms: meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or(0),
                placeholder,
            };
            match kind {
                GraphPathKind::Note => catalog.notes.push(file),
                GraphPathKind::Attachment => catalog.attachments.push(file),
            }
        }
        skipped.load(Ordering::Relaxed)
    }
}

/// Find the allowed local-only links directly inside `directories` (the
/// directories the graph walk entered), paired with the graph-side
/// `.reflectignore` rules that keep applying beneath each. A configured name
/// that fails validation counts as skipped. Sorted by path.
fn discover_links(
    root: &Path,
    directories: &[PathBuf],
    local_only: &LocalOnlyFolders,
    skipped: &mut u32,
) -> Vec<(LocalOnlyLink, AncestorIgnores)> {
    let mut links = Vec::new();
    for directory in directories {
        let Ok(entries) = std::fs::read_dir(directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let is_link = entry.file_type().is_ok_and(|kind| kind.is_symlink());
            let name = entry.file_name();
            if !is_link
                || !name
                    .to_str()
                    .is_some_and(|name| local_only.is_folder_name(name))
            {
                continue;
            }
            let path = entry.path();
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let Some(wire) = wire_path(rel) else {
                continue;
            };
            if has_pruned_component(&wire) {
                continue;
            }
            let ignores = AncestorIgnores::above(root, rel);
            if ignores.is_ignored(rel, true) {
                continue;
            }
            match local_only.link_target(root, rel) {
                Some(target) => links.push((LocalOnlyLink { path: wire, target }, ignores)),
                None => *skipped += 1,
            }
        }
    }
    links.sort_by(|(left, _), (right, _)| left.path.cmp(&right.path));
    links
}

/// The graph-side [`REFLECT_IGNORE_FILE`] matchers above one local-only link,
/// deepest first, each with the graph-relative directory it applies to.
struct AncestorIgnores(Vec<(PathBuf, Gitignore)>);

impl AncestorIgnores {
    /// Matchers from the graph root down to the directory holding `link`.
    fn above(root: &Path, link: &Path) -> Self {
        let mut matchers = Vec::new();
        let mut directory = PathBuf::new();
        let mut collect = |directory: &Path| {
            let file = root.join(directory).join(REFLECT_IGNORE_FILE);
            if file.is_file() {
                let (matcher, _error) = Gitignore::new(&file);
                if !matcher.is_empty() {
                    matchers.push((directory.to_path_buf(), matcher));
                }
            }
        };
        collect(&directory);
        if let Some(parent) = link.parent() {
            for component in parent.components() {
                directory.push(component);
                collect(&directory);
            }
        }
        matchers.reverse();
        Self(matchers)
    }

    /// Whether a graph-relative path is excluded by the nearest matcher
    /// with an opinion — gitignore precedence: deeper files win, and a
    /// whitelist (`!pattern`) un-ignores.
    fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        for (directory, matcher) in &self.0 {
            let Ok(rel) = path.strip_prefix(directory) else {
                continue;
            };
            match matcher.matched(rel, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        false
    }
}

fn is_pruned_dir(name: &str, path: &Path) -> bool {
    is_pruned_dir_name(name) || has_cachedir_tag(path)
}

/// Whether a single name is on the default prune list ([`PRUNED_DIR_NAMES`]),
/// case-folded. The name-level half of [`has_pruned_component`], exported for
/// walkers that filter by component as they descend (the desktop watcher's
/// file-ID cache) rather than by assembled wire path.
pub fn is_pruned_dir_name(name: &str) -> bool {
    PRUNED_DIR_NAMES
        .iter()
        .any(|pruned| name.eq_ignore_ascii_case(pruned))
}

/// Whether any directory component of a wire path is on the default prune
/// list. The lexical half of the walk's exclusion rules, shared with the
/// watcher so a live event can never index a file the listing refuses
/// (`CACHEDIR.TAG` and ignore-file exclusions need disk state and stay
/// walk-only; a structural reconcile prunes their residue).
pub fn has_pruned_component(path: &str) -> bool {
    let mut components = path.split('/').peekable();
    while let Some(component) = components.next() {
        // Only directory components count: a *file* named `Pods` (no
        // trailing components) is not a pruned tree.
        if components.peek().is_some() && is_pruned_dir_name(component) {
            return true;
        }
    }
    false
}

fn has_cachedir_tag(dir: &Path) -> bool {
    let Ok(file) = std::fs::File::open(dir.join("CACHEDIR.TAG")) else {
        return false;
    };
    let mut prefix = [0u8; CACHEDIR_TAG_SIGNATURE.len()];
    let mut handle = file.take(CACHEDIR_TAG_SIGNATURE.len() as u64);
    let Ok(()) = handle.read_exact(&mut prefix) else {
        return false;
    };
    prefix == CACHEDIR_TAG_SIGNATURE
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use tempfile::tempdir;

    use super::walk_catalog;

    fn write(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    fn note_paths(root: &Path) -> Vec<String> {
        walk_catalog(root)
            .notes
            .into_iter()
            .map(|file| file.path)
            .collect()
    }

    #[test]
    fn finds_markdown_anywhere_and_prunes_reserved_and_hidden_trees() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, "README.md", "root");
        write(root, "notes/a.md", "a");
        write(root, "daily/2026-06-09.md", "b");
        write(root, "templates/journal.md", "t");
        write(root, "Projects/deep/plan.md", "nested");
        write(root, "assets/caption.md", "asset");
        write(root, "audio-memos/transcript.md", "audio");
        write(root, ".obsidian/plugin.md", "hidden");
        write(root, "Projects/.private/secret.md", "hidden");
        write(root, "Projects/upper.MD", "upper");
        write(root, "notes/skip.xyz", "c");
        write(root, "notes/keep.txt", "text");
        write(root, "assets/photo.png", "png");
        write(root, "Media/clip.MP4", "video");

        let catalog = walk_catalog(root);
        let notes: Vec<&str> = catalog.notes.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            notes,
            vec![
                "Projects/deep/plan.md",
                "README.md",
                "daily/2026-06-09.md",
                "notes/a.md",
                "templates/journal.md",
            ]
        );
        let attachments: Vec<&str> = catalog
            .attachments
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(
            attachments,
            vec!["Media/clip.MP4", "assets/photo.png", "notes/keep.txt"]
        );
        assert!(catalog
            .notes
            .iter()
            .all(|f| !f.placeholder && f.modified_ms > 0));
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_or_lists_symlinks() {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let root = dir.path();
        write(outside.path(), "linked/evil.md", "outside");
        write(root, "notes/real.md", "real");
        symlink(outside.path().join("linked"), root.join("linked")).unwrap();
        symlink(outside.path().join("linked/evil.md"), root.join("alias.md")).unwrap();

        let catalog = walk_catalog(root);
        assert_eq!(note_paths(root), vec!["notes/real.md"]);
        assert!(catalog.skipped >= 2, "symlinks must count as skipped");
    }

    #[test]
    fn placeholders_list_as_their_logical_file_until_it_materializes() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, "Projects/.plan.md.icloud", "stub");
        write(root, "notes/.here.md.icloud", "stub");
        write(root, "notes/here.md", "downloaded");

        let catalog = walk_catalog(root);
        let listed: Vec<(&str, bool)> = catalog
            .notes
            .iter()
            .map(|f| (f.path.as_str(), f.placeholder))
            .collect();
        assert_eq!(
            listed,
            vec![("Projects/plan.md", true), ("notes/here.md", false)]
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_directory_costs_itself_not_the_listing() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, "notes/a.md", "a");
        write(root, "locked/hidden.md", "unreachable");
        let locked = root.join("locked");
        fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

        let catalog = walk_catalog(root);

        fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
        let notes: Vec<&str> = catalog.notes.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(notes, vec!["notes/a.md"]);
        assert!(
            catalog.skipped >= 1,
            "the unreadable directory must be counted"
        );
    }

    #[test]
    fn gitignore_and_reflectignore_prune_without_a_repository() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, ".gitignore", "generated/\n");
        write(root, ".reflectignore", "drafts/\n");
        write(root, "generated/api.md", "generated");
        write(root, "drafts/wip.md", "draft");
        write(root, "notes/a.md", "a");

        assert_eq!(note_paths(root), vec!["notes/a.md"]);
    }

    #[test]
    fn pruned_components_are_shared_with_live_event_filtering() {
        use super::has_pruned_component;
        assert!(has_pruned_component("node_modules/pkg/README.md"));
        assert!(has_pruned_component("vendor/Pods/readme.md"));
        assert!(has_pruned_component("NODE_MODULES/x.md"));
        // Only directory components count; similar file names are fine.
        assert!(!has_pruned_component("Pods"));
        assert!(!has_pruned_component("notes/node_modules.md"));
        assert!(!has_pruned_component("Projects/deep/plan.md"));
    }

    /// A graph and a raw store side by side, canonicalized (macOS `/var` →
    /// `/private/var`), with `finance/secure` linked into the store.
    #[cfg(unix)]
    struct LinkedGraph {
        _dir: tempfile::TempDir,
        graph: std::path::PathBuf,
        raw: std::path::PathBuf,
    }

    #[cfg(unix)]
    fn linked_graph() -> LinkedGraph {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let graph = base.join("graph");
        let raw = base.join("raw");
        write(&graph, "notes/public.md", "public");
        write(&raw, "finance/secure/bank.md", "bank");
        fs::create_dir_all(graph.join("finance")).unwrap();
        symlink(raw.join("finance/secure"), graph.join("finance/secure")).unwrap();
        LinkedGraph {
            _dir: dir,
            graph,
            raw,
        }
    }

    #[cfg(unix)]
    fn folders(raw: &Path) -> crate::LocalOnlyFolders {
        crate::LocalOnlyFolders::new(["secure"], Some(raw)).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn local_only_links_are_followed_one_hop_even_when_gitignored() {
        use std::os::unix::fs::symlink;
        let linked = linked_graph();
        let (graph, raw) = (&linked.graph, &linked.raw);
        // The vault keeps the link out of Git by name — the expected state.
        write(graph, ".gitignore", "secure\n");
        write(raw, "finance/secure/sub/tax.md", "tax");
        write(raw, "finance/secure/scan.png", "png");
        write(raw, "finance/secure/.hidden/x.md", "hidden");
        write(raw, "finance/secure/node_modules/pkg/README.md", "dep");
        write(raw, "elsewhere/leak.md", "leak");
        symlink(raw.join("elsewhere"), raw.join("finance/secure/alias")).unwrap();

        let catalog = super::walk_catalog_with(graph, &folders(raw));
        let notes: Vec<&str> = catalog.notes.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            notes,
            vec![
                "finance/secure/bank.md",
                "finance/secure/sub/tax.md",
                "notes/public.md"
            ]
        );
        let attachments: Vec<&str> = catalog
            .attachments
            .iter()
            .map(|f| f.path.as_str())
            .collect();
        assert_eq!(attachments, vec!["finance/secure/scan.png"]);
        assert_eq!(catalog.local_only_links.len(), 1);
        assert_eq!(catalog.local_only_links[0].path, "finance/secure");
        assert_eq!(
            catalog.local_only_links[0].target,
            raw.join("finance/secure")
        );
        // Exactly the nested symlink and the pruned tree; the hidden folder
        // is invisible, and the followed link is not a refusal.
        assert_eq!(catalog.skipped, 2);

        // The shared walk (CLI, iCloud sweep) is unchanged: no link followed.
        assert_eq!(note_paths(graph), vec!["notes/public.md"]);
        // Discovery alone finds the same links without walking the targets.
        assert_eq!(
            super::local_only_links(graph, &folders(raw)),
            catalog.local_only_links
        );
    }

    #[cfg(unix)]
    #[test]
    fn links_inside_skipped_directories_are_never_discovered() {
        use std::os::unix::fs::symlink;
        let linked = linked_graph();
        let (graph, raw) = (&linked.graph, &linked.raw);
        write(graph, ".gitignore", "archive/\n");
        write(raw, "archive/secure/old.md", "old");
        fs::create_dir_all(graph.join("archive")).unwrap();
        fs::create_dir_all(graph.join(".hidden")).unwrap();
        symlink(raw.join("archive/secure"), graph.join("archive/secure")).unwrap();
        symlink(raw.join("archive/secure"), graph.join(".hidden/secure")).unwrap();

        let catalog = super::walk_catalog_with(graph, &folders(raw));
        let links: Vec<&str> = catalog
            .local_only_links
            .iter()
            .map(|link| link.path.as_str())
            .collect();
        assert_eq!(links, vec!["finance/secure"]);
        assert!(!catalog.notes.iter().any(|f| f.path.contains("old.md")));
        // Ignored and hidden directories are pruned silently.
        assert_eq!(catalog.skipped, 0);
    }

    #[cfg(unix)]
    #[test]
    fn graph_reflectignore_rules_still_apply_inside_a_link() {
        let linked = linked_graph();
        let (graph, raw) = (&linked.graph, &linked.raw);
        write(graph, ".reflectignore", "cache/\n");
        write(graph, "finance/.reflectignore", "secure/drafts/\n");
        write(raw, "finance/secure/cache/raw.md", "cached");
        write(raw, "finance/secure/drafts/wip.md", "draft");
        write(raw, "finance/secure/.reflectignore", "scratch.md\n");
        write(raw, "finance/secure/scratch.md", "scratch");

        let catalog = super::walk_catalog_with(graph, &folders(raw));
        let notes: Vec<&str> = catalog.notes.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(notes, vec!["finance/secure/bank.md", "notes/public.md"]);

        // Ignoring the link itself keeps the whole folder out.
        write(graph, "finance/.reflectignore", "secure\n");
        let catalog = super::walk_catalog_with(graph, &folders(raw));
        assert!(catalog.local_only_links.is_empty());
        assert_eq!(
            catalog
                .notes
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["notes/public.md"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn invalid_links_are_counted_and_never_followed() {
        use std::os::unix::fs::symlink;
        let linked = linked_graph();
        let (graph, raw) = (&linked.graph, &linked.raw);
        let outside = tempdir().unwrap();
        write(outside.path(), "secure/leak.md", "leak");
        fs::create_dir_all(graph.join("people")).unwrap();
        fs::create_dir_all(graph.join("career")).unwrap();
        symlink(outside.path().join("secure"), graph.join("people/secure")).unwrap();
        symlink(raw.join("missing"), graph.join("career/secure")).unwrap();

        let catalog = super::walk_catalog_with(graph, &folders(raw));
        assert_eq!(catalog.local_only_links.len(), 1);
        assert!(!catalog.notes.iter().any(|f| f.path.contains("leak")));
        // Each refused link counts once (discovery's verdict); the followed
        // one does not count at all.
        assert_eq!(catalog.skipped, 2);

        // Without a raw-store root nothing is followed at all.
        let deny_only = crate::LocalOnlyFolders::new(["secure"], None).unwrap();
        let catalog = super::walk_catalog_with(graph, &deny_only);
        assert!(catalog.local_only_links.is_empty());
        assert_eq!(
            catalog
                .notes
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>(),
            vec!["notes/public.md"]
        );
    }

    #[test]
    fn dependency_trees_and_tagged_caches_are_pruned_by_default() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        write(root, "node_modules/pkg/README.md", "dep");
        write(root, "target/doc/index.md", "cache");
        write(
            root,
            "target/CACHEDIR.TAG",
            "Signature: 8a477f597d28d172789f06886806bc55\n",
        );
        write(root, "Target Practice/notes.md", "keep");
        write(root, "vendor/notes.md", "keep too");
        write(root, "notes/a.md", "a");

        let catalog = walk_catalog(root);
        let notes: Vec<&str> = catalog.notes.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            notes,
            vec!["Target Practice/notes.md", "notes/a.md", "vendor/notes.md"]
        );
        assert!(
            catalog.skipped >= 2,
            "node_modules and target must be counted"
        );
    }
}
