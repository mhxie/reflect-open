//! Path resolution + the path-traversal guard.
//!
//! All frontend-supplied paths are **graph-relative**; this module is the only
//! way they become absolute paths. Two layers keep them inside the graph root:
//! a lexical check ([`ensure_relative`]) rejecting absolute/`..` paths, and a
//! symlink-aware check ([`resolve`]) canonicalizing the deepest existing
//! ancestor so a symlink planted inside the graph can't redirect IO outside it.
//!
//! Local-only folders get three more entry points. [`resolve_read`] grants
//! the one sanctioned exception, a single hop through an allowed local-only
//! link into its validated target, and reports whether the read lands in a
//! local-only folder. [`resolve_write`], the strict default, refuses every
//! write, create, delete, and move touching one: pulls, imports, captures,
//! and background passes never write there. [`resolve_note_edit`] is the one
//! door for the user's own edits (note saves, creates, deletes, moves, and
//! attachment intake): it takes the same hop into a folder whose every
//! configured name is editable, and hands back a canonical base plus the
//! rest below it for the directory-fd IO in `beneath`, which never follows a
//! link. All of them decide by the requested path **and** by the entry the
//! filesystem resolves it to: APFS folds Unicode case and normalization
//! (`ſecure` opens `secure`), and an in-graph symlink can alias a real
//! local-only folder under another name.

use std::path::{Component, Path, PathBuf};

use reflect_graph_paths::LocalOnlyFolders;

use crate::error::{AppError, AppResult};

/// Reject a relative path that is absolute, contains `..`/root components, or is
/// empty/dot-only (which would target the graph root itself). Requires at least
/// one real path segment. The primary, lexical path-traversal guard — and the
/// only applicable one for the conflict stores under `.reflect/` (shadow bases,
/// conflict archive), whose directories don't exist until first write and so
/// can't anchor the symlink-aware [`resolve`].
pub(crate) fn ensure_relative(rel: &str) -> AppResult<PathBuf> {
    let path = Path::new(rel);
    let mut has_segment = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => has_segment = true,
            Component::CurDir => {}
            _ => {
                return Err(AppError::traversal(format!(
                    "path escapes the graph root: {rel}"
                )))
            }
        }
    }
    if !has_segment {
        return Err(AppError::traversal(format!(
            "path must point to a file inside the graph, got: {rel:?}"
        )));
    }
    Ok(path.to_path_buf())
}

/// The deepest existing ancestor of `path` (the path itself if it exists).
fn existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path;
    loop {
        if current.exists() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => current = parent,
            _ => return path.to_path_buf(),
        }
    }
}

/// A graph-relative path checked against the root.
struct Resolved {
    /// The path as requested, joined onto the root.
    joined: PathBuf,
    /// The canonical graph root.
    canonical_root: PathBuf,
    /// Where the filesystem puts the path, relative to the root: the deepest
    /// existing ancestor's canonical form (on-disk case and normalization,
    /// symlinks resolved), then the not-yet-existing remainder as requested.
    on_disk: String,
}

fn resolve_checked(root: &Path, rel: &str) -> AppResult<Resolved> {
    let rel_path = ensure_relative(rel)?;
    let joined = root.join(&rel_path);
    let canonical_root = root.canonicalize()?;
    let existing = existing_ancestor(&joined);
    let anchor = existing.canonicalize()?;
    let Ok(anchor_rel) = anchor.strip_prefix(&canonical_root) else {
        return Err(AppError::traversal(format!(
            "path resolves outside the graph: {rel:?}"
        )));
    };
    let remainder = joined.strip_prefix(&existing).unwrap_or(Path::new(""));
    Ok(Resolved {
        on_disk: slash_path(&anchor_rel.join(remainder)),
        joined,
        canonical_root,
    })
}

/// `path`'s normal components joined with `/` (lossy: a non-UTF-8 name can
/// never equal an ASCII folder name anyway).
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

/// Resolve a graph-relative path to an absolute path **inside** `root`. Beyond
/// the lexical guard, this canonicalizes the deepest existing ancestor and
/// verifies it stays under the canonicalized root, so a symlink inside the graph
/// can't redirect reads/writes outside it.
pub(crate) fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    Ok(resolve_checked(root, rel)?.joined)
}

