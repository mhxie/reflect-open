//! A pull never overwrites bytes that were never committed.
//!
//! Before a pull writes anything, it checks every path it writes or removes
//! (its write set) and moves whatever this device keeps there without a
//! committed copy out of the way:
//!
//! - **Validated first** ([`ensure_writable_path`]). A path with an empty,
//!   `.`, or `..` component, a `.git` component (in any spelling the volume
//!   folds onto it, or behind HFS-ignorable code points), a first component
//!   that is the graph's own `.reflect` folder, a backslash, a leading
//!   slash, or invalid UTF-8 pauses sync before anything is touched: libgit2
//!   checks names only at checkout and on insert, never when it parses a
//!   fetched tree, and it knows nothing of `.reflect`.
//! - **Walked without following.** Each path is walked from the canonical
//!   graph root one component at a time, each directory opened relative to
//!   its parent without following a symlink. The first symlink or
//!   non-directory where the pull needs a directory is the entry in its
//!   way, decided once by its on-disk spelling.
//! - **What moves.** An untracked entry, and a tracked one whose bytes differ
//!   from the index as a commit sees them, through Git's clean filters (an
//!   oversized edit the backup skipped, a locked note).
//!   Trackedness is read from the index by the path the pull writes and by
//!   the entry's on-disk spelling (the index folds case under
//!   `core.ignorecase`), so a name the volume folds or normalizes onto
//!   another is the same file.
//! - **Untracked hidden entries never move.** An untracked hidden plain file
//!   at the path written is replaced, as Git always did (Finder junk); any
//!   other untracked hidden entry in the way of an added file pauses sync,
//!   since libgit2 replaces it only where it folds case and would otherwise
//!   write through a link. A tracked hidden entry whose bytes the commit held
//!   back (an oversized edit, a locked note) moves like a visible one: Git
//!   has no copy of those bytes.
//! - **Identical bytes.** An entry already equal to the incoming file is
//!   parked under `.reflect/tmp/` and discarded once the pull lands: no copy
//!   is made, and nothing is lost if the pull fails.
//! - **Where it moves.** `stem (this device).ext` beside it, then
//!   `stem (this device 2).ext` and so on: a name absent from HEAD, the
//!   index, the incoming tree, and the write set, claimed with an exclusive
//!   rename (`renameatx_np(RENAME_EXCL)`, `renameat2(RENAME_NOREPLACE)` on
//!   Linux) relative to the parent's descriptor. A tracked entry gets the
//!   index's version back at its path, so the pull meets a clean file.
//! - **What pauses or defers.** A folder holding anything uncommitted where
//!   the pull adds a file, or a hidden link or file in the way of one,
//!   pauses sync. A tracked, public, non-oversized file
//!   that changed since the cycle's commit is a save that raced it: the pull
//!   defers with nothing written, and the engine commits and pulls again.
//! - **Undone on failure** ([`Moves::undo`]). A pull that fails after
//!   entries moved puts each back wherever its path is still free, or holds
//!   only the index version written back for it.
//!
//! The caller holds the note write guard (`fs::note_write_guard`) from this
//! scan until the working tree is final, so no app write lands in between.

use std::collections::HashSet;

use git2::{Index, Tree};
use serde::Serialize;
use unicase::UniCase;
use unicode_normalization::UnicodeNormalization;

use crate::error::{AppError, AppResult};

/// The label a moved entry's new name carries: `plan (this device).md`.
const THIS_DEVICE: &str = "this device";

/// Names tried for one copy before the pull gives up.
pub(super) const MAX_NAME_PROBES: u32 = 1000;

/// One of this device's entries a pull moved out of a path it wrote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplacedFile {
    /// Where the entry was: the graph-relative path the pull wrote, spelled
    /// as the entry was on disk (the spelling the index and open editors
    /// know it by).
    pub from: String,
    /// Where the entry is now (`stem (this device).ext`).
    pub to: String,
    /// The moved bytes are a note whose frontmatter locks it or can't be
    /// read: the backup keeps such a note out once withholding lands.
    pub kept_out: bool,
    /// The entry was tracked: its uncommitted bytes differed from the index.
    pub tracked: bool,
    /// The incoming note carries another frontmatter id than the moved one:
    /// a different note took the path, rather than another version of it.
    pub different_note: bool,
}

/// What a displacement scan decided.
pub(super) enum Displacement {
    /// Nothing in the write set's way holds uncommitted bytes any more; the
    /// pull may write, then [`Moves::finish`] or [`Moves::undo`].
    Ready(Moves),
    /// A save raced the cycle's commit. Nothing was touched.
    Deferred,
}

/// The graph's own runtime folder (the index, the capture spool, staging),
/// which no commit ever carries and no pull may write or delete.
const RUNTIME_DIR: &str = ".reflect";

