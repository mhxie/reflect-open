//! Local-only folders: named folders (usually symlinks into a "raw store"
//! outside the graph) whose notes the desktop reads on this machine but never
//! syncs, sends, or publishes. They are read-only unless the configuration
//! also lists their name as editable; then the desktop edits notes in place,
//! and those writes never leave the folder or follow a link inside it.
//!
//! - **Deny side** ([`LocalOnlyFolders::contains`], [`LocalOnlyFolders::covers`]):
//!   lexical rules over the configured names, in force even while a link
//!   dangles. Names are ASCII-only, so ASCII case-insensitive matching is
//!   exact; callers that touch the disk also check the entry a path resolves
//!   to, because APFS folds Unicode case (`ſecure` opens `secure`).
//! - **Allow side** ([`LocalOnlyFolders::link_target`]): one symlink hop into a
//!   validated target; nothing inside it is followed further.
//! - **Edit side** ([`LocalOnlyFolders::editable_contains`]): a path inside
//!   local-only folders is editable only when every configured name on it is
//!   editable. Editability is opt-in and starts empty
//!   ([`LocalOnlyFolders::with_editable`]); losing it is always safe.
//!
//! The path predicates are shared with `packages/core` through
//! `fixtures/local-only-paths.json` and `fixtures/local-only-editable.json`.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// One graph's local-only folder configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalOnlyFolders {
    names: Vec<String>,
    /// The configured raw-store root (absolute). Canonicalized at every
    /// check, so a store mounted after the graph opened still resolves.
    raw_root: Option<PathBuf>,
    /// The configured names whose folders may be edited in place, spelled
    /// as in `names`; empty unless [`Self::with_editable`] grants some.
    editable: Vec<String>,
}

/// A local-only link a walk followed one hop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalOnlyLink {
    /// Graph-relative wire path of the link itself (`finance/secure`).
    pub path: String,
    /// The canonical directory the link resolves to, under the raw-store root.
    pub target: PathBuf,
}

/// Root folders Reflect itself manages; none can be local-only.
const RESERVED_FOLDER_NAMES: [&str; 5] = ["daily", "notes", "templates", "assets", "audio-memos"];

/// Why `name` cannot be a local-only folder name, or `None` when it can: it
/// must be one visible, plain-ASCII path segment that Reflect does not manage
/// itself. ASCII-only because the macOS filesystem folds Unicode case and
/// normalization, which no lexical comparison here could match exactly.
pub fn folder_name_problem(name: &str) -> Option<&'static str> {
    if name.is_empty() {
        Some("it is empty")
    } else if !name.is_ascii() {
        Some("it must be plain ASCII")
    } else if name.starts_with('.') {
        Some("hidden folders are never part of a graph")
    } else if name.contains(['/', '\\']) {
        Some("it must be a single folder name, not a path")
    } else if name.chars().any(|character| character.is_ascii_control()) {
        Some("it contains control characters")
    } else if RESERVED_FOLDER_NAMES
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(name))
    {
        Some("Reflect manages that folder itself")
    } else {
        None
    }
}