/// [`resolve`] for a write, create, delete, or move: additionally refuses a
/// path that is, or lies inside, a local-only folder, whether it says so
/// itself or the filesystem resolves it into one. A symlinked folder never
/// gets this far ([`resolve`] refuses the escape); this covers real
/// directories carrying a configured name, and aliases of them.
pub(crate) fn resolve_write(
    root: &Path,
    rel: &str,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<PathBuf> {
    let resolved = resolve_checked(root, rel)?;
    if let Some(folders) = local_only {
        if folders.covers(rel) || folders.covers(&resolved.on_disk) {
            return Err(AppError::traversal(format!(
                "local-only folders are read-only: {rel}"
            )));
        }
    }
    Ok(resolved.joined)
}

/// [`resolve`] for bytes about to leave this machine (AI, transcription,
/// asset description) or to land in an ordinary note (on-device
/// transcription): refuses anything in a local-only folder, decided like
/// [`resolve_write`].
pub(crate) fn resolve_shareable(
    root: &Path,
    rel: &str,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<PathBuf> {
    let target = resolve_read(root, rel, local_only)?;
    if target.local_only {
        return Err(AppError::traversal(format!(
            "local-only notes and files never leave this machine: {rel}"
        )));
    }
    Ok(target.path())
}

/// Whether the entry `rel` names is, or lies in, a local-only folder, or lies
/// beyond a symlink that leaves the graph: the guard for the passes that
/// work on listed entries (Git staging and checkout, the iCloud sweep). The
/// entry itself is never followed (a symlink is a file to Git, and libgit2
/// replaces an entry rather than writing through it): its name is matched
/// lexically, plus any local-only entry it aliases on a folding filesystem,
/// and its parent directories as the filesystem resolves them. Fails closed.
pub(crate) fn entry_is_local_only(root: &Path, rel: &str, folders: &LocalOnlyFolders) -> bool {
    if folders.covers(rel) {
        return true;
    }
    let Ok(rel_path) = ensure_relative(rel) else {
        return true;
    };
    if aliases_a_local_only_entry(&root.join(&rel_path), folders) {
        return true;
    }
    match rel_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        Some(parent) => match resolve_checked(root, &parent.to_string_lossy()) {
            Ok(resolved) => folders.covers(&resolved.on_disk),
            Err(_) => true,
        },
        None => false,
    }
}

/// Whether `path`'s final component is a spelling the filesystem folds onto
/// a local-only entry beside it (`ſecure` for `secure`). Only a non-ASCII
/// name can: configured names are ASCII, and ASCII case is matched
/// lexically. Decided by identity (same inode), so an ordinary non-ASCII
/// name stored in another normalization form is never mistaken for one.
fn aliases_a_local_only_entry(path: &Path, folders: &LocalOnlyFolders) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let (Some(name), Some(parent)) = (path.file_name(), path.parent()) else {
            return false;
        };
        if name.to_str().is_some_and(str::is_ascii) {
            return false;
        }
        let Ok(entry) = std::fs::symlink_metadata(path) else {
            return false;
        };
        folders.names().iter().any(|configured| {
            std::fs::symlink_metadata(parent.join(configured))
                .is_ok_and(|other| other.dev() == entry.dev() && other.ino() == entry.ino())
        })
    }
    #[cfg(not(unix))]
    {
        let _ = (path, folders);
        false
    }
}

/// Where a read lands.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ReadTarget {
    /// Canonical, symlink-free directory the no-follow open starts from: the
    /// graph root, or a local-only link's validated target.
    pub(crate) base: PathBuf,
    /// The path below `base`, as requested; the no-follow open refuses a
    /// symlink at any component of `base.join(rest)`.
    pub(crate) rest: PathBuf,
    /// The entry lies in a local-only folder: through a link, or in a real
    /// directory whose on-disk name (or requested name) is configured.
    pub(crate) local_only: bool,
}

impl ReadTarget {
    /// The physical file to read.
    pub(crate) fn path(&self) -> PathBuf {
        self.base.join(&self.rest)
    }

    /// Open the file for reading. A local-only entry opens from its
    /// raw-store directory with every component below it policed
    /// (`io::open_no_follow`); anything else opens the ordinary way, already
    /// vetted by the symlink-aware guard that produced this target.
    pub(crate) fn open(&self) -> std::io::Result<std::fs::File> {
        if self.local_only {
            super::io::open_no_follow(&self.base, &self.rest)
        } else {
            std::fs::File::open(self.path())
        }
    }
}

/// Resolve a graph-relative path for a **read**: [`resolve`], except that a
/// path through an allowed local-only link resolves one hop into the link's
/// canonical target, refusing any symlink below it. The target is
/// re-validated on every call, so a retargeted link never keeps a stale
/// grant. Never use this for a write.
pub(crate) fn resolve_read(
    root: &Path,
    rel: &str,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<ReadTarget> {
    if let Some(folders) = local_only {
        if let Some(target) = local_only_read_target(root, rel, folders)? {
            return Ok(target);
        }
    }
    let resolved = resolve_checked(root, rel)?;
    Ok(ReadTarget {
        local_only: local_only
            .is_some_and(|folders| folders.covers(rel) || folders.covers(&resolved.on_disk)),
        base: resolved.canonical_root,
        rest: ensure_relative(rel)?,
    })
}

/// The read target through the first allowed local-only link on `rel`'s
/// directory components, or `None` when the path crosses none (a real
/// directory carrying a configured name resolves the ordinary way).
fn local_only_read_target(
    root: &Path,
    rel: &str,
    folders: &LocalOnlyFolders,
) -> AppResult<Option<ReadTarget>> {
    let rel = ensure_relative(rel)?;
    Ok(local_only_hop(root, &rel, folders)?.map(|hop| ReadTarget {
        base: hop.target,
        rest: hop.rest,
        local_only: true,
    }))
}

/// One sanctioned hop through a local-only link.
struct Hop {
    /// The link's graph-relative path, as requested.
    link: PathBuf,
    /// The link's validated canonical target, under the raw-store root.
    target: PathBuf,
    /// The path below the link, as requested; no existing component of it
    /// is a symlink.
    rest: PathBuf,
}

/// The hop through the first allowed local-only link on `rel`'s directory
/// components, or `None` when the path crosses none. The link is re-validated
/// on every call ([`LocalOnlyFolders::link_target`]), so a retargeted link
/// never keeps a stale grant, and nothing below it may be a symlink.
fn local_only_hop(root: &Path, rel: &Path, folders: &LocalOnlyFolders) -> AppResult<Option<Hop>> {
    let parts = normal_parts(rel);
    let mut link = PathBuf::new();
    for (index, part) in parts.iter().enumerate().take(parts.len().saturating_sub(1)) {
        link.push(part);
        if !part
            .to_str()
            .is_some_and(|name| folders.is_folder_name(name))
        {
            continue;
        }
        let Some(target) = folders.link_target(root, &link) else {
            continue;
        };
        let rest: PathBuf = parts[index + 1..].iter().collect();
        ensure_no_symlinks_below(&target, &rest)?;
        return Ok(Some(Hop { link, target, rest }));
    }
    Ok(None)
}

/// `rel`'s plain components (`.` dropped); callers have already refused
/// anything else ([`ensure_relative`]).
fn normal_parts(rel: &Path) -> Vec<&std::ffi::OsStr> {
    rel.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect()
}

/// What an edit writes, which decides the name rule inside a local-only
/// folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TargetKind {
    /// The note at the path: inside a local-only folder only `.md` names.
    Note,
    /// An attachment for the note at the path: it lands in that note's
    /// local-only folder (`<folder>/assets/`), never at the path itself, so
    /// the `.md` rule does not apply.
    Attachment,
}

