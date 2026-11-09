//! External storage: a folder outside the graph, configured per graph, that
//! holds attachments Git backup doesn't carry at their graph-relative paths
//! (`<root>/<path>`), read as if they sat in the graph.
//!
//! - **Overlay** ([`ExternalStore::overlay_copy`]): a path with no entry in
//!   the graph reads the folder's copy at that path.
//! - **Links** ([`ExternalStore::link_copy`]): a symlink at a graph path that
//!   names the copy at that same path, so other apps still find the file in
//!   the graph folder. Re-validated on every call.
//! - **Git** ([`ExternalLinks`]): the folder's every spelling, matched
//!   lexically, so commits skip links into it while it is unmounted, moved,
//!   or no longer configured.
//!
//! Only attachments are ever external, and callers keep local-only paths
//! out. The root must carry [`MARKER_FILE_NAME`], so a hand-edited setting
//! can't turn an arbitrary folder into part of a graph.

use std::fs;
use std::path::{Component, Path, PathBuf};

use crate::{eviction_placeholder, is_attachment};

/// The file that marks a folder as external storage, in the folder's root.
pub const MARKER_FILE_NAME: &str = ".reflect-external-storage";

/// One graph's external storage folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalStore {
    /// The configured root (absolute), canonicalized at every check.
    root: PathBuf,
    /// The graph's local-only raw-store root, which the folder stays apart from.
    raw_root: Option<PathBuf>,
    /// The user's home folder, which the folder must not contain.
    home: Option<PathBuf>,
}

/// One graph path's copy in external storage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalCopy {
    /// The canonical, symlink-free external root.
    pub root: PathBuf,
    /// The graph-relative path below it, as requested; no existing component
    /// of it is a symlink.
    pub rel: PathBuf,
    /// `rel` as the folder's filesystem spells it (case and Unicode folded
    /// onto the stored names), forward-slashed: what local-only rules judge.
    pub on_disk: String,
}

impl ExternalCopy {
    /// The physical file.
    pub fn path(&self) -> PathBuf {
        self.root.join(&self.rel)
    }
}

impl ExternalStore {
    /// A store rooted at `root`, kept apart from the graph's local-only
    /// `raw_root` and from containing `home`; `None` when `root` is relative.
    pub fn new(root: &Path, raw_root: Option<&Path>, home: Option<&Path>) -> Option<Self> {
        root.is_absolute().then(|| Self {
            root: root.to_path_buf(),
            raw_root: raw_root.map(Path::to_path_buf),
            home: home.map(Path::to_path_buf),
        })
    }

