//! The user's edits inside editable local-only folders, on the
//! `LocalOnlyEntry` the edit resolver (`resolve::resolve_note_edit`) hands
//! back: note saves, creates, deletes, and moves, attachment intake, and the
//! store that keeps unsaved text when a save cannot land.
//!
//! Everything here runs on `beneath`'s directory descriptors, so nothing
//! past the resolver's one validated hop is ever followed, a swapped
//! directory is refused rather than written through, and every save carries
//! a revision check. Callers hold the note-write lock around anything that
//! reads and then writes.
//!
//! Unix-only, like `beneath`. Elsewhere every edit refuses; editability never
//! survives the configuration load there (`local_only::finalize`) anyway.

use serde::Serialize;

pub(super) use self::imp::{
    carry_recovery, clear_recovery, create_note, forget_recovery, land_attachment, move_note,
    read_recovery, trash_note, write_note, write_recovery, TrashStage,
};

/// One session's kept unsaved text and its version receipt, as the app restores it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecovery {
    pub owner_id: String,
    pub token: String,
    pub source_revision: Option<String>,
    /// When the text was kept, in epoch milliseconds.
    pub saved_at_ms: u64,
    /// The unsaved buffer, verbatim.
    pub contents: String,
}

#[cfg(unix)]
mod imp {
    use std::ffi::OsStr;
    use std::path::Path;

    pub(in crate::fs) use super::super::beneath::TrashStage;
    use super::super::beneath::{self, BeneathDir, BeneathError, Persist, Persisted, Renamed};
    use super::super::resolve::LocalOnlyEntry;
    use super::super::{NoteCreateOutcome, CHANGED_ON_DISK};
    use super::NoteRecovery;
    use crate::error::{AppError, AppResult};

    /// The canonical graph root, where `.reflect/` is walked from.
    fn graph_root(root: &Path) -> AppResult<BeneathDir> {
        Ok(beneath::open_dir_beneath(root, Path::new(""), false)?)
    }

    /// The directory holding `entry` (created when `create` is set) and the
    /// entry's name in it.
    fn parent_and_name(entry: &LocalOnlyEntry, create: bool) -> AppResult<(BeneathDir, &OsStr)> {
        let name = entry
            .rest
            .file_name()
            .ok_or_else(|| AppError::traversal("an edit needs a file name"))?;
        let parent = entry.rest.parent().unwrap_or(Path::new(""));
        Ok((
            beneath::open_dir_beneath(&entry.base, parent, create)?,
            name,
        ))
    }

    fn changed_on_disk() -> AppError {
        AppError::io(CHANGED_ON_DISK)
    }

