//! Local-only folders: named folders (usually symlinks into a "raw store"
//! outside the graph) whose notes the desktop reads on this machine but never
//! syncs, sends, publishes, or writes.
//!
//! - **Deny side** ([`LocalOnlyFolders::contains`], [`LocalOnlyFolders::covers`]):
//!   lexical rules over the configured names, in force even while a link
//!   dangles. Names are ASCII-only, so ASCII case-insensitive matching is
//!   exact; callers that touch the disk also check the entry a path resolves
//!   to, because APFS folds Unicode case (`ſecure` opens `secure`).
//! - **Allow side** ([`LocalOnlyFolders::link_target`]): one symlink hop into a
//!   validated target; nothing inside it is followed further.
//!
//! The path predicate is shared with `isLocalOnlyPath` in `packages/core`
//! through `fixtures/local-only-paths.json`.

use std::fs;
use std::path::{Component, Path, PathBuf};

/// One graph's local-only folder configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalOnlyFolders {
    names: Vec<String>,
    /// The configured raw-store root (absolute). Canonicalized at every
    /// check, so a store mounted after the graph opened still resolves.
    raw_root: Option<PathBuf>,
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
    /// leaving only the deny side active.
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
        })
    }

    /// [`Self::new`] for names a graph's index recorded at an earlier open:
    /// every non-empty name is kept, even one today's [`folder_name_problem`]
    /// rules would refuse (a name recorded before a rule existed). Dropping
    /// it would turn its folder public; keeping it fails closed until the
    /// user releases it. Duplicates still fold.
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
        })
    }

    /// The configured folder names, as written.
    pub fn names(&self) -> &[String] {
        &self.names
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