    /// The configured root, as written (not canonicalized).
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Why the folder cannot serve `graph_root` right now, or `None` when it
    /// can: it must be an existing folder carrying [`MARKER_FILE_NAME`] that
    /// neither contains nor lies inside the graph or the local-only raw
    /// store, and does not contain the home folder.
    pub fn problem(&self, graph_root: &Path) -> Option<&'static str> {
        self.usable_root(graph_root).err()
    }

    /// The folder's canonical root when it can serve `graph_root`.
    pub fn canonical_root(&self, graph_root: &Path) -> Option<PathBuf> {
        self.usable_root(graph_root).ok()
    }

    /// The spellings Git treats as this folder ([`ExternalLinks`]): as
    /// configured and canonical while it can serve `graph_root`, as
    /// configured while it is missing (an unmounted drive), and none while
    /// it exists but can't serve the graph (unmarked, or overlapping the
    /// graph, the raw store, or the home folder), since no link of Reflect's
    /// points there.
    pub fn link_spellings(&self, graph_root: &Path) -> Vec<PathBuf> {
        match self.usable_root(graph_root) {
            Ok(canonical) => vec![self.root.clone(), canonical],
            Err(_) if fs::canonicalize(&self.root).is_err() => vec![self.root.clone()],
            Err(_) => Vec::new(),
        }
    }

    fn usable_root(&self, graph_root: &Path) -> Result<PathBuf, &'static str> {
        let root = fs::canonicalize(&self.root)
            .map_err(|_| "the folder does not exist (is the drive mounted?)")?;
        if !root.is_dir() {
            return Err("it is not a folder");
        }
        if !fs::symlink_metadata(root.join(MARKER_FILE_NAME)).is_ok_and(|meta| meta.is_file()) {
            return Err("it is missing its .reflect-external-storage marker file");
        }
        let overlaps = |other: &Path| root.starts_with(other) || other.starts_with(&root);
        let graph = fs::canonicalize(graph_root).map_err(|_| "the graph folder is missing")?;
        if overlaps(&graph) {
            return Err("it must not contain the graph or lie inside it");
        }
        if let Some(raw_root) = self
            .raw_root
            .as_deref()
            .and_then(|raw| fs::canonicalize(raw).ok())
            && overlaps(&raw_root)
        {
            return Err("it must not contain the local-only rawRoot or lie inside it");
        }
        if let Some(home) = self
            .home
            .as_deref()
            .and_then(|home| fs::canonicalize(home).ok())
            && home.starts_with(&root)
        {
            return Err("it must not be the home folder or contain it");
        }
        Ok(root)
    }

    /// The copy a leaf link at attachment `rel` stands for: under real graph
    /// directories, the link resolves to the very file at `rel` in a usable
    /// folder, reached through no symlink there.
    pub fn link_copy(&self, graph_root: &Path, rel: &str) -> Option<ExternalCopy> {
        if !is_attachment(rel) {
            return None;
        }
        let rel = plain_relative(rel)?;
        if graph_entry(graph_root, &rel)? != GraphEntry::Symlink {
            return None;
        }
        let copy = self.copy_at(graph_root, rel)?;
        same_file(&graph_root.join(&copy.rel), &copy.path()).then_some(copy)
    }

    /// The copy an absent attachment `rel` reads: the graph has no entry
    /// there (and only real directories above it), and the folder is usable
    /// and holds a regular file at `rel`, reached through no symlink.
    pub fn overlay_copy(&self, graph_root: &Path, rel: &str) -> Option<ExternalCopy> {
        if !is_attachment(rel) {
            return None;
        }
        let rel = plain_relative(rel)?;
        if graph_entry(graph_root, &rel)? != GraphEntry::Vacant {
            return None;
        }
        self.copy_at(graph_root, rel)
    }

    /// `rel` under the usable root, a regular file with no symlink on the way.
    fn copy_at(&self, graph_root: &Path, rel: PathBuf) -> Option<ExternalCopy> {
        let root = self.usable_root(graph_root).ok()?;
        let path = real_path_below(&root, &rel, |kind| kind.is_file())?;
        let on_disk = fs::canonicalize(path).ok()?;
        let on_disk = slash_path(on_disk.strip_prefix(&root).ok()?);
        Some(ExternalCopy { root, rel, on_disk })
    }
}

/// Every folder spelling a graph's external storage has had: the configured
/// root, its canonical form, and earlier roots as recorded. A link whose
/// target lies under one stands for a file kept in that folder, which Git
/// never stages. Matched lexically with ASCII case folded, so it holds while
/// the folder is unmounted, moved, or no longer configured, and errs toward
/// skipping a link rather than committing one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalLinks {
    roots: Vec<PathBuf>,
}

impl ExternalLinks {
    /// The absolute `roots`, normalized and folded together; `None` when
    /// none is left.
    pub fn new(roots: impl IntoIterator<Item = PathBuf>) -> Option<Self> {
        let mut kept: Vec<PathBuf> = Vec::new();
        for root in roots.into_iter().filter(|root| root.is_absolute()) {
            let root = normalize(&root);
            if !kept
                .iter()
                .any(|seen| starts_with_folded(seen, &root) && starts_with_folded(&root, seen))
            {
                kept.push(root);
            }
        }
        (!kept.is_empty()).then_some(Self { roots: kept })
    }