/// Where a user edit lands ([`resolve_note_edit`]).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EditTarget {
    /// An ordinary path, absolute and vetted exactly like [`resolve_write`]:
    /// the graph's usual atomic IO applies.
    Graph(PathBuf),
    /// A path inside editable local-only folders: only the directory-fd IO
    /// in `beneath` touches it.
    LocalOnly(LocalOnlyEntry),
}

/// A path inside editable local-only folders, split for the no-follow walk.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct LocalOnlyEntry {
    /// The canonical graph root: where `.reflect/` (staging, trash,
    /// recovery) is walked from.
    pub(crate) graph_root: PathBuf,
    /// Canonical, symlink-free directory the walk starts from: a local-only
    /// link's validated target, or the canonical graph root for a real
    /// local-only directory.
    pub(crate) base: PathBuf,
    /// The path below `base`, as requested; the walk refuses a symlink, a
    /// non-directory, or a Git work tree at any directory of it.
    pub(crate) rest: PathBuf,
    /// The graph-relative local-only folder the path lies in
    /// ([`LocalOnlyFolders::folder_root`]), spelled as requested.
    pub(crate) folder_root: String,
    /// `folder_root` below `base` (empty when the folder is the link
    /// itself): where the folder's own files, such as `assets/`, go.
    pub(crate) folder_dir: PathBuf,
}

/// Resolve a graph-relative path for a **user edit** (a note save, create,
/// delete, or move, or attachment intake for the note at the path).
///
/// Without local-only folders this is [`resolve`]. A path outside them
/// resolves exactly like [`resolve_write`] ([`EditTarget::Graph`]), which
/// also refuses one the filesystem resolves into a local-only folder (an
/// alias or folded spelling). A path inside them is [`EditTarget::LocalOnly`]
/// only when all of these hold, and refused otherwise:
///
/// - it is not the folder entry itself, and no component is hidden;
/// - a note ([`TargetKind::Note`]) has a `.md` name (ASCII case-insensitive);
/// - every configured name on it is editable, both as requested and as the
///   filesystem spells the existing part of it, so a folded spelling of a
///   read-only folder never passes as an editable one;
/// - through a link, the link is allowed ([`LocalOnlyFolders::link_target`],
///   re-validated on every call), nothing below it is a symlink, and no
///   directory from the raw-store root down to the link's target holds a
///   `.git` entry (the IO checks every directory below the target the same
///   way);
/// - in a real directory, the path stays inside the graph and crosses no
///   symlink;
/// - the local-only folder it lies in exists: an edit creates notes and
///   directories inside a local-only folder, never the folder itself (a
///   save after its link went missing must not quietly start a new folder
///   in the graph).
pub(crate) fn resolve_note_edit(
    root: &Path,
    rel: &str,
    local_only: Option<&LocalOnlyFolders>,
    kind: TargetKind,
) -> AppResult<EditTarget> {
    let Some(folders) = local_only else {
        return Ok(EditTarget::Graph(resolve(root, rel)?));
    };
    let rel_path = ensure_relative(rel)?;
    if folders.is_folder_entry(rel) {
        return Err(AppError::traversal(format!(
            "a local-only folder itself is never edited: {rel}"
        )));
    }
    if !folders.contains(rel) {
        return Ok(EditTarget::Graph(resolve_write(root, rel, Some(folders))?));
    }
    let parts = normal_parts(&rel_path);
    if parts
        .iter()
        .any(|part| part.as_encoded_bytes().starts_with(b"."))
    {
        return Err(AppError::traversal(format!(
            "hidden names are never edited in a local-only folder: {rel}"
        )));
    }
    if kind == TargetKind::Note
        && !rel_path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err(AppError::traversal(format!(
            "only .md notes are edited in a local-only folder: {rel}"
        )));
    }
    if !folders.editable_contains(rel) {
        return Err(read_only(rel));
    }
    let folder_root = folders.folder_root(rel).ok_or_else(|| read_only(rel))?;
    let entry = match local_only_hop(root, &rel_path, folders)? {
        Some(hop) => {
            let graph_root = root.canonicalize()?;
            if !folders.editable_contains(&on_disk_through(&graph_root, root, &hop)?) {
                return Err(read_only(rel));
            }
            ensure_outside_git_work_trees(folders, &hop.target)?;
            let folder_dir = Path::new(&folder_root)
                .components()
                .skip(hop.link.components().count())
                .collect();
            LocalOnlyEntry {
                graph_root,
                base: hop.target,
                rest: hop.rest,
                folder_root,
                folder_dir,
            }
        }
        None => {
            let resolved = resolve_checked(root, rel)?;
            let rest: PathBuf = parts.iter().collect();
            ensure_no_symlinks_below(&resolved.canonical_root, &rest)?;
            if !folders.editable_contains(&resolved.on_disk) {
                return Err(read_only(rel));
            }
            LocalOnlyEntry {
                graph_root: resolved.canonical_root.clone(),
                base: resolved.canonical_root,
                rest,
                folder_dir: PathBuf::from(&folder_root),
                folder_root,
            }
        }
    };
    // Nothing on the way is a symlink (checked above), so this sees the
    // folder itself.
    if !std::fs::symlink_metadata(entry.base.join(&entry.folder_dir))
        .is_ok_and(|meta| meta.is_dir())
    {
        return Err(AppError::traversal(format!(
            "the local-only folder {} does not exist",
            entry.folder_root
        )));
    }
    Ok(EditTarget::LocalOnly(entry))
}