impl LocalOnlyFolders {
    /// Build a configuration from folder names and an optional raw-store root.
    ///
    /// Names with a [`folder_name_problem`] are dropped and duplicates folded;
    /// `None` when no valid name remains. A relative `raw_root` is dropped,
    /// leaving only the deny side active. Nothing is editable.
    pub fn new<I, S>(names: I, raw_root: Option<&Path>) -> Option<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut kept: Vec<String> = Vec::new();
        for name in names {
            let name = name.as_ref();
            if folder_name_problem(name).is_none()
                && !kept.iter().any(|seen| seen.eq_ignore_ascii_case(name))
            {
                kept.push(name.to_string());
            }
        }
        if kept.is_empty() {
            return None;
        }
        Some(Self {
            names: kept,
            raw_root: raw_root
                .filter(|path| path.is_absolute())
                .map(Path::to_path_buf),
            editable: Vec::new(),
        })
    }

    /// [`Self::new`] for names a graph's index recorded at an earlier open:
    /// every non-empty name is kept, even one today's [`folder_name_problem`]
    /// rules would refuse (a name recorded before a rule existed). Dropping
    /// it would turn its folder public; keeping it fails closed until the
    /// user releases it. Duplicates still fold. Nothing is editable.
    pub fn recorded<I, S>(names: I, raw_root: Option<&Path>) -> Option<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut kept: Vec<String> = Vec::new();
        for name in names {
            let name = name.as_ref();
            if !name.is_empty() && !kept.iter().any(|seen| seen.eq_ignore_ascii_case(name)) {
                kept.push(name.to_string());
            }
        }
        if kept.is_empty() {
            return None;
        }
        Some(Self {
            names: kept,
            raw_root: raw_root
                .filter(|path| path.is_absolute())
                .map(Path::to_path_buf),
            editable: Vec::new(),
        })
    }

    /// This configuration with exactly `names` editable: each must be a
    /// configured name ([`Self::is_folder_name`], ASCII case-insensitive)
    /// and is kept in its configured spelling, duplicates folded. Returns
    /// the names that are not configured, which grant nothing.
    pub fn with_editable<I, S>(mut self, names: I) -> (Self, Vec<String>)
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut editable: Vec<String> = Vec::new();
        let mut rejected = Vec::new();
        for name in names {
            let name = name.as_ref();
            match self
                .names
                .iter()
                .find(|configured| configured.eq_ignore_ascii_case(name))
            {
                Some(configured) => {
                    if !editable.contains(configured) {
                        editable.push(configured.clone());
                    }
                }
                None => rejected.push(name.to_string()),
            }
        }
        self.editable = editable;
        (self, rejected)
    }

    /// This configuration with nothing editable: what every doubt about the
    /// configuration falls back to.
    pub fn without_editable(mut self) -> Self {
        self.editable.clear();
        self
    }

    /// The configured folder names, as written.
    pub fn names(&self) -> &[String] {
        &self.names
    }

    /// The names whose folders may be edited in place, in their configured
    /// spelling; empty when every local-only folder is read-only.
    pub fn editable_names(&self) -> &[String] {
        &self.editable
    }

    /// Whether `name` is an editable folder name (ASCII case-insensitive).
    pub fn is_editable_name(&self, name: &str) -> bool {
        self.editable
            .iter()
            .any(|editable| editable.eq_ignore_ascii_case(name))
    }

    /// The configured raw-store root, as written (not canonicalized).
    pub fn raw_root(&self) -> Option<&Path> {
        self.raw_root.as_deref()
    }

    /// Whether `name` is one of the configured folder names (ASCII
    /// case-insensitive, like the macOS filesystem the links live on).
    pub fn is_folder_name(&self, name: &str) -> bool {
        self.names
            .iter()
            .any(|configured| configured.eq_ignore_ascii_case(name))
    }

    /// Deny side: whether a graph-relative wire path lies **inside** a
    /// local-only folder — some directory component (every component but
    /// the last) is a configured name.
    pub fn contains(&self, path: &str) -> bool {
        let components = components(path);
        components
            .split_last()
            .is_some_and(|(_, directories)| directories.iter().any(|dir| self.is_folder_name(dir)))
    }

    /// Whether a graph-relative path **is** a local-only folder or lies
    /// inside one: any component, the last included. Git exclusion uses this
    /// — Git stores a symlink as a file, so the link entry itself must match.
    pub fn covers(&self, path: &str) -> bool {
        components(path)
            .iter()
            .any(|component| self.is_folder_name(component))
    }

    /// Edit side: whether a graph-relative path lies inside local-only
    /// folders ([`Self::contains`]) that are all editable — every directory
    /// component carrying a configured name is an editable one, so a folder
    /// nested in a read-only folder stays read-only.
    pub fn editable_contains(&self, path: &str) -> bool {
        let components = components(path);
        let Some((_, directories)) = components.split_last() else {
            return false;
        };
        let mut configured = directories
            .iter()
            .filter(|directory| self.is_folder_name(directory))
            .peekable();
        configured.peek().is_some() && configured.all(|directory| self.is_editable_name(directory))
    }

    /// Whether a graph-relative path names a local-only folder itself (its
    /// last component is a configured name): the link or directory, which
    /// is never an edit target.
    pub fn is_folder_entry(&self, path: &str) -> bool {
        components(path)
            .last()
            .is_some_and(|last| self.is_folder_name(last))
    }

    /// The local-only folder a path lies in ([`Self::contains`]): the path
    /// through its innermost directory component carrying a configured name,
    /// spelled as requested, with empty and `.` segments dropped
    /// (`finance//secure/sub/x.md` → `finance/secure`). `None` outside every
    /// local-only folder. Its attachments go to `<folder>/assets/`.
    pub fn folder_root(&self, path: &str) -> Option<String> {
        let components = components(path);
        let (_, directories) = components.split_last()?;
        let innermost = directories
            .iter()
            .rposition(|directory| self.is_folder_name(directory))?;
        Some(directories[..=innermost].join("/"))
    }

    /// Why the raw-store root cannot serve `graph_root`, or `None` when it
    /// can: it must be an existing directory that neither contains the graph
    /// nor lies inside it (a raw root of `$HOME` would let a link expose any
    /// folder beside the graph).
    pub fn raw_root_problem(&self, graph_root: &Path) -> Option<&'static str> {
        let Some(raw_root) = self.raw_root.as_deref() else {
            return Some("no absolute rawRoot is configured");
        };
        let Ok(raw_root) = fs::canonicalize(raw_root) else {
            return Some("rawRoot does not exist (is the drive mounted?)");
        };
        if !raw_root.is_dir() {
            return Some("rawRoot is not a folder");
        }
        let graph = fs::canonicalize(graph_root).ok()?;
        if graph.starts_with(&raw_root) || raw_root.starts_with(&graph) {
            return Some("rawRoot must not contain the graph or lie inside it");
        }
        None
    }

    /// Allow side: the canonical directory a graph-relative `link` resolves
    /// to, or `None` unless `link` is an allowed local-only link — its last
    /// component carries a configured name and is a symlink, every component
    /// above it is a real directory, the raw-store root is usable for this
    /// graph ([`Self::raw_root_problem`]), and the target is a directory under
    /// that root.
    ///
    /// Resolved fresh on every call (never cached): a retargeted link is
    /// re-validated before the next read.
    pub fn link_target(&self, graph_root: &Path, link: &Path) -> Option<PathBuf> {
        if self.raw_root_problem(graph_root).is_some() {
            return None;
        }
        let raw_root = fs::canonicalize(self.raw_root.as_deref()?).ok()?;
        let name = link.file_name()?.to_str()?;
        if !self.is_folder_name(name) {
            return None;
        }
        let mut current = graph_root.to_path_buf();
        let mut parts = link
            .components()
            .filter(|component| !matches!(component, Component::CurDir))
            .peekable();
        while let Some(component) = parts.next() {
            let Component::Normal(part) = component else {
                return None;
            };
            current.push(part);
            let kind = fs::symlink_metadata(&current).ok()?.file_type();
            let acceptable = if parts.peek().is_some() {
                kind.is_dir()
            } else {
                kind.is_symlink()
            };
            if !acceptable {
                return None;
            }
        }
        // The raw root and the graph are disjoint (checked above), so a
        // target under the raw root can be neither inside nor above the graph.
        let target = fs::canonicalize(&current).ok()?;
        (target.is_dir() && target.starts_with(&raw_root)).then_some(target)
    }
}