/// Refuse, before anything is written, a path the pull must never act on.
/// `path` is the raw tree path, so invalid UTF-8 is caught, not replaced.
pub(super) fn ensure_writable_path(path: &[u8]) -> AppResult<()> {
    let refuse = |why: &str| {
        Err(AppError::io(format!(
            "Sync paused: the backup holds a path Reflect never writes ({why}): {:?}. Nothing was \
             changed. Remove that path from the backup repository, then sync again.",
            String::from_utf8_lossy(path)
        )))
    };
    let Ok(text) = std::str::from_utf8(path) else {
        return refuse("it is not valid UTF-8");
    };
    if text.starts_with('/') {
        return refuse("it is absolute");
    }
    if text.contains('\\') {
        return refuse("it holds a backslash");
    }
    for (position, component) in text.split('/').enumerate() {
        if component.is_empty() {
            return refuse("it has an empty component");
        }
        if component == "." || component == ".." {
            return refuse("it has a `.` or `..` component");
        }
        if opens(component, ".git") {
            return refuse("it names a `.git` folder");
        }
        if position == 0 && opens(component, RUNTIME_DIR) {
            return refuse("it is inside Reflect's own `.reflect` folder");
        }
    }
    Ok(())
}

/// Whether `component` opens the entry named `reserved` (lowercase ASCII)
/// on a volume that folds case and normalization ([`fold`]: `.GIT`, and
/// `.reﬂect` with the `ﬂ` ligature on APFS), also once the code points HFS+
/// ignores in names are removed (`.g\u{200c}it` opens `.git` there).
fn opens(component: &str, reserved: &str) -> bool {
    let visible: String = component
        .chars()
        .filter(|character| !is_hfs_ignorable(*character))
        .collect();
    fold(&visible) == reserved
}

/// The code points HFS+ drops from file names (Git's `next_hfs_char`).
fn is_hfs_ignorable(character: char) -> bool {
    matches!(
        character,
        '\u{200c}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{206a}'..='\u{206f}' | '\u{feff}'
    )
}

/// `leaf` renamed for a kept copy: `img.png` → `img (label).png`, then
/// `img (label 2).png` and so on. The extension stays (a leading dot is a
/// hidden name, not an extension), and a name without one gets the mark at
/// its end.
pub(super) fn copy_name(leaf: &str, label: &str, attempt: u32) -> String {
    let mark = if attempt <= 1 {
        format!(" ({label})")
    } else {
        format!(" ({label} {attempt})")
    };
    match leaf.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => format!("{stem}{mark}.{extension}"),
        _ => format!("{leaf}{mark}"),
    }
}

/// `path` folded the way APFS compares names: canonically decomposed, then
/// case-folded the full Unicode way and decomposed again. `Plan.md` and
/// `plan.md`, the NFC and NFD spellings of `café.md`, and `straße.md` and
/// `strasse.md` are each one name there, so each folds to one key. Used
/// where a name the volume aliases must count as taken; folding slightly
/// more than a given volume does only costs a copy its first number.
pub(super) fn fold(path: &str) -> String {
    let decomposed: String = path.nfd().collect();
    UniCase::unicode(decomposed)
        .to_folded_case()
        .nfd()
        .collect()
}

/// Every path the index (all stages) and `trees` hold, plus `extra`, folded
/// ([`fold`]): the names a kept copy must avoid.
pub(super) fn taken_paths<'a>(
    index: &Index,
    trees: &[&Tree<'_>],
    extra: impl IntoIterator<Item = &'a str>,
) -> HashSet<String> {
    let mut taken: HashSet<String> = index
        .iter()
        .map(|entry| fold(&String::from_utf8_lossy(&entry.path)))
        .collect();
    for tree in trees {
        let _ = tree.walk(git2::TreeWalkMode::PreOrder, |prefix, entry| {
            if entry.kind() != Some(git2::ObjectType::Tree) {
                let name = String::from_utf8_lossy(entry.name_bytes());
                taken.insert(fold(&format!("{prefix}{name}")));
            }
            git2::TreeWalkResult::Ok
        });
    }
    taken.extend(extra.into_iter().map(fold));
    taken
}

#[cfg(unix)]
pub(super) use self::walk::{displace, Moves};

/// Windows builds (experimental) have no descriptor-relative walk, so the
/// pull proceeds unguarded, as it always has there.
#[cfg(not(unix))]
pub(super) fn displace(
    _repo: &git2::Repository,
    _root: &std::path::Path,
    _writes: &[super::merge::ChangedFile],
    _incoming: &Tree<'_>,
    _max_file_bytes: u64,
    _stranded: &mut Vec<DisplacedFile>,
) -> AppResult<Displacement> {
    Ok(Displacement::Ready(Moves))
}

/// Nothing moves on Windows (see [`displace`]).
#[cfg(not(unix))]
pub(super) struct Moves;

#[cfg(not(unix))]
impl Moves {
    pub(super) fn finish(self) -> Vec<DisplacedFile> {
        Vec::new()
    }

    pub(super) fn undo(self) -> Vec<DisplacedFile> {
        Vec::new()
    }
}