    /// Save `contents` over the revision its writer read: `expected` `None`
    /// claims a name nothing holds (an iCloud placeholder counts as taken),
    /// and `Some` compares the revision returned by `note_read`, including
    /// privacy-preserving line-ending normalization. The raw file identity
    /// is checked again right before the rename. Anything else is refused
    /// as [`CHANGED_ON_DISK`], with the file left as it is. Returns its mtime in epoch
    /// milliseconds.
    pub(in crate::fs) fn write_note(
        entry: &LocalOnlyEntry,
        contents: &str,
        expected: Option<&str>,
    ) -> AppResult<Option<u64>> {
        let root = graph_root(&entry.graph_root)?;
        let (dir, name, persist) = match expected {
            None => {
                let (dir, name) = parent_and_name(entry, true)?;
                if beneath::occupied_beneath(&dir, name)? {
                    return Err(changed_on_disk());
                }
                (dir, name, Persist::NoClobber)
            }
            Some(expected) => {
                let (dir, name) = match parent_and_name(entry, false) {
                    Ok(opened) => opened,
                    Err(AppError::NotFound { .. }) => return Err(changed_on_disk()),
                    Err(err) => return Err(err),
                };
                let current = match beneath::read_beneath(&dir, name) {
                    Ok(current) => current,
                    Err(BeneathError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => {
                        return Err(changed_on_disk())
                    }
                    Err(err) => return Err(err.into()),
                };
                let text = String::from_utf8(current.bytes)
                    .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
                if super::super::io::normalize_note_text(text) != expected {
                    return Err(changed_on_disk());
                }
                (dir, name, Persist::Replace(current.identity))
            }
        };
        match beneath::persist_beneath(&root, &dir, name, contents.as_bytes(), persist)? {
            Persisted::Replaced(modified_ms) | Persisted::Created(modified_ms) => Ok(modified_ms),
            Persisted::ChangedOnDisk | Persisted::Collision => Err(changed_on_disk()),
        }
    }

    /// Claim a free name for a new note ([`NoteCreateOutcome::Collision`]
    /// when anything, or an iCloud placeholder, holds it).
    pub(in crate::fs) fn create_note(
        entry: &LocalOnlyEntry,
        contents: &str,
    ) -> AppResult<NoteCreateOutcome> {
        let root = graph_root(&entry.graph_root)?;
        let (dir, name) = parent_and_name(entry, true)?;
        if beneath::occupied_beneath(&dir, name)? {
            return Ok(NoteCreateOutcome::Collision);
        }
        let persisted =
            beneath::persist_beneath(&root, &dir, name, contents.as_bytes(), Persist::NoClobber)?;
        Ok(match persisted {
            Persisted::Created(modified_ms) => NoteCreateOutcome::Created { modified_ms },
            _ => NoteCreateOutcome::Collision,
        })
    }

    /// Stage the note for the OS trash: in a fresh `.reflect/trash/<random>/`
    /// directory, or, when its folder is on another volume than the graph,
    /// in a fresh hidden directory beside it. Only a regular file whose
    /// bytes are on this Mac moves: a symlink is refused, and so is a
    /// dataless file, whose bytes would stay behind in its file provider.
    pub(in crate::fs) fn trash_note(entry: &LocalOnlyEntry) -> AppResult<TrashStage> {
        let root = graph_root(&entry.graph_root)?;
        let (dir, name) = parent_and_name(entry, false)?;
        beneath::regular_file_beneath(&dir, name)?;
        Ok(beneath::trash_beneath(&root, &dir, name)?)
    }

    /// Rename a note from one local-only entry to another, never replacing
    /// an entry (or the note an iCloud placeholder stands for) and never
    /// following a link. Only a regular file whose bytes are on this Mac
    /// moves, and only within its volume.
    pub(in crate::fs) fn move_note(
        from: &LocalOnlyEntry,
        to: &LocalOnlyEntry,
        to_path: &str,
    ) -> AppResult<()> {
        let occupied = || {
            AppError::io(format!(
                "cannot move note: {to_path} already exists on disk"
            ))
        };
        let (from_dir, from_name) = parent_and_name(from, false)?;
        beneath::regular_file_beneath(&from_dir, from_name)?;
        let (to_dir, to_name) = parent_and_name(to, true)?;
        if beneath::evicted_beneath(&to_dir, to_name)? {
            return Err(occupied());
        }
        match beneath::rename_beneath(&from_dir, from_name, &to_dir, to_name)? {
            Renamed::Moved => Ok(()),
            Renamed::Collision => Err(occupied()),
        }
    }

    /// Land the upload staged in `.reflect/tmp/` as `staged` in the note's
    /// own folder, `<folder>/assets/`, under the first of `names` nothing
    /// holds, and return its graph-relative path (`None` when every name is
    /// taken). Nothing is replaced.
    pub(in crate::fs) fn land_attachment(
        note: &LocalOnlyEntry,
        staged: &OsStr,
        names: impl IntoIterator<Item = String>,
    ) -> AppResult<Option<String>> {
        let root = graph_root(&note.graph_root)?;
        let assets = beneath::open_dir_beneath(&note.base, &note.folder_dir.join("assets"), true)?;
        let landed = beneath::land_staged_beneath(&root, staged, &assets, names)?;
        Ok(landed.map(|name| format!("{}/assets/{name}", note.folder_root)))
    }

    /// Keep `contents` as the unsaved text of the note at `path`, replacing
    /// any earlier copy. `root` is the canonical graph root.
    pub(in crate::fs) fn write_recovery(
        root: &Path,
        path: &str,
        owner_id: &str,
        source_revision: Option<&str>,
        contents: &str,
    ) -> AppResult<NoteRecovery> {
        let copy = beneath::write_recovery(
            &graph_root(root)?,
            path,
            owner_id,
            source_revision,
            contents,
        )?;
        Ok(note_recovery(copy))
    }

    /// The kept unsaved text of the note at `path`, if any.
    pub(in crate::fs) fn read_recovery(root: &Path, path: &str) -> AppResult<Option<NoteRecovery>> {
        let copy = beneath::read_recovery(&graph_root(root)?, path)?;
        Ok(copy.map(note_recovery))
    }

    fn note_recovery(copy: beneath::RecoveryCopy) -> NoteRecovery {
        NoteRecovery {
            owner_id: copy.owner_id,
            token: copy.token,
            source_revision: copy.source_revision,
            saved_at_ms: copy.saved_at_ms,
            contents: copy.contents,
        }
    }

    /// Drop every session's kept unsaved text of the note at `path`, which
    /// was deleted. Best effort: a failure is logged, never fails the delete.
    pub(in crate::fs) fn forget_recovery(root: &Path, path: &str) {
        let forgotten = graph_root(root).and_then(|root| Ok(beneath::drop_recovery(&root, path)?));
        if let Err(err) = forgotten {
            tracing::warn!(
                ?err,
                "failed to drop the kept unsaved text of a deleted note"
            );
        }
    }

    /// Carry the kept unsaved text of the note at `from` to `to`, where it
    /// moved. Best effort: a failure is logged, never fails the move.
    pub(in crate::fs) fn carry_recovery(root: &Path, from: &str, to: &str) {
        let carried =
            graph_root(root).and_then(|root| Ok(beneath::move_recovery(&root, from, to)?));
        if let Err(err) = carried {
            tracing::warn!(
                ?err,
                "failed to carry the kept unsaved text of a moved note"
            );
        }
    }

    /// Drop the kept unsaved text of the note at `path`; having none is fine.
    pub(in crate::fs) fn clear_recovery(
        root: &Path,
        path: &str,
        owner_id: &str,
        token: &str,
    ) -> AppResult<()> {
        Ok(beneath::clear_recovery(
            &graph_root(root)?,
            path,
            owner_id,
            token,
        )?)
    }
}

#[cfg(not(unix))]
mod imp {
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    use super::super::resolve::LocalOnlyEntry;
    use super::super::NoteCreateOutcome;
    use super::NoteRecovery;
    use crate::error::{AppError, AppResult};