fn read_only(rel: &str) -> AppError {
    AppError::traversal(format!("local-only folders are read-only: {rel}"))
}

/// The filesystem's spelling of a path through a hop, graph-relative: the
/// directories above the link (all real, [`LocalOnlyFolders::link_target`]
/// checked) and the existing part below it (no symlinks, checked) canonicalize
/// to their on-disk names; the link keeps its requested name, and anything
/// not yet created stays as requested.
fn on_disk_through(graph_root: &Path, root: &Path, hop: &Hop) -> AppResult<String> {
    let outside = || AppError::traversal("path resolves outside its folder");
    let above = match hop.link.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => root
            .join(parent)
            .canonicalize()?
            .strip_prefix(graph_root)
            .map_err(|_| outside())?
            .to_path_buf(),
        _ => PathBuf::new(),
    };
    let link_name = hop.link.file_name().ok_or_else(outside)?;
    let joined = hop.target.join(&hop.rest);
    let existing = existing_ancestor(&joined);
    let anchor = existing.canonicalize()?;
    let below = anchor.strip_prefix(&hop.target).map_err(|_| outside())?;
    let remainder = joined.strip_prefix(&existing).unwrap_or(Path::new(""));
    Ok(slash_path(
        &above.join(link_name).join(below).join(remainder),
    ))
}