/// A path's meaningful components: `/`-separated, with empty and `.`
/// segments skipped so `./a//b` and `a/b` classify alike.
fn components(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|component| !component.is_empty() && *component != ".")
        .collect()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use serde::Deserialize;

    use super::{folder_name_problem, LocalOnlyFolders};

    #[derive(Deserialize)]
    struct Fixture {
        folders: Vec<String>,
        cases: Vec<FixtureCase>,
    }

    #[derive(Deserialize)]
    struct FixtureCase {
        path: String,
        #[serde(rename = "localOnly")]
        local_only: bool,
    }

    #[test]
    fn shared_fixture_corpus_matches_rust_policy() {
        let raw = include_str!("../../../fixtures/local-only-paths.json");
        let fixture: Fixture = serde_json::from_str(raw).expect("valid fixture corpus");
        let folders = LocalOnlyFolders::new(&fixture.folders, None).expect("folders");
        for case in fixture.cases {
            assert_eq!(
                folders.contains(&case.path),
                case.local_only,
                "{}",
                case.path
            );
        }
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EditableFixture {
        folders: Vec<String>,
        editable: Vec<String>,
        cases: Vec<EditableCase>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct EditableCase {
        path: String,
        local_only: bool,
        editable: bool,
        folder_entry: bool,
        folder_root: Option<String>,
    }

    #[test]
    fn shared_editable_fixture_matches_rust_policy() {
        let raw = include_str!("../../../fixtures/local-only-editable.json");
        let fixture: EditableFixture = serde_json::from_str(raw).expect("valid fixture corpus");
        let (folders, rejected) = LocalOnlyFolders::new(&fixture.folders, None)
            .expect("folders")
            .with_editable(&fixture.editable);
        assert!(rejected.is_empty(), "{rejected:?}");
        for case in fixture.cases {
            let path = case.path.as_str();
            assert_eq!(folders.contains(path), case.local_only, "contains {path}");
            assert_eq!(
                folders.editable_contains(path),
                case.editable,
                "editable {path}"
            );
            assert_eq!(
                folders.is_folder_entry(path),
                case.folder_entry,
                "folder entry {path}"
            );
            assert_eq!(
                folders.folder_root(path),
                case.folder_root,
                "folder root {path}"
            );
        }
    }

    #[test]
    fn nothing_is_editable_until_granted_and_only_configured_names_can_be() {
        let fresh = LocalOnlyFolders::new(["secure", "archive"], None).expect("folders");
        let recorded = LocalOnlyFolders::recorded(["secure", "archive"], None).expect("folders");
        for folders in [&fresh, &recorded] {
            assert!(folders.editable_names().is_empty());
            assert!(!folders.editable_contains("finance/secure/x.md"));
        }

        let (granted, rejected) = fresh.with_editable(["SECURE", "secure", "raw", "secured"]);
        assert_eq!(granted.editable_names(), ["secure"]);
        assert_eq!(rejected, ["raw", "secured"]);
        assert!(granted.is_editable_name("Secure"));
        assert!(!granted.is_editable_name("archive"));
        assert!(granted.editable_contains("finance/secure/x.md"));
        // The grant changes nothing on the deny side.
        assert!(granted.contains("archive/x.md"));
        assert!(granted.covers("finance/secure"));

        let revoked = granted.without_editable();
        assert!(revoked.editable_names().is_empty());
        assert!(!revoked.editable_contains("finance/secure/x.md"));
        assert!(revoked.contains("finance/secure/x.md"));
    }

    #[test]
    fn invalid_names_drop_and_duplicates_fold() {
        assert_eq!(folder_name_problem("secure"), None);
        assert_eq!(folder_name_problem("Private Stuff"), None);
        for invalid in ["", ".hidden", "a/b", "a\\b", "tab\tname"] {
            assert!(folder_name_problem(invalid).is_some(), "{invalid:?}");
        }
        let folders =
            LocalOnlyFolders::new(["secure", "SECURE", ".git", "raw"], None).expect("folders");
        assert_eq!(folders.names(), ["secure", "raw"]);
        assert!(LocalOnlyFolders::new(["", "../x"], None).is_none());
    }

    #[test]
    fn names_must_be_plain_ascii_and_never_a_managed_root() {
        // APFS folds Unicode case and normalization, so these would alias
        // folders no lexical rule could match exactly.
        for non_ascii in ["\u{17f}ecure", "caf\u{e9}", "cafe\u{301}", "\u{212a}eys"] {
            assert_eq!(
                folder_name_problem(non_ascii),
                Some("it must be plain ASCII"),
                "{non_ascii:?}"
            );
        }
        for reserved in ["daily", "NOTES", "Templates", "assets", "audio-memos"] {
            assert_eq!(
                folder_name_problem(reserved),
                Some("Reflect manages that folder itself"),
                "{reserved}"
            );
        }
        assert!(LocalOnlyFolders::new(["daily", "caf\u{e9}"], None).is_none());
    }

    #[test]
    fn recorded_names_are_kept_even_when_todays_rules_refuse_them() {
        // Control: a fresh configuration drops them.
        assert!(LocalOnlyFolders::new(["daily", "caf\u{e9}"], None).is_none());
        let recorded =
            LocalOnlyFolders::recorded(["daily", "caf\u{e9}", "", "DAILY"], None).expect("kept");
        assert_eq!(recorded.names(), ["daily", "caf\u{e9}"]);
        assert!(recorded.contains("daily/2026-07-04.md"));
        assert!(recorded.contains("people/caf\u{e9}/visa.md"));
        assert!(LocalOnlyFolders::recorded([""], None).is_none());
    }

    #[test]
    fn covers_matches_the_folder_entry_itself() {
        let folders = LocalOnlyFolders::new(["secure"], None).expect("folders");
        assert!(folders.covers("finance/secure"));
        assert!(folders.covers("finance/secure/x.md"));
        assert!(!folders.contains("finance/secure"));
        assert!(!folders.covers("finance/secured/x.md"));
    }

    #[test]
    fn a_relative_raw_root_leaves_only_the_deny_side() {
        let folders =
            LocalOnlyFolders::new(["secure"], Some(Path::new("relative/raw"))).expect("folders");
        assert_eq!(folders.raw_root(), None);
        assert!(folders.contains("finance/secure/x.md"));
    }

    /// A graph and a raw store as sibling tempdirs, canonicalized so
    /// assertions survive macOS's `/var` → `/private/var` alias.
    struct Stores {
        _dir: tempfile::TempDir,
        graph: PathBuf,
        raw: PathBuf,
    }

    fn stores() -> Stores {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let graph = base.join("graph");
        let raw = base.join("raw");
        std::fs::create_dir_all(graph.join("finance")).unwrap();
        std::fs::create_dir_all(raw.join("finance/secure")).unwrap();
        Stores {
            _dir: dir,
            graph,
            raw,
        }
    }

    #[cfg(unix)]
    #[test]
    fn link_target_accepts_only_a_named_link_into_the_raw_store() {
        use std::os::unix::fs::symlink;
        let stores = stores();
        let folders = LocalOnlyFolders::new(["secure"], Some(&stores.raw)).expect("folders");
        symlink(
            stores.raw.join("finance/secure"),
            stores.graph.join("finance/secure"),
        )
        .unwrap();
        assert_eq!(
            folders.link_target(&stores.graph, Path::new("finance/secure")),
            Some(stores.raw.join("finance/secure"))
        );

        // Wrong name, a real directory, and a missing entry are not links.
        symlink(
            stores.raw.join("finance/secure"),
            stores.graph.join("finance/other"),
        )
        .unwrap();
        std::fs::create_dir_all(stores.graph.join("notes/secure")).unwrap();
        for rel in ["finance/other", "notes/secure", "missing/secure"] {
            assert_eq!(
                folders.link_target(&stores.graph, Path::new(rel)),
                None,
                "{rel}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn link_target_refuses_targets_outside_the_raw_store_or_inside_the_graph() {
        use std::os::unix::fs::symlink;
        let stores = stores();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(stores.graph.join("notes")).unwrap();
        std::fs::create_dir_all(stores.graph.join("people")).unwrap();
        let folders = LocalOnlyFolders::new(["secure"], Some(&stores.raw)).expect("folders");

        symlink(outside.path(), stores.graph.join("finance/secure")).unwrap();
        symlink(
            stores.graph.join("notes"),
            stores.graph.join("people/secure"),
        )
        .unwrap();
        assert_eq!(
            folders.link_target(&stores.graph, Path::new("finance/secure")),
            None
        );
        assert_eq!(
            folders.link_target(&stores.graph, Path::new("people/secure")),
            None
        );

        // A raw store configured inside the graph cannot launder an in-graph
        // directory into a local-only one.
        let inside = LocalOnlyFolders::new(["secure"], Some(&stores.graph)).expect("folders");
        assert_eq!(
            inside.link_target(&stores.graph, Path::new("people/secure")),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn link_target_refuses_a_link_behind_a_symlinked_parent() {
        use std::os::unix::fs::symlink;
        let stores = stores();
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(elsewhere.path().join("finance")).unwrap();
        symlink(
            stores.raw.join("finance/secure"),
            elsewhere.path().join("finance/secure"),
        )
        .unwrap();
        symlink(elsewhere.path().join("finance"), stores.graph.join("money")).unwrap();
        let folders = LocalOnlyFolders::new(["secure"], Some(&stores.raw)).expect("folders");
        assert_eq!(
            folders.link_target(&stores.graph, Path::new("money/secure")),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_raw_root_overlapping_the_graph_grants_nothing() {
        use std::os::unix::fs::symlink;
        let stores = stores();
        symlink(
            stores.raw.join("finance/secure"),
            stores.graph.join("finance/secure"),
        )
        .unwrap();
        // `$HOME`-style: the raw root contains the graph, so a link could
        // expose any folder beside it.
        let home = stores.graph.parent().unwrap().to_path_buf();
        let containing = LocalOnlyFolders::new(["secure"], Some(&home)).expect("folders");
        assert_eq!(
            containing.raw_root_problem(&stores.graph),
            Some("rawRoot must not contain the graph or lie inside it")
        );
        assert_eq!(
            containing.link_target(&stores.graph, Path::new("finance/secure")),
            None
        );
        let inside = LocalOnlyFolders::new(["secure"], Some(&stores.graph.join("finance")))
            .expect("folders");
        assert!(inside.raw_root_problem(&stores.graph).is_some());
        // Control: the disjoint raw store grants the hop.
        let disjoint = LocalOnlyFolders::new(["secure"], Some(&stores.raw)).expect("folders");
        assert_eq!(disjoint.raw_root_problem(&stores.graph), None);
        assert!(disjoint
            .link_target(&stores.graph, Path::new("finance/secure"))
            .is_some());
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_file_is_not_a_folder() {
        use std::os::unix::fs::symlink;
        let stores = stores();
        std::fs::write(stores.raw.join("finance/ledger.md"), "# Ledger").unwrap();
        symlink(
            stores.raw.join("finance/ledger.md"),
            stores.graph.join("finance/secure"),
        )
        .unwrap();
        let folders = LocalOnlyFolders::new(["secure"], Some(&stores.raw)).expect("folders");
        assert_eq!(
            folders.link_target(&stores.graph, Path::new("finance/secure")),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn link_target_needs_a_reachable_raw_store() {
        use std::os::unix::fs::symlink;
        let stores = stores();
        symlink(
            stores.raw.join("finance/secure"),
            stores.graph.join("finance/secure"),
        )
        .unwrap();
        let unmounted = LocalOnlyFolders::new(["secure"], Some(&stores.raw.join("not-mounted")))
            .expect("folders");
        assert_eq!(
            unmounted.link_target(&stores.graph, Path::new("finance/secure")),
            None
        );
        let deny_only = LocalOnlyFolders::new(["secure"], None).expect("folders");
        assert_eq!(
            deny_only.link_target(&stores.graph, Path::new("finance/secure")),
            None
        );
    }
}