    fn unsupported() -> AppError {
        AppError::traversal("local-only folders are read-only on this platform")
    }

    /// Never staged here: every edit refuses on this platform.
    #[derive(Debug)]
    pub(in crate::fs) enum TrashStage {}

    impl TrashStage {
        pub(in crate::fs) fn path(&self) -> PathBuf {
            match *self {}
        }

        pub(in crate::fs) fn trashed(self) {
            match self {}
        }

        pub(in crate::fs) fn refused(self) -> AppResult<bool> {
            match self {}
        }
    }

    pub(in crate::fs) fn write_note(
        _entry: &LocalOnlyEntry,
        _contents: &str,
        _expected: Option<&str>,
    ) -> AppResult<Option<u64>> {
        Err(unsupported())
    }

    pub(in crate::fs) fn create_note(
        _entry: &LocalOnlyEntry,
        _contents: &str,
    ) -> AppResult<NoteCreateOutcome> {
        Err(unsupported())
    }

    pub(in crate::fs) fn trash_note(_entry: &LocalOnlyEntry) -> AppResult<TrashStage> {
        Err(unsupported())
    }

    pub(in crate::fs) fn forget_recovery(_root: &Path, _path: &str) {}

    pub(in crate::fs) fn carry_recovery(_root: &Path, _from: &str, _to: &str) {}

    pub(in crate::fs) fn move_note(
        _from: &LocalOnlyEntry,
        _to: &LocalOnlyEntry,
        _to_path: &str,
    ) -> AppResult<()> {
        Err(unsupported())
    }

    pub(in crate::fs) fn land_attachment(
        _note: &LocalOnlyEntry,
        _staged: &OsStr,
        _names: impl IntoIterator<Item = String>,
    ) -> AppResult<Option<String>> {
        Err(unsupported())
    }

    pub(in crate::fs) fn write_recovery(
        _root: &Path,
        _path: &str,
        _owner_id: &str,
        _source_revision: Option<&str>,
        _contents: &str,
    ) -> AppResult<NoteRecovery> {
        Err(unsupported())
    }

    pub(in crate::fs) fn read_recovery(
        _root: &Path,
        _path: &str,
    ) -> AppResult<Option<NoteRecovery>> {
        Err(unsupported())
    }

    pub(in crate::fs) fn clear_recovery(
        _root: &Path,
        _path: &str,
        _owner_id: &str,
        _token: &str,
    ) -> AppResult<()> {
        Err(unsupported())
    }
}