    /// The spellings, as kept.
    pub fn roots(&self) -> &[PathBuf] {
        &self.roots
    }

    /// Whether a symlink in `link_dir` whose target reads `target` points
    /// under one of the roots and outside `graph_root`: a link into the graph
    /// is never one into the folder, whatever was recorded. A relative
    /// target is taken from `link_dir`.
    pub fn points_into(&self, target: &Path, link_dir: &Path, graph_root: &Path) -> bool {
        let target = normalize(&link_dir.join(target));
        !starts_with_folded(&target, &normalize(graph_root))
            && self
                .roots
                .iter()
                .any(|root| starts_with_folded(&target, root))
    }

    /// Whether the entry at absolute `path` in the graph at `graph_root` is
    /// a symlink pointing into the folder ([`Self::points_into`]), whatever
    /// it points at now. The link's directory and the graph root are taken
    /// as the filesystem resolves them.
    pub fn is_link_into(&self, graph_root: &Path, path: &Path) -> bool {
        let Ok(target) = fs::read_link(path) else {
            return false;
        };
        let resolved = |dir: &Path| fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let link_dir = resolved(path.parent().unwrap_or(Path::new("")));
        self.points_into(&target, &link_dir, &resolved(graph_root))
    }
}

/// What a graph-relative path names in the graph.
#[derive(Debug, PartialEq, Eq)]
enum GraphEntry {
    /// Nothing, under real directories (or none yet).
    Vacant,
    /// A symlink, under real directories.
    Symlink,
    /// Anything else: a file (an evicted one's iCloud stub included), a
    /// directory, or a path through a symlink or a file.
    Occupied,
}

/// Whether the graph has no entry at `rel` and only real directories above
/// it: where the overlay may list the folder's copy.
pub(crate) fn graph_vacant(graph_root: &Path, rel: &Path) -> bool {
    graph_entry(graph_root, rel) == Some(GraphEntry::Vacant)
}

/// Classify `rel` in the graph without following any link; `None` when a
/// component can't be read (fails closed).
fn graph_entry(graph_root: &Path, rel: &Path) -> Option<GraphEntry> {
    let mut current = graph_root.to_path_buf();
    let mut parts = rel.components().peekable();
    while let Some(part) = parts.next() {
        current.push(part);
        let leaf = parts.peek().is_none();
        let kind = match fs::symlink_metadata(&current) {
            Ok(meta) => meta.file_type(),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                let evicted = leaf
                    && eviction_placeholder(&current)
                        .is_some_and(|stub| fs::symlink_metadata(stub).is_ok());
                return Some(if evicted {
                    GraphEntry::Occupied
                } else {
                    GraphEntry::Vacant
                });
            }
            Err(_) => return None,
        };
        if leaf {
            return Some(if kind.is_symlink() {
                GraphEntry::Symlink
            } else {
                GraphEntry::Occupied
            });
        }
        if !kind.is_dir() {
            return Some(GraphEntry::Occupied);
        }
    }
    Some(GraphEntry::Occupied)
}

/// `base.join(rel)` when every component of `rel` below `base` is a real
/// directory and the last satisfies `leaf`; nothing is followed.
fn real_path_below(
    base: &Path,
    rel: &Path,
    leaf: impl Fn(&fs::FileType) -> bool,
) -> Option<PathBuf> {
    let mut current = base.to_path_buf();
    let mut parts = rel.components().peekable();
    while let Some(part) = parts.next() {
        current.push(part);
        let kind = fs::symlink_metadata(&current).ok()?.file_type();
        let acceptable = if parts.peek().is_some() {
            kind.is_dir()
        } else {
            leaf(&kind)
        };
        if !acceptable {
            return None;
        }
    }
    Some(current)
}