#[cfg(unix)]
mod walk {
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};

    use git2::build::CheckoutBuilder;
    use git2::{Index, Oid, Repository, Tree};
    use reflect_frontmatter::{backup_privacy, frontmatter_id};
    use reflect_graph_paths::is_safe_visible;

    use crate::error::{AppError, AppResult};
    use crate::fs::{
        entry_beneath, names_beneath, open_dir_beneath, read_beneath, read_link_beneath,
        remove_beneath, rename_beneath, subdir_beneath, BeneathDir, BeneathError, EntryKind,
        EntryStat, Renamed,
    };

    use super::super::merge::{ChangeKind, ChangedFile};
    use super::{copy_name, fold, taken_paths, DisplacedFile, Displacement, MAX_NAME_PROBES};

    const MODE_TYPE_MASK: u32 = 0o170_000;
    const MODE_FILE: u32 = 0o100_000;
    const MODE_LINK: u32 = 0o120_000;

    /// Scan the write set and move this device's uncommitted entries out of
    /// its way (see the module docs). `incoming` is the tree whose files land
    /// at the write set, `max_file_bytes` the backup size limit. On a failure
    /// partway, what moved is put back, and what could not be is appended to
    /// `stranded` for the caller to announce.
    pub(in super::super) fn displace(
        repo: &Repository,
        root: &Path,
        writes: &[ChangedFile],
        incoming: &Tree<'_>,
        max_file_bytes: u64,
        stranded: &mut Vec<DisplacedFile>,
    ) -> AppResult<Displacement> {
        if writes.is_empty() {
            return Ok(Displacement::Ready(Moves::default()));
        }
        let mut walk = Walk {
            repo,
            index: repo.index()?,
            root: root.canonicalize()?,
            incoming,
            max_file_bytes,
            listings: HashMap::new(),
        };
        let Some(candidates) = walk.plan(writes)? else {
            return Ok(Displacement::Deferred);
        };
        let head = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        let mut moves = Moves::default();
        let mut taken: Option<HashSet<String>> = None;
        for candidate in candidates {
            let moved = if candidate.park {
                walk.park(&mut moves, candidate, &mut taken, head.as_ref(), writes)
            } else {
                walk.copy(&mut moves, candidate, &mut taken, head.as_ref(), writes)
            };
            if let Err(err) = moved {
                stranded.extend(moves.undo());
                return Err(err);
            }
        }
        Ok(Displacement::Ready(moves))
    }

    /// What one displacement did, to finish or undo.
    #[derive(Default)]
    pub(in super::super) struct Moves {
        done: Vec<Done>,
        /// `.reflect/tmp/`, once something was parked there.
        staging: Option<BeneathDir>,
    }

    /// One entry that moved.
    struct Done {
        /// The directory it was in.
        dir: BeneathDir,
        /// Its name there, as spelled on disk.
        name: String,
        aside: Aside,
        /// The index version written back at its path, if it was tracked.
        restored: Option<Restored>,
    }

    enum Aside {
        /// Beside it, under a kept copy's name.
        Copy { name: String, report: DisplacedFile },
        /// In `.reflect/tmp/`: it matched the incoming file.
        Parked { name: String },
    }

    /// What a write-back put at an entry's path, to recognize it untouched.
    struct Restored {
        name: String,
        contents: Vec<u8>,
        link: bool,
    }

    impl Moves {
        /// The pull landed: drop the parked entries (the incoming files hold
        /// their bytes) and return the kept copies.
        pub(in super::super) fn finish(self) -> Vec<DisplacedFile> {
            let mut copies = Vec::new();
            for done in self.done {
                match done.aside {
                    Aside::Copy { report, .. } => copies.push(report),
                    Aside::Parked { name } => {
                        let removed = self
                            .staging
                            .as_ref()
                            .map(|staging| remove_beneath(staging, &name));
                        if let Some(Err(err)) = removed {
                            tracing::warn!(?err, %name, "could not drop a parked entry");
                        }
                    }
                }
            }
            copies
        }

        /// The pull failed: put each entry back, newest first, wherever its
        /// path is still free (or holds only the index version written back
        /// for it), and return the copies that had to stay.
        pub(in super::super) fn undo(self) -> Vec<DisplacedFile> {
            let mut stranded = Vec::new();
            for done in self.done.into_iter().rev() {
                if put_back(&done, self.staging.as_ref()) {
                    continue;
                }
                match done.aside {
                    Aside::Copy { report, .. } => stranded.push(report),
                    // Its bytes are the incoming file's, which Git holds; the
                    // next graph open sweeps `.reflect/tmp/`.
                    Aside::Parked { name } => {
                        tracing::warn!(%name, "a parked entry could not go back")
                    }
                }
            }
            stranded.reverse();
            stranded
        }
    }

    /// Move one entry back to its path; false when it has to stay aside. The
    /// index version written back for a tracked entry gives way when it is
    /// untouched, and is no obstacle once the pull itself removed it (the
    /// other device deleted the path).
    fn put_back(done: &Done, staging: Option<&BeneathDir>) -> bool {
        if let Some(restored) = &done.restored {
            let gave_way = match entry_beneath(&done.dir, &restored.name) {
                Ok(None) => true,
                Ok(Some(_)) => {
                    holds(&done.dir, restored) && remove_beneath(&done.dir, &restored.name).is_ok()
                }
                Err(_) => false,
            };
            if !gave_way {
                return false;
            }
        }
        if !matches!(entry_beneath(&done.dir, &done.name), Ok(None)) {
            return false;
        }
        let (dir, name) = match &done.aside {
            Aside::Copy { name, .. } => (&done.dir, name),
            Aside::Parked { name } => match staging {
                Some(staging) => (staging, name),
                None => return false,
            },
        };
        matches!(
            rename_beneath(dir, name, &done.dir, &done.name),
            Ok(Renamed::Moved)
        )
    }

    /// Whether `dir` still holds exactly what a write-back put there.
    fn holds(dir: &BeneathDir, restored: &Restored) -> bool {
        if restored.link {
            read_link_beneath(dir, &restored.name).is_ok_and(|target| target == restored.contents)
        } else {
            read_beneath(dir, &restored.name).is_ok_and(|read| read.bytes == restored.contents)
        }
    }

    /// An entry in the write set's way, decided and ready to move.
    struct Candidate {
        /// Its directory.
        dir: BeneathDir,
        /// That directory's graph-relative path, spelled as on disk.
        dir_path: String,
        /// Its name, spelled as on disk.
        name: String,
        /// It matches the incoming file: park it instead of keeping a copy.
        park: bool,
        /// The index version to write back at its path (tracked entries).
        restore: Option<IndexVersion>,
        kept_out: bool,
        different_note: bool,
    }

    /// A tracked entry's stage-0 index entry.
    #[derive(Clone)]
    struct IndexVersion {
        /// The path the index spells it with.
        path: String,
        id: Oid,
        mode: u32,
    }

    /// What one entry in the write set's way needs.
    enum Verdict {
        /// Nothing: committed.
        Keep,
        /// Nothing moves: an untracked hidden entry, which the checkout may
        /// replace where that is safe (see [`Walk::plan_path`]).
        Hidden,
        /// A save raced the cycle's commit.
        Defer,
        /// Out of the way, as decided.
        Move {
            park: bool,
            kept_out: bool,
            different_note: bool,
        },
    }

    struct Walk<'a, 'repo> {
        repo: &'repo Repository,
        index: Index,
        /// The canonical graph root, the base every walk opens.
        root: PathBuf,
        incoming: &'a Tree<'repo>,
        max_file_bytes: u64,
        /// Directory listings by their on-disk graph-relative path, read
        /// once each: how an entry another spelling reached is spelled.
        listings: HashMap<String, Vec<(std::ffi::OsString, i128)>>,
    }

    impl Walk<'_, '_> {
        /// Decide every entry in the write set's way before anything moves:
        /// `None` defers the pull, an error pauses it.
        fn plan(&mut self, writes: &[ChangedFile]) -> AppResult<Option<Vec<Candidate>>> {
            let mut candidates = Vec::new();
            let mut seen: HashSet<String> = HashSet::new();
            for write in writes {
                match self.plan_path(write, &mut seen)? {
                    Planned::Nothing => {}
                    Planned::Defer => return Ok(None),
                    Planned::Move(candidate) => candidates.push(candidate),
                }
            }
            Ok(Some(candidates))
        }

        /// Walk one written path from the root, component by component,
        /// never through a symlink, down to the first entry in its way.
        fn plan_path(
            &mut self,
            write: &ChangedFile,
            seen: &mut HashSet<String>,
        ) -> AppResult<Planned> {
            let components: Vec<&str> = write.path.split('/').collect();
            let mut dirs = vec![open_dir_beneath(&self.root, Path::new(""), false)?];
            let mut inodes = Vec::new();
            let mut prefix = String::new();
            for (position, name) in components.iter().enumerate() {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(name);
                let leaf = position + 1 == components.len();
                let parent = dirs.last().expect("the root is always open");
                let Some(stat) = entry_beneath(parent, name)? else {
                    return Ok(Planned::Nothing);
                };
                inodes.push(stat.inode);
                if stat.kind == EntryKind::Directory {
                    if !leaf {
                        let child = subdir_beneath(parent, name)
                            .map_err(|err| unsafe_to_write(&prefix, err))?;
                        dirs.push(child);
                        continue;
                    }
                    if matches!(write.kind, ChangeKind::Upsert) {
                        self.ensure_folder_committed(parent, name, &prefix)?;
                    }
                    return Ok(Planned::Nothing);
                }
                // Decided once per entry, keyed by its on-disk spelling: two
                // written paths can share a parent in the way, or reach one
                // entry through names the volume folds together (case,
                // Unicode normalization), while names a volume keeps apart
                // are separate entries. Not keyed by inode: each name of a
                // hard-linked file moves, since one left behind would have
                // the checkout truncate the shared file, the moved copy
                // included.
                let spelled = self.spell(&dirs, &components, &inodes)?;
                if !seen.insert(spelled.clone()) {
                    return Ok(Planned::Nothing);
                }
                let tracked = self.index_version(&prefix).or_else(|| {
                    (spelled != prefix)
                        .then(|| self.index_version(&spelled))
                        .flatten()
                });
                let incoming = if leaf && matches!(write.kind, ChangeKind::Upsert) {
                    Some(write.path.as_str())
                } else {
                    None
                };
                let verdict =
                    self.judge(parent, name, &prefix, stat, incoming, tracked.as_ref())?;
                return Ok(match verdict {
                    Verdict::Keep => Planned::Nothing,
                    // The checkout replaces a hidden plain file at the path
                    // it writes, as it always has (Finder junk). Anything
                    // else in the way it removes only where it folds case
                    // (`core.ignorecase`): elsewhere it would write through
                    // a link, or into a pipe, or fail on a file where it
                    // needs a folder.
                    Verdict::Hidden
                        if matches!(write.kind, ChangeKind::Upsert)
                            && (stat.kind != EntryKind::File || !leaf) =>
                    {
                        return Err(hidden_in_the_way(&write.path, &spelled));
                    }
                    Verdict::Hidden => Planned::Nothing,
                    Verdict::Defer => Planned::Defer,
                    Verdict::Move {
                        park,
                        kept_out,
                        different_note,
                    } => {
                        let (dir_path, entry) = match spelled.rsplit_once('/') {
                            Some((dir_path, entry)) => (dir_path.to_owned(), entry.to_owned()),
                            None => (String::new(), spelled.clone()),
                        };
                        let dir = dirs.pop().expect("the parent is open");
                        Planned::Move(Candidate {
                            dir,
                            dir_path,
                            name: entry,
                            park,
                            restore: tracked,
                            kept_out,
                            different_note,
                        })
                    }
                });
            }
            Ok(Planned::Nothing)
        }

        /// What the entry `name` in `parent` (graph path `path`) needs.
        /// `incoming` is the written path when the entry sits exactly there
        /// and the pull writes a file to it; `tracked` its index version.
        fn judge(
            &self,
            parent: &BeneathDir,
            name: &str,
            path: &str,
            stat: EntryStat,
            incoming: Option<&str>,
            tracked: Option<&IndexVersion>,
        ) -> AppResult<Verdict> {
            let contents = match stat.kind {
                EntryKind::File => read_file(parent, name)?,
                EntryKind::Symlink => Some(read_link_beneath(parent, name)?),
                EntryKind::Directory | EntryKind::Other => None,
            };
            if let (Some(version), Some(bytes)) = (tracked, &contents) {
                if self.holds_index_version(version, stat.kind, bytes)? {
                    return Ok(Verdict::Keep);
                }
            }
            let incoming = match incoming {
                Some(path) => self.incoming_blob(path)?,
                None => None,
            };
            // A tracked entry that got here holds bytes no commit has, so it
            // moves even when hidden; only untracked hidden entries are left
            // for the checkout (Finder junk).
            let movable = tracked.is_some() || is_safe_visible(path);
            if let (Some((mode, blob)), Some(bytes)) = (&incoming, &contents) {
                if movable && same_kind(*mode, stat.kind) && blob.content() == bytes.as_slice() {
                    return Ok(Verdict::Move {
                        park: true,
                        kept_out: false,
                        different_note: false,
                    });
                }
            }
            let markdown = is_markdown(path);
            let public = !markdown
                || contents
                    .as_deref()
                    .is_some_and(|bytes| backup_privacy(bytes).is_public());
            if tracked.is_some() && public && stat.size < self.max_file_bytes {
                return Ok(Verdict::Defer);
            }
            if !movable {
                return Ok(Verdict::Hidden);
            }
            let different_note = match (&incoming, &contents) {
                (Some((_, blob)), Some(bytes)) if markdown => matches!(
                    (frontmatter_id(blob.content()), frontmatter_id(bytes)),
                    (Some(theirs), Some(ours)) if theirs != ours
                ),
                _ => false,
            };
            Ok(Verdict::Move {
                park: false,
                kept_out: markdown && !public,
                different_note,
            })
        }

        /// Refuse a folder where the pull adds a file unless everything in
        /// it is committed: libgit2 deletes the folder, contents and all, to
        /// write the file.
        fn ensure_folder_committed(
            &self,
            parent: &BeneathDir,
            name: &str,
            path: &str,
        ) -> AppResult<()> {
            let in_the_way = || {
                AppError::io(format!(
                    "Sync paused: another device put a file at \"{path}\", where this device has \
                     a folder holding files that aren't backed up. Move or rename that folder, \
                     then sync again."
                ))
            };
            let folder = subdir_beneath(parent, name).map_err(|_| in_the_way())?;
            let mut pending = vec![(folder, path.to_owned())];
            while let Some((dir, dir_path)) = pending.pop() {
                for (entry_name, _) in names_beneath(&dir)? {
                    let Some(entry_name) = entry_name.to_str() else {
                        return Err(in_the_way());
                    };
                    let entry_path = format!("{dir_path}/{entry_name}");
                    let Some(stat) = entry_beneath(&dir, entry_name)? else {
                        continue;
                    };
                    let committed = match stat.kind {
                        EntryKind::Directory => {
                            let child =
                                subdir_beneath(&dir, entry_name).map_err(|_| in_the_way())?;
                            pending.push((child, entry_path));
                            continue;
                        }
                        EntryKind::File | EntryKind::Symlink => {
                            match self.index_version(&entry_path) {
                                Some(version) if same_kind(version.mode, stat.kind) => {
                                    let bytes = if stat.kind == EntryKind::File {
                                        read_file(&dir, entry_name)?
                                    } else {
                                        Some(read_link_beneath(&dir, entry_name)?)
                                    };
                                    match bytes {
                                        Some(bytes) => {
                                            self.holds_index_version(&version, stat.kind, &bytes)?
                                        }
                                        None => false,
                                    }
                                }
                                _ => false,
                            }
                        }
                        EntryKind::Other => false,
                    };
                    if !committed {
                        return Err(in_the_way());
                    }
                }
            }
            Ok(())
        }

        /// Keep `candidate` beside its path under the first free kept-copy
        /// name, then write its index version back if it was tracked.
        fn copy(
            &mut self,
            moves: &mut Moves,
            candidate: Candidate,
            taken: &mut Option<HashSet<String>>,
            head: Option<&Tree<'_>>,
            writes: &[ChangedFile],
        ) -> AppResult<()> {
            let taken = taken.get_or_insert_with(|| {
                let trees: Vec<&Tree<'_>> = head.into_iter().chain([self.incoming]).collect();
                taken_paths(
                    &self.index,
                    &trees,
                    writes.iter().map(|write| write.path.as_str()),
                )
            });
            let from = join(&candidate.dir_path, &candidate.name);
            for attempt in 1..=MAX_NAME_PROBES {
                let copy = copy_name(&candidate.name, super::THIS_DEVICE, attempt);
                let to = join(&candidate.dir_path, &copy);
                if taken.contains(&fold(&to)) {
                    continue;
                }
                match rename_beneath(&candidate.dir, &candidate.name, &candidate.dir, &copy)? {
                    Renamed::Collision => continue,
                    Renamed::Moved => {}
                }
                taken.insert(fold(&to));
                let report = DisplacedFile {
                    from,
                    to,
                    kept_out: candidate.kept_out,
                    tracked: candidate.restore.is_some(),
                    different_note: candidate.different_note,
                };
                return self.record(moves, candidate, Aside::Copy { name: copy, report });
            }
            Err(AppError::io(format!(
                "Sync paused: no free name to keep this device's \"{from}\" beside the incoming \
                 file."
            )))
        }

        /// Park `candidate`, which matches the incoming file, in
        /// `.reflect/tmp/`; a copy beside it when that is another volume.
        fn park(
            &mut self,
            moves: &mut Moves,
            candidate: Candidate,
            taken: &mut Option<HashSet<String>>,
            head: Option<&Tree<'_>>,
            writes: &[ChangedFile],
        ) -> AppResult<()> {
            if moves.staging.is_none() {
                moves.staging = Some(open_dir_beneath(
                    &self.root,
                    Path::new(".reflect/tmp"),
                    true,
                )?);
            }
            let staging = moves.staging.as_ref().expect("staging was just opened");
            for _ in 0..MAX_NAME_PROBES {
                let parked = format!("displaced-{}", random_hex()?);
                match rename_beneath(&candidate.dir, &candidate.name, staging, &parked) {
                    Ok(Renamed::Moved) => {
                        return self.record(moves, candidate, Aside::Parked { name: parked })
                    }
                    Ok(Renamed::Collision) => continue,
                    Err(BeneathError::CrossDevice) => {
                        return self.copy(moves, candidate, taken, head, writes)
                    }
                    Err(err) => return Err(err.into()),
                }
            }
            Err(AppError::io(
                "Sync paused: no free name to park an entry under",
            ))
        }

        /// Note a landed move, then write the tracked entry's index version
        /// back at its path. The move is recorded first, so a failed
        /// write-back still undoes it.
        fn record(
            &mut self,
            moves: &mut Moves,
            candidate: Candidate,
            aside: Aside,
        ) -> AppResult<()> {
            moves.done.push(Done {
                dir: candidate.dir,
                name: candidate.name,
                aside,
                restored: None,
            });
            let Some(version) = candidate.restore else {
                return Ok(());
            };
            let done = moves.done.last_mut().expect("the move was just recorded");
            done.restored = Some(self.write_back(&done.dir, &version)?);
            Ok(())
        }

        /// Check the index version of a tracked entry back out at its path
        /// in `dir`: libgit2 writes its mode, link targets, and smudge
        /// filters (CRLF under `core.autocrlf=true`) as a checkout would.
        /// What landed is read back, to recognize it untouched on undo.
        fn write_back(&mut self, dir: &BeneathDir, version: &IndexVersion) -> AppResult<Restored> {
            let mut checkout = CheckoutBuilder::new();
            checkout
                .force()
                .update_index(false)
                .disable_pathspec_match(true)
                .path(version.path.as_str());
            self.repo
                .checkout_index(Some(&mut self.index), Some(&mut checkout))?;
            let name = version
                .path
                .rsplit_once('/')
                .map_or(version.path.as_str(), |(_, name)| name)
                .to_owned();
            let link = version.mode & MODE_TYPE_MASK == MODE_LINK;
            let contents = if link {
                read_link_beneath(dir, &name)?
            } else {
                read_beneath(dir, &name)?.bytes
            };
            Ok(Restored {
                name,
                contents,
                link,
            })
        }

        /// The stage-0 index entry for `path`, case-insensitively when the
        /// index folds case.
        fn index_version(&self, path: &str) -> Option<IndexVersion> {
            self.index
                .get_path(Path::new(path), 0)
                .map(|entry| IndexVersion {
                    path: String::from_utf8_lossy(&entry.path).into_owned(),
                    id: entry.id,
                    mode: entry.mode,
                })
        }

        /// The incoming tree's file or link at `path`, with its mode.
        fn incoming_blob(&self, path: &str) -> AppResult<Option<(u32, git2::Blob<'_>)>> {
            match self.incoming.get_path(Path::new(path)) {
                Ok(entry) if entry.kind() == Some(git2::ObjectType::Blob) => Ok(Some((
                    entry.filemode() as u32,
                    self.repo.find_blob(entry.id())?,
                ))),
                Ok(_) => Ok(None),
                Err(err) if err.code() == git2::ErrorCode::NotFound => Ok(None),
                Err(err) => Err(err.into()),
            }
        }

        /// Whether `bytes`, read at an entry of `kind`, are what the index
        /// holds for it: the same bytes, or a file that Git's clean filters
        /// (line endings under `core.autocrlf` or `eol`, `ident`) turn into
        /// the index blob, so the next commit would record no change. Raw
        /// bytes alone would call a CRLF checkout of an LF blob modified,
        /// and the pull would defer every cycle while the commit found
        /// nothing to record. A file at or above the size limit is never
        /// filtered: the commit skips its changes anyway, and filtering
        /// would copy it into the object store.
        fn holds_index_version(
            &self,
            version: &IndexVersion,
            kind: EntryKind,
            bytes: &[u8],
        ) -> AppResult<bool> {
            if !same_kind(version.mode, kind) {
                return Ok(false);
            }
            let blob = self.repo.find_blob(version.id)?;
            if blob.content() == bytes {
                return Ok(true);
            }
            if kind != EntryKind::File || bytes.len() as u64 >= self.max_file_bytes {
                return Ok(false);
            }
            Ok(self.filtered_blob_id(&version.path, bytes)? == version.id)
        }

        /// The blob a commit would record for `bytes` at `path`: the bytes
        /// through the clean filters `path`'s attributes and the repository
        /// config select. It lands in the object store, as `git add` would
        /// put it there; the working tree is untouched.
        fn filtered_blob_id(&self, path: &str, bytes: &[u8]) -> AppResult<Oid> {
            use std::io::Write;
            let mut writer = self.repo.blob_writer(Some(Path::new(path)))?;
            writer.write_all(bytes)?;
            Ok(writer.commit()?)
        }

        /// The walked path, each component spelled as on disk: the listing
        /// entry whose inode the walk reached, preferring the requested
        /// spelling when it is one of them, then one the volume folds onto
        /// it (another name of a hard-linked file shares the inode, and
        /// must not stand in for this one).
        fn spell(
            &mut self,
            dirs: &[BeneathDir],
            components: &[&str],
            inodes: &[i128],
        ) -> AppResult<String> {
            let mut spelled = String::new();
            for (position, inode) in inodes.iter().enumerate() {
                let requested = components[position];
                let listing = match self.listings.entry(spelled.clone()) {
                    std::collections::hash_map::Entry::Occupied(found) => found.into_mut(),
                    std::collections::hash_map::Entry::Vacant(slot) => {
                        slot.insert(names_beneath(&dirs[position])?)
                    }
                };
                let matching: Vec<&str> = listing
                    .iter()
                    .filter(|(_, listed)| listed == inode)
                    .filter_map(|(name, _)| name.to_str())
                    .collect();
                let folded = fold(requested);
                let name = matching
                    .iter()
                    .find(|name| **name == requested)
                    .or_else(|| matching.iter().find(|name| fold(name) == folded))
                    .or(matching.first())
                    .copied()
                    .unwrap_or(requested);
                if !spelled.is_empty() {
                    spelled.push('/');
                }
                spelled.push_str(name);
            }
            Ok(spelled)
        }
    }

    /// The outcome of walking one written path.
    enum Planned {
        Nothing,
        Defer,
        Move(Candidate),
    }

    /// A regular file's bytes, or `None` when they are not on this device
    /// (a dataless file: reading would download it).
    fn read_file(dir: &BeneathDir, name: &str) -> AppResult<Option<Vec<u8>>> {
        match read_beneath(dir, name) {
            Ok(read) => Ok(Some(read.bytes)),
            Err(BeneathError::Offline) => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    /// Whether an index or tree `mode` describes an entry of `kind`.
    fn same_kind(mode: u32, kind: EntryKind) -> bool {
        match mode & MODE_TYPE_MASK {
            MODE_FILE => kind == EntryKind::File,
            MODE_LINK => kind == EntryKind::Symlink,
            _ => false,
        }
    }

    /// A Markdown note by extension (`.md`, `.markdown`, any ASCII case).
    fn is_markdown(path: &str) -> bool {
        let lower = path.to_ascii_lowercase();
        lower.ends_with(".md") || lower.ends_with(".markdown")
    }

    fn join(dir: &str, name: &str) -> String {
        if dir.is_empty() {
            name.to_owned()
        } else {
            format!("{dir}/{name}")
        }
    }

    /// A hidden entry this device never backed up, at `entry`, in the way
    /// of `written`, as a pause.
    fn hidden_in_the_way(written: &str, entry: &str) -> AppError {
        AppError::io(format!(
            "Sync paused: another device wrote \"{written}\", and this device has a hidden link \
             or file at \"{entry}\" in its way that isn't backed up. Move or remove it, then \
             sync again."
        ))
    }

    /// Why a directory on a written path can't be walked (a nested Git work
    /// tree, or a swap mid-walk), as a pause.
    fn unsafe_to_write(path: &str, err: BeneathError) -> AppError {
        let why = match err {
            BeneathError::Traversal(message) => message,
            other => format!("{other:?}"),
        };
        AppError::io(format!(
            "Sync paused: Reflect can't safely write under \"{path}\" ({why}). Move that folder, \
             then sync again."
        ))
    }

    /// 128 random bits as hex: a parked name nothing else can guess.
    fn random_hex() -> AppResult<String> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).map_err(|err| AppError::io(err.to_string()))?;
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn modes_match_entry_kinds() {
            assert!(same_kind(0o100_644, EntryKind::File));
            assert!(same_kind(0o100_755, EntryKind::File));
            assert!(same_kind(0o120_000, EntryKind::Symlink));
            assert!(!same_kind(0o120_000, EntryKind::File));
            assert!(!same_kind(0o160_000, EntryKind::Directory));
        }

        #[test]
        fn markdown_is_decided_by_extension() {
            assert!(is_markdown("notes/a.md"));
            assert!(is_markdown("notes/A.MD"));
            assert!(is_markdown("notes/a.markdown"));
            assert!(!is_markdown("assets/a.png"));
            assert!(!is_markdown("notes/md"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(path: &[u8]) -> bool {
        match ensure_writable_path(path) {
            Ok(()) => false,
            Err(AppError::Io { message }) => {
                assert!(message.starts_with("Sync paused:"), "{message}");
                true
            }
            Err(other) => panic!("expected a pause, got {other:?}"),
        }
    }

    #[test]
    fn unsafe_tree_paths_are_refused() {
        for path in [
            "..",
            ".",
            "notes/../escape.md",
            "notes/./a.md",
            "notes//a.md",
            "notes/",
            "/etc/passwd",
            "notes\\a.md",
            ".git",
            ".GIT/config",
            "notes/.Git/hooks/post-checkout",
            ".g\u{200c}it/config",
            "\u{feff}.git",
            ".git\u{206f}",
            ".reflect",
            ".reflect/index.sqlite",
            ".reflect/inbox/evil.json",
            ".REFLECT/tmp",
            ".Reflect/inbox/p.jpg",
            // `ﬂ` (U+FB02) case-folds to `fl`: APFS opens `.reflect` here.
            ".re\u{fb02}ect/inbox/evil.json",
            ".re\u{200c}flect/index.sqlite",
        ] {
            assert!(refused(path.as_bytes()), "{path:?}");
        }
        assert!(refused(b"notes/\xff.md"));
    }

    #[test]
    fn ordinary_tree_paths_pass() {
        for path in [
            "notes/a.md",
            ".gitignore",
            ".github/workflows/ci.yml",
            "notes/git",
            "notes/x.git",
            "notes/caf\u{e9}.md",
            "daily/2026-10-04.md",
            // Only the graph's own `.reflect` is reserved.
            "notes/.reflect/a.md",
            ".reflections/a.md",
            "reflect/a.md",
        ] {
            assert!(!refused(path.as_bytes()), "{path:?}");
        }
    }

    #[test]
    fn names_fold_the_way_apfs_compares_them() {
        assert_eq!(fold("notes/Plan.md"), fold("notes/plan.md"));
        assert_eq!(fold("notes/caf\u{e9}.md"), fold("notes/cafe\u{301}.md"));
        assert_eq!(fold("notes/CAF\u{c9}.md"), fold("notes/cafe\u{301}.md"));
        assert_eq!(fold("notes/stra\u{df}e.md"), fold("notes/strasse.md"));
        assert_eq!(fold(".re\u{fb02}ect"), ".reflect");
        assert_ne!(fold("notes/plan.md"), fold("notes/plan-2.md"));
        assert_ne!(fold("notes/cafe.md"), fold("notes/caf\u{e9}.md"));
    }

    #[test]
    fn copy_names_keep_the_extension_and_count_up() {
        assert_eq!(
            copy_name("plan.md", THIS_DEVICE, 1),
            "plan (this device).md"
        );
        assert_eq!(
            copy_name("plan.md", THIS_DEVICE, 2),
            "plan (this device 2).md"
        );
        assert_eq!(copy_name("a.tar.gz", "conflict", 1), "a.tar (conflict).gz");
        assert_eq!(copy_name("noext", THIS_DEVICE, 1), "noext (this device)");
        assert_eq!(copy_name(".hidden", "conflict", 3), ".hidden (conflict 3)");
    }
}