/// Refuse an edit through a link when any directory from the raw-store root
/// down to the link's `target` (both included) holds a `.git` entry: a note
/// inside a nested work tree could leave the Mac through that repository's
/// remote. A directory or a `gitdir:` file counts alike, and nothing is
/// followed.
fn ensure_outside_git_work_trees(folders: &LocalOnlyFolders, target: &Path) -> AppResult<()> {
    let refused = || AppError::traversal("local-only link outside its raw store");
    let raw_root = folders.raw_root().ok_or_else(refused)?.canonicalize()?;
    let below = target.strip_prefix(&raw_root).map_err(|_| refused())?;
    let mut current = raw_root.clone();
    let mut directories = vec![current.clone()];
    for component in below.components() {
        current.push(component);
        directories.push(current.clone());
    }
    for directory in directories {
        match std::fs::symlink_metadata(directory.join(".git")) {
            Ok(_) => {
                return Err(AppError::traversal(format!(
                    "local-only notes inside a Git work tree are never edited: {}",
                    directory.display()
                )))
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

/// Refuse when any existing component of `rest` below `base` is a symlink:
/// inside a raw store nothing is followed past the one sanctioned hop.
fn ensure_no_symlinks_below(base: &Path, rest: &Path) -> AppResult<()> {
    let mut current = base.to_path_buf();
    for component in rest.components() {
        current.push(component);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(AppError::traversal(format!(
                    "symlink inside a local-only folder: {}",
                    rest.display()
                )))
            }
            Ok(_) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(err) => return Err(err.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::io::bootstrap;
    use tempfile::tempdir;

    #[test]
    fn rejects_path_traversal() {
        assert!(ensure_relative("../secret").is_err());
        assert!(ensure_relative("/etc/passwd").is_err());
        assert!(ensure_relative("notes/../../escape.md").is_err());
        assert!(ensure_relative("notes/ok.md").is_ok());
        assert!(ensure_relative("./daily/2026-06-09.md").is_ok());
    }

    #[test]
    fn rejects_empty_and_dot_only_paths() {
        // These would otherwise resolve to the graph root itself.
        assert!(ensure_relative("").is_err());
        assert!(ensure_relative(".").is_err());
        assert!(ensure_relative("./.").is_err());
    }

    #[test]
    fn resolve_accepts_in_graph_path() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        assert!(resolve(dir.path(), "notes/ok.md").is_ok());
    }

    /// A graph and a raw store side by side (canonicalized: macOS `/var` →
    /// `/private/var`), with `finance/secure` linked into the store.
    #[cfg(unix)]
    struct Linked {
        _dir: tempfile::TempDir,
        graph: PathBuf,
        raw: PathBuf,
        folders: LocalOnlyFolders,
    }

    #[cfg(unix)]
    fn linked() -> Linked {
        use std::os::unix::fs::symlink;
        let dir = tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let graph = base.join("graph");
        let raw = base.join("raw");
        bootstrap(&graph).unwrap();
        std::fs::create_dir_all(graph.join("finance")).unwrap();
        std::fs::create_dir_all(raw.join("finance/secure/sub")).unwrap();
        std::fs::write(raw.join("finance/secure/sub/bank.md"), "# Bank").unwrap();
        symlink(raw.join("finance/secure"), graph.join("finance/secure")).unwrap();
        let folders = LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap();
        Linked {
            _dir: dir,
            graph,
            raw,
            folders,
        }
    }

    #[cfg(unix)]
    #[test]
    fn reads_take_one_hop_through_an_allowed_local_only_link() {
        let linked = linked();
        let target = resolve_read(
            &linked.graph,
            "finance/secure/sub/bank.md",
            Some(&linked.folders),
        )
        .unwrap();
        assert_eq!(
            target,
            ReadTarget {
                base: linked.raw.join("finance/secure"),
                rest: PathBuf::from("sub/bank.md"),
                local_only: true,
            }
        );
        assert_eq!(target.path(), linked.raw.join("finance/secure/sub/bank.md"));
        // Without the configuration the ordinary guard refuses the escape,
        // and writes never get the hop at all.
        assert!(resolve_read(&linked.graph, "finance/secure/sub/bank.md", None).is_err());
        assert!(resolve(&linked.graph, "finance/secure/new.md").is_err());
        // Ordinary paths resolve exactly as before, from the canonical root.
        let plain = resolve_read(&linked.graph, "notes/a.md", Some(&linked.folders)).unwrap();
        assert_eq!(plain.path(), linked.graph.join("notes/a.md"));
        assert!(!plain.local_only);
    }

    #[cfg(unix)]
    #[test]
    fn a_retargeted_link_loses_its_grant_on_the_next_read() {
        use std::os::unix::fs::symlink;
        let linked = linked();
        let rel = "finance/secure/sub/bank.md";
        assert!(resolve_read(&linked.graph, rel, Some(&linked.folders)).is_ok());
        let outside = tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("sub")).unwrap();
        std::fs::write(outside.path().join("sub/bank.md"), "# Elsewhere").unwrap();
        std::fs::remove_file(linked.graph.join("finance/secure")).unwrap();
        symlink(outside.path(), linked.graph.join("finance/secure")).unwrap();
        assert!(resolve_read(&linked.graph, rel, Some(&linked.folders)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn nothing_inside_the_raw_store_is_followed_past_the_hop() {
        use std::os::unix::fs::symlink;
        let linked = linked();
        let elsewhere = tempdir().unwrap();
        std::fs::write(elsewhere.path().join("leak.md"), "# Leak").unwrap();
        symlink(elsewhere.path(), linked.raw.join("finance/secure/alias")).unwrap();
        assert!(resolve_read(
            &linked.graph,
            "finance/secure/alias/leak.md",
            Some(&linked.folders)
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_named_link_outside_the_raw_store_gets_no_hop() {
        use std::os::unix::fs::symlink;
        let linked = linked();
        let outside = tempdir().unwrap();
        std::fs::write(outside.path().join("x.md"), "# Outside").unwrap();
        std::fs::create_dir_all(linked.graph.join("people")).unwrap();
        symlink(outside.path(), linked.graph.join("people/secure")).unwrap();
        assert!(resolve_read(&linked.graph, "people/secure/x.md", Some(&linked.folders)).is_err());
    }

    /// `linked()`'s configuration with `names` editable.
    #[cfg(unix)]
    fn editable(linked: &Linked, names: &[&str]) -> LocalOnlyFolders {
        linked.folders.clone().with_editable(names).0
    }

    #[cfg(unix)]
    fn edit(linked: &Linked, rel: &str, folders: &LocalOnlyFolders) -> AppResult<EditTarget> {
        resolve_note_edit(&linked.graph, rel, Some(folders), TargetKind::Note)
    }

    #[cfg(unix)]
    fn local_only_entry(target: AppResult<EditTarget>) -> LocalOnlyEntry {
        match target {
            Ok(EditTarget::LocalOnly(entry)) => entry,
            other => panic!("expected a local-only edit target, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_edit_takes_one_hop_into_an_editable_link() {
        let linked = linked();
        let folders = editable(&linked, &["secure"]);
        let entry = local_only_entry(edit(&linked, "finance/secure/sub/bank.md", &folders));
        assert_eq!(
            entry,
            LocalOnlyEntry {
                graph_root: linked.graph.clone(),
                base: linked.raw.join("finance/secure"),
                rest: PathBuf::from("sub/bank.md"),
                folder_root: "finance/secure".into(),
                folder_dir: PathBuf::new(),
            }
        );
        // A note that does not exist yet.
        let created = local_only_entry(edit(&linked, "finance/secure/new.md", &folders));
        assert_eq!(created.rest, PathBuf::from("new.md"));
        // Match the lowercase configuration against an existing uppercase
        // link without relying on a case-insensitive filesystem.
        std::fs::rename(
            linked.graph.join("finance/secure"),
            linked.graph.join("finance/SECURE"),
        )
        .unwrap();
        let cased = local_only_entry(edit(&linked, "./finance/SECURE/sub/x.md", &folders));
        assert_eq!(cased.base, linked.raw.join("finance/secure"));
        assert_eq!(cased.rest, PathBuf::from("sub/x.md"));
        assert_eq!(cased.folder_root, "finance/SECURE");

        // An ordinary path resolves exactly like a strict write; no
        // configuration at all is the plain guard.
        assert_eq!(
            edit(&linked, "notes/a.md", &folders).unwrap(),
            EditTarget::Graph(resolve_write(&linked.graph, "notes/a.md", Some(&folders)).unwrap())
        );
        assert_eq!(
            resolve_note_edit(&linked.graph, "notes/a.md", None, TargetKind::Note).unwrap(),
            EditTarget::Graph(linked.graph.join("notes/a.md"))
        );
        // Control: the strict resolver still refuses every editable path.
        for rel in [
            "finance/secure/sub/bank.md",
            "finance/secure/new.md",
            "finance/SECURE/sub/x.md",
        ] {
            assert!(
                resolve_write(&linked.graph, rel, Some(&folders)).is_err(),
                "{rel}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_real_editable_folder_is_edited_from_the_graph_root() {
        let linked = linked();
        std::fs::create_dir_all(linked.graph.join("people/secure/deep")).unwrap();
        let folders = editable(&linked, &["secure"]);
        let entry = local_only_entry(edit(&linked, "people/secure/deep/visa.md", &folders));
        assert_eq!(
            entry,
            LocalOnlyEntry {
                graph_root: linked.graph.clone(),
                base: linked.graph.clone(),
                rest: PathBuf::from("people/secure/deep/visa.md"),
                folder_root: "people/secure".into(),
                folder_dir: PathBuf::from("people/secure"),
            }
        );
        assert!(
            resolve_write(&linked.graph, "people/secure/deep/visa.md", Some(&folders)).is_err()
        );
    }

    #[cfg(unix)]
    #[test]
    fn edits_refuse_read_only_folders_their_entries_and_unknown_configurations() {
        let linked = linked();
        std::fs::create_dir_all(linked.graph.join("archive/2019/secure")).unwrap();
        let folders = LocalOnlyFolders::new(["secure", "archive"], Some(&linked.raw))
            .unwrap()
            .with_editable(["secure"])
            .0;
        let refused = |rel: &str, folders: &LocalOnlyFolders| {
            assert!(edit(&linked, rel, folders).is_err(), "{rel}");
        };
        refused("archive/x.md", &folders);
        // Nested in a read-only folder: every name on the path must be editable.
        refused("archive/2019/secure/x.md", &folders);
        // The folder entry itself, whatever the spelling.
        refused("finance/secure", &folders);
        refused("finance/Secure/", &folders);
        // Read-only (the default) and unknown (editability stripped).
        refused("finance/secure/sub/bank.md", &linked.folders);
        refused(
            "finance/secure/sub/bank.md",
            &folders.clone().without_editable(),
        );

        // Control: with both names editable the nested folder opens.
        let both = folders.clone().with_editable(["secure", "archive"]).0;
        let entry = local_only_entry(edit(&linked, "archive/2019/secure/x.md", &both));
        assert_eq!(entry.folder_root, "archive/2019/secure");
        assert_eq!(entry.folder_dir, PathBuf::from("archive/2019/secure"));
    }

    #[cfg(unix)]
    #[test]
    fn edits_refuse_other_names_hidden_components_and_attachments_need_no_md() {
        let linked = linked();
        let folders = editable(&linked, &["secure"]);
        for rel in [
            "finance/secure/sub/bank.txt",
            "finance/secure/scan.png",
            "finance/secure/README",
            "finance/secure/.x.md",
            "finance/secure/.hidden/x.md",
            ".hidden/secure/x.md",
        ] {
            assert!(edit(&linked, rel, &folders).is_err(), "{rel}");
        }
        // Upper-case `.MD` is still Markdown.
        assert!(edit(&linked, "finance/secure/Note.MD", &folders).is_ok());
        // Attachment intake names a note's folder, not a note: any visible
        // name is fine, hidden ones never are.
        let attachment = |rel: &str| {
            resolve_note_edit(&linked.graph, rel, Some(&folders), TargetKind::Attachment)
        };
        assert!(attachment("finance/secure/scan.png").is_ok());
        assert!(attachment("finance/secure/.scan.png").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn edits_refuse_dangling_retargeted_and_nested_links() {
        use std::os::unix::fs::symlink;
        let linked = linked();
        let folders = editable(&linked, &["secure"]);

        // A dangling configured link.
        std::fs::create_dir_all(linked.graph.join("people")).unwrap();
        symlink(
            linked.raw.join("people/missing"),
            linked.graph.join("people/secure"),
        )
        .unwrap();
        assert!(edit(&linked, "people/secure/x.md", &folders).is_err());

        // A symlink below the hop.
        let elsewhere = tempdir().unwrap();
        symlink(elsewhere.path(), linked.raw.join("finance/secure/alias")).unwrap();
        assert!(edit(&linked, "finance/secure/alias/x.md", &folders).is_err());
        assert!(edit(&linked, "finance/secure/alias", &folders).is_err());

        // A link retargeted outside the raw store loses its grant on the
        // next call.
        let rel = "finance/secure/sub/bank.md";
        assert!(edit(&linked, rel, &folders).is_ok());
        let outside = tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("sub")).unwrap();
        std::fs::remove_file(linked.graph.join("finance/secure")).unwrap();
        symlink(outside.path(), linked.graph.join("finance/secure")).unwrap();
        assert!(edit(&linked, rel, &folders).is_err());
        assert!(!outside.path().join("sub/bank.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn edits_never_reach_an_editable_real_folder_through_an_alias_or_folded_spelling() {
        use std::os::unix::fs::symlink;
        let linked = linked();
        let folders = editable(&linked, &["secure"]);
        std::fs::create_dir_all(linked.graph.join("people/secure")).unwrap();
        std::fs::write(linked.graph.join("people/secure/visa.md"), "# Visa").unwrap();
        // An in-graph alias, plain and carrying the configured name.
        symlink(
            linked.graph.join("people/secure"),
            linked.graph.join("notes/alias"),
        )
        .unwrap();
        symlink(
            linked.graph.join("people/secure"),
            linked.graph.join("notes/secure"),
        )
        .unwrap();
        for rel in [
            "notes/alias/visa.md",
            "notes/alias/new.md",
            "notes/secure/visa.md",
        ] {
            assert!(edit(&linked, rel, &folders).is_err(), "{rel}");
        }
        // Folded spellings of the real folder and of the link.
        for rel in ["people/\u{17f}ecure/visa.md", "finance/\u{17f}ecure/new.md"] {
            if linked.graph.join(rel).parent().unwrap().exists() {
                assert!(edit(&linked, rel, &folders).is_err(), "{rel}");
            }
        }
    }

    /// A folded spelling (KELVIN SIGN for `k`) of a read-only folder above
    /// or below the hop is read-only, whatever the requested string says.
    #[cfg(unix)]
    #[test]
    fn a_folded_read_only_name_around_the_hop_stays_read_only() {
        use std::os::unix::fs::symlink;
        let linked = linked();
        let folders = LocalOnlyFolders::new(["secure", "kids"], Some(&linked.raw))
            .unwrap()
            .with_editable(["secure"])
            .0;
        std::fs::create_dir_all(linked.graph.join("kids/finance")).unwrap();
        symlink(
            linked.raw.join("finance/secure"),
            linked.graph.join("kids/finance/secure"),
        )
        .unwrap();
        std::fs::create_dir_all(linked.raw.join("finance/secure/kids")).unwrap();
        let above = "\u{212a}ids/finance/secure/new.md";
        let below = "finance/secure/\u{212a}ids/new.md";
        // The requested strings carry no read-only name...
        assert!(folders.editable_contains(above) && folders.editable_contains(below));
        for rel in [above, below] {
            if linked.graph.join(rel).parent().unwrap().exists() {
                assert!(edit(&linked, rel, &folders).is_err(), "{rel}");
            }
        }
        // ...and the plain spellings are read-only by name.
        assert!(edit(&linked, "kids/finance/secure/new.md", &folders).is_err());
        assert!(edit(&linked, "finance/secure/kids/new.md", &folders).is_err());
        // Control: the editable folder itself.
        assert!(edit(&linked, "finance/secure/new.md", &folders).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn an_edit_never_creates_a_local_only_folder() {
        let linked = linked();
        let folders = LocalOnlyFolders::new(["secure", "archive"], Some(&linked.raw))
            .unwrap()
            .with_editable(["secure", "archive"])
            .0;
        // No `family/secure` in the graph, no `archive` in the linked folder.
        for rel in ["family/secure/x.md", "finance/secure/archive/x.md"] {
            assert!(edit(&linked, rel, &folders).is_err(), "{rel}");
        }
        // A link gone missing: a save must not start a real folder in its place.
        std::fs::remove_file(linked.graph.join("finance/secure")).unwrap();
        assert!(edit(&linked, "finance/secure/sub/bank.md", &folders).is_err());
        assert!(!linked.graph.join("finance/secure").exists());

        // Control: inside existing folders, new directories are fine.
        std::fs::create_dir_all(linked.graph.join("family/secure")).unwrap();
        std::fs::create_dir_all(linked.raw.join("finance/secure/archive")).unwrap();
        std::os::unix::fs::symlink(
            linked.raw.join("finance/secure"),
            linked.graph.join("finance/secure"),
        )
        .unwrap();
        for rel in [
            "family/secure/x.md",
            "family/secure/new/x.md",
            "finance/secure/archive/x.md",
        ] {
            assert!(edit(&linked, rel, &folders).is_ok(), "{rel}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn edits_refuse_a_git_work_tree_between_the_raw_store_and_the_link_target() {
        let linked = linked();
        let folders = editable(&linked, &["secure"]);
        let rel = "finance/secure/sub/bank.md";
        assert!(edit(&linked, rel, &folders).is_ok());
        for planted in ["", "finance", "finance/secure"] {
            let dir = linked.raw.join(planted).join(".git");
            std::fs::create_dir(&dir).unwrap();
            assert!(edit(&linked, rel, &folders).is_err(), "{planted}/.git");
            std::fs::remove_dir(&dir).unwrap();
            // A `gitdir:` file marks a work tree as well.
            std::fs::write(&dir, "gitdir: /elsewhere").unwrap();
            assert!(edit(&linked, rel, &folders).is_err(), "{planted}/.git file");
            std::fs::remove_file(&dir).unwrap();
        }
        assert!(edit(&linked, rel, &folders).is_ok());
    }

    #[test]
    fn local_only_folders_refuse_every_write_by_name() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let root = dir.path();
        let folders = LocalOnlyFolders::new(["secure"], None).unwrap();
        assert!(resolve_write(root, "finance/secure/new.md", Some(&folders)).is_err());
        assert!(resolve_write(root, "people/SECURE/visa.md", Some(&folders)).is_err());
        assert!(resolve_write(root, "finance/secure", Some(&folders)).is_err());
        assert!(resolve_write(root, "finance/plan.md", Some(&folders)).is_ok());
        assert!(resolve_write(root, "finance/secure/new.md", None).is_ok());
        // Shareable reads refuse the same paths, by name, before any IO.
        assert!(resolve_shareable(root, "finance/secure/new.md", Some(&folders)).is_err());
        assert!(resolve_shareable(root, "finance/plan.md", Some(&folders)).is_ok());
    }

    /// A graph holding **real** local-only directories (`people/secure`,
    /// `family/kids`) under a non-ASCII parent, for the aliasing tests.
    struct RealFolders {
        _dir: tempfile::TempDir,
        root: PathBuf,
        folders: LocalOnlyFolders,
    }

    fn real_folders() -> RealFolders {
        let dir = tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        bootstrap(&root).unwrap();
        for folder in ["people/secure", "family/kids", "caf\u{e9}/secure"] {
            std::fs::create_dir_all(root.join(folder)).unwrap();
            std::fs::write(root.join(folder).join("visa.md"), "# Visa").unwrap();
        }
        RealFolders {
            _dir: dir,
            root,
            folders: LocalOnlyFolders::new(["secure", "kids"], None).unwrap(),
        }
    }

    /// Whether this filesystem resolves `variant` onto an existing entry
    /// (case-insensitive APFS does; a case-sensitive filesystem does not).
    fn folds_onto_existing(root: &Path, variant: &str) -> bool {
        root.join(variant).exists()
    }

    #[test]
    fn a_folded_spelling_of_a_real_local_only_folder_is_refused_and_flagged() {
        let real = real_folders();
        let variants = [
            // ASCII case: matched lexically as well.
            "people/SECURE/visa.md",
            // LATIN SMALL LETTER LONG S case-folds to `s`.
            "people/\u{17f}ecure/visa.md",
            // KELVIN SIGN decomposes (NFD) to `K`, which case-folds to `k`.
            "family/\u{212a}ids/visa.md",
            // An NFD spelling of the NFC parent `café`, plus the long s.
            "cafe\u{301}/\u{17f}ecure/visa.md",
        ];
        for variant in variants {
            if !folds_onto_existing(&real.root, variant) {
                // Control: where the filesystem keeps the spellings apart the
                // variant is a different, ordinary folder, unless its name
                // matches lexically (ASCII case).
                assert_eq!(
                    resolve_write(&real.root, variant, Some(&real.folders)).is_ok(),
                    !real.folders.covers(variant),
                    "control write through {variant:?}"
                );
                continue;
            }
            assert!(
                resolve_write(&real.root, variant, Some(&real.folders)).is_err(),
                "write through {variant:?}"
            );
            assert!(
                resolve_write(
                    &real.root,
                    &variant.replace("visa.md", "new.md"),
                    Some(&real.folders)
                )
                .is_err(),
                "create through {variant:?}"
            );
            let read = resolve_read(&real.root, variant, Some(&real.folders)).unwrap();
            assert!(read.local_only, "read flag for {variant:?}");
            assert!(resolve_shareable(&real.root, variant, Some(&real.folders)).is_err());
        }
    }

    #[test]
    fn the_on_disk_check_is_what_refuses_a_folded_spelling() {
        let real = real_folders();
        let variant = "people/\u{17f}ecure/visa.md";
        if !folds_onto_existing(&real.root, variant) {
            return; // nothing folds here, so nothing to prove
        }
        // Control: the requested string alone carries no configured name, and
        // the plain guard lets it through; only the resolved entry does.
        assert!(!real.folders.covers(variant));
        assert!(resolve(&real.root, variant).is_ok());
        assert!(resolve_write(&real.root, variant, Some(&real.folders)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn an_in_graph_symlink_cannot_alias_a_real_local_only_folder() {
        use std::os::unix::fs::symlink;
        let real = real_folders();
        symlink(
            real.root.join("people/secure"),
            real.root.join("notes/alias"),
        )
        .unwrap();
        // Control: lexically ordinary, and inside the graph.
        assert!(!real.folders.covers("notes/alias/new.md"));
        assert!(resolve(&real.root, "notes/alias/new.md").is_ok());
        assert!(resolve_write(&real.root, "notes/alias/new.md", Some(&real.folders)).is_err());
        assert!(resolve_write(&real.root, "notes/alias/visa.md", Some(&real.folders)).is_err());
        let read = resolve_read(&real.root, "notes/alias/visa.md", Some(&real.folders)).unwrap();
        assert!(read.local_only);
        assert!(resolve_shareable(&real.root, "notes/alias/visa.md", Some(&real.folders)).is_err());
    }

    #[test]
    fn ordinary_paths_beside_local_only_folders_stay_writable_and_shareable() {
        let real = real_folders();
        for rel in [
            "people/plan.md",
            "notes/new.md",
            "caf\u{e9}/menu.md",
            "family/kidsroom/x.md",
        ] {
            assert!(
                resolve_write(&real.root, rel, Some(&real.folders)).is_ok(),
                "{rel}"
            );
            assert!(
                !resolve_read(&real.root, rel, Some(&real.folders))
                    .unwrap()
                    .local_only
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn git_entries_are_judged_by_name_by_alias_and_by_their_resolved_parents() {
        use std::os::unix::fs::symlink;
        let linked = linked();
        let (graph, folders) = (&linked.graph, &linked.folders);
        std::fs::create_dir_all(graph.join("people/secure")).unwrap();
        std::fs::create_dir_all(graph.join("people/caf\u{e9}")).unwrap();
        symlink(graph.join("people/secure"), graph.join("notes/alias")).unwrap();
        let outside = tempdir().unwrap();
        symlink(outside.path(), graph.join("notes/elsewhere")).unwrap();
        let folds = graph.join("finance/\u{17f}ecure").exists();

        // By name: the link entry itself, and anything under the name.
        assert!(entry_is_local_only(graph, "finance/secure", folders));
        assert!(entry_is_local_only(graph, "finance/secure/new.md", folders));
        // Through a resolved parent: an in-graph alias of a real folder, and
        // any symlink that leaves the graph.
        assert!(entry_is_local_only(graph, "notes/alias/x.md", folders));
        assert!(entry_is_local_only(graph, "notes/elsewhere/x.md", folders));
        // The entries themselves are links Git stores as files: ordinary.
        assert!(!entry_is_local_only(graph, "notes/alias", folders));
        assert!(!entry_is_local_only(graph, "notes/elsewhere", folders));
        // Ordinary entries, including non-ASCII names.
        assert!(!entry_is_local_only(graph, "notes/a.md", folders));
        assert!(!entry_is_local_only(
            graph,
            "people/caf\u{e9}/menu.md",
            folders
        ));
        assert!(!entry_is_local_only(
            graph,
            "people/cafe\u{301}/menu.md",
            folders
        ));
        assert!(!entry_is_local_only(graph, "README.md", folders));
        if folds {
            // Folded spellings: a parent through the link, and an entry that
            // is the link or the real folder under another name.
            assert!(!folders.covers("finance/\u{17f}ecure/x.md"));
            assert!(entry_is_local_only(
                graph,
                "finance/\u{17f}ecure/x.md",
                folders
            ));
            assert!(entry_is_local_only(graph, "finance/\u{17f}ecure", folders));
            assert!(entry_is_local_only(graph, "people/\u{17f}ecure", folders));
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let outside = tempdir().unwrap();
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        // A symlink inside the graph pointing out of it.
        symlink(outside.path(), graph.path().join("notes/escape")).unwrap();
        assert!(resolve(graph.path(), "notes/escape/evil.md").is_err());
    }
}