/// A wire path's plain components (`.` dropped) as a native path; `None` for
/// anything that could leave the root.
fn plain_relative(rel: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// `path` with `.` dropped and each `..` removing the component before it,
/// without touching the filesystem.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Whether `path` lies under `prefix`, component by component, ASCII case
/// folded.
fn starts_with_folded(path: &Path, prefix: &Path) -> bool {
    let mut components = path.components();
    prefix.components().all(|expected| {
        components.next().is_some_and(|component| {
            component
                .as_os_str()
                .eq_ignore_ascii_case(expected.as_os_str())
        })
    })
}

/// `path`'s normal components joined with `/`.
fn slash_path(path: &Path) -> String {
    let parts: Vec<String> = path
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    parts.join("/")
}

/// Whether two paths, followed, name one file (same device and inode).
#[cfg(unix)]
fn same_file(left: &Path, right: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::metadata(left), fs::metadata(right)) {
        (Ok(left), Ok(right)) => left.dev() == right.dev() && left.ino() == right.ino(),
        _ => false,
    }
}

/// Whether two paths, followed, name one file (the same canonical path).
#[cfg(not(unix))]
fn same_file(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::{ExternalLinks, ExternalStore, MARKER_FILE_NAME};

    /// A graph, an external folder, and a raw store side by side
    /// (canonicalized: macOS `/var` is `/private/var`).
    struct Setup {
        _dir: tempfile::TempDir,
        graph: PathBuf,
        external: PathBuf,
        raw: PathBuf,
    }

    impl Setup {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path().canonicalize().unwrap();
            let (graph, external, raw) = (base.join("graph"), base.join("ext"), base.join("raw"));
            for folder in [&graph, &external, &raw] {
                std::fs::create_dir_all(folder).unwrap();
            }
            std::fs::write(external.join(MARKER_FILE_NAME), "").unwrap();
            Self {
                _dir: dir,
                graph,
                external,
                raw,
            }
        }

        fn store(&self) -> ExternalStore {
            ExternalStore::new(&self.external, Some(&self.raw), None).unwrap()
        }

        /// `folder`, created and marked, as a store.
        fn marked(&self, folder: &Path, home: Option<&Path>) -> ExternalStore {
            std::fs::create_dir_all(folder).unwrap();
            std::fs::write(folder.join(MARKER_FILE_NAME), "").unwrap();
            ExternalStore::new(folder, Some(&self.raw), home).unwrap()
        }
    }

    fn write(root: &Path, rel: &str, contents: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn a_relative_root_is_refused() {
        assert!(ExternalStore::new(Path::new("ext"), None, None).is_none());
    }

    #[test]
    fn the_folder_must_exist_carry_the_marker_and_stay_apart() {
        let setup = Setup::new();
        assert_eq!(setup.store().problem(&setup.graph), None);

        let missing = ExternalStore::new(&setup.external.join("gone"), None, None).unwrap();
        let problem = missing.problem(&setup.graph).unwrap();
        assert!(problem.contains("does not exist"), "{problem}");

        let unmarked = setup.external.join("unmarked");
        std::fs::create_dir(&unmarked).unwrap();
        let unmarked = ExternalStore::new(&unmarked, None, None).unwrap();
        assert!(unmarked.problem(&setup.graph).unwrap().contains("marker"));

        let inside = setup.marked(&setup.graph.join("inside"), None);
        assert!(inside.problem(&setup.graph).unwrap().contains("graph"));
        let around = setup.marked(setup.graph.parent().unwrap(), None);
        assert!(around.problem(&setup.graph).unwrap().contains("graph"));
        let in_raw = setup.marked(&setup.raw.join("ext"), None);
        assert!(in_raw.problem(&setup.graph).unwrap().contains("rawRoot"));
    }

    #[test]
    fn the_folder_may_lie_inside_the_home_folder_but_not_contain_it() {
        let setup = Setup::new();
        let home = setup.raw.parent().unwrap().join("home/me");
        std::fs::create_dir_all(&home).unwrap();
        let inside = setup.marked(&home.join("Drive/Notes files"), Some(&home));
        assert_eq!(inside.problem(&setup.graph), None);
        let around = setup.marked(home.parent().unwrap(), Some(&home));
        assert!(around.problem(&setup.graph).unwrap().contains("home"));
        let is_home = setup.marked(&home, Some(&home));
        assert!(is_home.problem(&setup.graph).unwrap().contains("home"));
    }

    #[test]
    fn an_absent_attachment_is_read_from_the_folder() {
        let setup = Setup::new();
        write(&setup.external, "research/big.pdf", "pdf");
        let copy = setup
            .store()
            .overlay_copy(&setup.graph, "research/big.pdf")
            .unwrap();
        assert_eq!(copy.path(), setup.external.join("research/big.pdf"));
        assert_eq!(copy.on_disk, "research/big.pdf");

        // The graph's own entry wins, an evicted one's stub included, and
        // notes are never external.
        write(&setup.graph, "research/.big.pdf.icloud", "stub");
        assert_eq!(
            setup.store().overlay_copy(&setup.graph, "research/big.pdf"),
            None
        );
        write(&setup.graph, "research/big.pdf", "local");
        assert_eq!(
            setup.store().overlay_copy(&setup.graph, "research/big.pdf"),
            None
        );
        write(&setup.external, "research/note.md", "note");
        assert_eq!(
            setup.store().overlay_copy(&setup.graph, "research/note.md"),
            None
        );
    }

    #[test]
    fn the_copy_reports_the_spelling_the_folder_stores() {
        let setup = Setup::new();
        write(&setup.external, "Research/Big.pdf", "pdf");
        let folds = setup.external.join("research/big.pdf").exists();
        let copy = setup.store().overlay_copy(&setup.graph, "research/big.pdf");
        if folds {
            assert_eq!(copy.unwrap().on_disk, "Research/Big.pdf");
        } else {
            assert_eq!(copy, None);
        }
    }

    #[test]
    fn the_overlay_needs_real_folders_on_both_sides() {
        let setup = Setup::new();
        write(&setup.external, "papers/a.pdf", "pdf");
        write(&setup.external, "files/b.pdf", "pdf");
        // A file where the graph has a folder's name.
        write(&setup.graph, "files", "file");
        assert_eq!(
            setup.store().overlay_copy(&setup.graph, "files/b.pdf"),
            None
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            // A graph folder that is a link elsewhere.
            let elsewhere = setup.raw.join("elsewhere");
            std::fs::create_dir(&elsewhere).unwrap();
            symlink(&elsewhere, setup.graph.join("papers")).unwrap();
            assert_eq!(
                setup.store().overlay_copy(&setup.graph, "papers/a.pdf"),
                None
            );
            // A link below the external root.
            write(&elsewhere, "c.pdf", "pdf");
            symlink(&elsewhere, setup.external.join("linked")).unwrap();
            assert_eq!(
                setup.store().overlay_copy(&setup.graph, "linked/c.pdf"),
                None
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_counts_only_when_it_names_the_copy_at_its_own_path() {
        use std::os::unix::fs::symlink;
        let setup = Setup::new();
        write(&setup.external, "research/big.pdf", "pdf");
        write(&setup.external, "research/other.pdf", "other");
        std::fs::create_dir_all(setup.graph.join("research")).unwrap();
        let link = setup.graph.join("research/big.pdf");
        symlink(setup.external.join("research/big.pdf"), &link).unwrap();
        let copy = setup
            .store()
            .link_copy(&setup.graph, "research/big.pdf")
            .unwrap();
        assert_eq!(copy.rel, Path::new("research/big.pdf"));
        assert_eq!(
            setup.store().overlay_copy(&setup.graph, "research/big.pdf"),
            None
        );

        // Retargeted to another external file: not honored.
        std::fs::remove_file(&link).unwrap();
        symlink(setup.external.join("research/other.pdf"), &link).unwrap();
        assert_eq!(
            setup.store().link_copy(&setup.graph, "research/big.pdf"),
            None
        );

        // Pointing outside the folder: not honored.
        write(&setup.raw, "big.pdf", "raw");
        std::fs::remove_file(&link).unwrap();
        symlink(setup.raw.join("big.pdf"), &link).unwrap();
        assert_eq!(
            setup.store().link_copy(&setup.graph, "research/big.pdf"),
            None
        );

        // A regular file is not a link.
        std::fs::remove_file(&link).unwrap();
        write(&setup.graph, "research/big.pdf", "local");
        assert_eq!(
            setup.store().link_copy(&setup.graph, "research/big.pdf"),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_link_through_a_link_below_the_root_is_refused() {
        use std::os::unix::fs::symlink;
        let setup = Setup::new();
        let elsewhere = setup.raw.join("elsewhere");
        write(&elsewhere, "big.pdf", "pdf");
        symlink(&elsewhere, setup.external.join("research")).unwrap();
        std::fs::create_dir_all(setup.graph.join("research")).unwrap();
        symlink(
            setup.external.join("research/big.pdf"),
            setup.graph.join("research/big.pdf"),
        )
        .unwrap();
        assert_eq!(
            setup.store().link_copy(&setup.graph, "research/big.pdf"),
            None
        );
    }

    #[test]
    fn link_targets_are_judged_lexically_against_every_spelling() {
        let setup = Setup::new();
        let alias = setup.raw.join("Drive alias");
        let links = ExternalLinks::new([
            setup.external.clone(),
            alias.clone(),
            PathBuf::from("relative/ignored"),
        ])
        .unwrap();
        assert_eq!(links.roots().len(), 2);
        let graph = &setup.graph;
        let link_dir = graph.join("research");
        let into = |target: &Path| links.points_into(target, &link_dir, graph);
        assert!(into(&setup.external.join("research/big.pdf")));
        assert!(into(Path::new("../../ext/research/big.pdf")));
        // Neither folder needs to exist, and ASCII case is folded.
        assert!(into(&alias.join("a.pdf")));
        assert!(into(
            &PathBuf::from(alias.to_string_lossy().to_uppercase()).join("a.pdf")
        ));
        assert!(!into(&setup.raw.join("big.pdf")));
        assert!(!into(Path::new("big.pdf")));
        assert!(!into(&setup.raw.join("Drive aliased/a.pdf")));
        assert_eq!(ExternalLinks::new([PathBuf::from("relative")]), None);
    }

    #[test]
    fn a_link_into_the_graph_never_counts_whatever_was_recorded() {
        let setup = Setup::new();
        let around = ExternalLinks::new([setup.graph.parent().unwrap().to_path_buf()]).unwrap();
        let link_dir = setup.graph.join("notes");
        assert!(!around.points_into(Path::new("target.md"), &link_dir, &setup.graph));
        assert!(!around.points_into(
            &setup.graph.join("notes/target.md"),
            &link_dir,
            &setup.graph
        ));
        assert!(around.points_into(&setup.raw.join("a.pdf"), &link_dir, &setup.graph));
    }

    #[test]
    fn only_a_usable_or_missing_folder_has_link_spellings() {
        let setup = Setup::new();
        let usable = setup.store().link_spellings(&setup.graph);
        assert_eq!(usable, vec![setup.external.clone(), setup.external.clone()]);
        let missing = ExternalStore::new(&setup.raw.join("unmounted"), None, None).unwrap();
        assert_eq!(
            missing.link_spellings(&setup.graph),
            vec![setup.raw.join("unmounted")]
        );
        let unmarked = ExternalStore::new(&setup.raw, None, None).unwrap();
        assert_eq!(unmarked.link_spellings(&setup.graph), Vec::<PathBuf>::new());
        let around = setup.marked(setup.graph.parent().unwrap(), None);
        assert_eq!(around.link_spellings(&setup.graph), Vec::<PathBuf>::new());
    }
}
