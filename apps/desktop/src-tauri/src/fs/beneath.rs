//! Directory-fd file IO that never follows a symlink.
//!
//! The resolver ([`super::resolve`]) validates a path and hands back a
//! canonical base plus the rest below it. From there everything works on
//! directory descriptors, so a symlink or directory swapped in after that
//! validation cannot redirect a read, write, rename, or delete. The base
//! opens with `O_NOFOLLOW_ANY` on Apple platforms (only its last component
//! is policed elsewhere), and each directory below it opens with
//! `O_NOFOLLOW` relative to its parent. A walk refuses every directory below
//! the base that holds a `.git` entry: a note inside a nested work tree
//! could leave the Mac through that repository's remote.
//!
//! Writes stage their bytes in `.reflect/tmp/`, walked the same way from the
//! graph root (or in a hidden temp beside the target when that directory is
//! on another volume), flush them with `F_FULLFSYNC`, and land with one
//! rename: a replace only while the name still holds the file that was read
//! ([`Identity`]), a create only while the name is free. A delete first
//! moves the file into a fresh random directory under `.reflect/trash/`, so
//! the path-based OS-trash call that follows names a place nothing else can
//! occupy. `.reflect/recovery/` keeps one unsaved buffer per note.
//!
//! Unix-only: directory descriptors are a unix API, and the module is absent
//! from other builds.

use std::ffi::OsStr;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use reflect_graph_paths::is_dataless;
use rustix::fd::OwnedFd;
use rustix::fs::{AtFlags, FileType, Mode, OFlags, RenameFlags, Stat};
use rustix::io::Errno;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::io::{modified_ms, NoMaterialize, REFLECT_DIR};
use crate::error::AppError;

const STAGING_DIR: &str = "tmp";
const TRASH_DIR: &str = "trash";
const RECOVERY_DIR: &str = "recovery";

/// Directories created in the user's folders get `create_dir_all`'s mode.
const DIR_MODE: Mode = Mode::from_raw_mode(0o755);
/// `.reflect/trash/` and `.reflect/recovery/` hold note text: owner only.
const PRIVATE_DIR_MODE: Mode = Mode::from_raw_mode(0o700);
/// Temp files, and so the recovery copies renamed from them.
const TEMP_MODE: Mode = Mode::from_raw_mode(0o600);
/// What a replace carries over from the old file's mode: permissions, never
/// setuid, setgid, or sticky.
const PERMISSION_BITS: Mode = Mode::from_raw_mode(0o777);

/// How the base opens. Apple's `O_NOFOLLOW_ANY` refuses a symlink at any of
/// its components; elsewhere only the last one is policed, and the
/// resolver's canonical base stands for the rest.
#[cfg(any(target_os = "macos", target_os = "ios"))]
const BASE_NOFOLLOW: libc::c_int = libc::O_NOFOLLOW_ANY;
#[cfg(not(any(target_os = "macos", target_os = "ios")))]
const BASE_NOFOLLOW: libc::c_int = libc::O_NOFOLLOW;

/// Why an operation here refused or failed.
#[derive(Debug)]
pub(crate) enum BeneathError {
    /// A symlink or non-directory on a walk, a nested Git work tree, a name
    /// that is not one plain component, or something other than a regular
    /// file where one was expected.
    Traversal(String),
    /// A dataless file: its bytes are not on this Mac, and reading would
    /// download them.
    Offline,
    /// The source and destination are on different volumes.
    CrossDevice,
    /// Any other failure, `NotFound` included.
    Io(std::io::Error),
}

/// Result alias for this module.
pub(crate) type BeneathResult<T> = Result<T, BeneathError>;

impl From<std::io::Error> for BeneathError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<Errno> for BeneathError {
    fn from(errno: Errno) -> Self {
        Self::Io(errno.into())
    }
}

impl From<BeneathError> for AppError {
    fn from(err: BeneathError) -> Self {
        match err {
            BeneathError::Traversal(message) => AppError::traversal(message),
            BeneathError::Offline => AppError::io("the file is not available offline"),
            BeneathError::CrossDevice => AppError::io("can't move between volumes"),
            BeneathError::Io(err) => err.into(),
        }
    }
}

/// A directory reached from a trusted base without following a symlink. The
/// descriptor stays on that directory even if its path is swapped later.
#[derive(Debug)]
pub(crate) struct BeneathDir {
    file: File,
    /// The path it was opened at, for messages and for the OS-trash call,
    /// which only takes paths. Nothing here opens it again.
    path: PathBuf,
}

/// Open `base.join(rel_dir)` as a directory without following any symlink,
/// creating missing components of `rel_dir` (`0o755`) when `create` is set.
/// `base` must be absolute and canonical: the resolver's validated graph
/// root or local-only link target. `rel_dir` is plain relative components;
/// empty opens the base itself. Any symlink or non-directory on the way is
/// [`BeneathError::Traversal`], and so is any directory below the base that
/// holds a `.git` entry (the base is the resolver's to check: a graph root
/// holds its backup repository).
pub(crate) fn open_dir_beneath(
    base: &Path,
    rel_dir: &Path,
    create: bool,
) -> BeneathResult<BeneathDir> {
    if !base.is_absolute() {
        return Err(BeneathError::Traversal(format!(
            "not an absolute base: {}",
            base.display()
        )));
    }
    let mut names = Vec::new();
    for component in rel_dir.components() {
        match component {
            Component::Normal(name) => names.push(name),
            Component::CurDir => {}
            _ => {
                return Err(BeneathError::Traversal(format!(
                    "not a plain relative directory: {}",
                    rel_dir.display()
                )))
            }
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(BASE_NOFOLLOW | libc::O_DIRECTORY)
        .open(base)
        .map_err(|err| match Errno::from_io_error(&err) {
            Some(errno) if is_walk_refusal(errno) => refused_dir(base),
            _ => BeneathError::Io(err),
        })?;
    let mut dir = BeneathDir {
        file,
        path: base.to_path_buf(),
    };
    let create = create.then_some(DIR_MODE);
    for name in names {
        dir = descend(&dir, name, create)?;
    }
    Ok(dir)
}

/// `ELOOP` (a symlink under `O_NOFOLLOW`) or `ENOTDIR` (a non-directory, and
/// Linux's answer for a symlink under `O_DIRECTORY | O_NOFOLLOW`).
fn is_walk_refusal(errno: Errno) -> bool {
    errno == Errno::LOOP || errno == Errno::NOTDIR
}

fn refused_dir(path: &Path) -> BeneathError {
    BeneathError::Traversal(format!(
        "a symlink or non-directory is in the way: {}",
        path.display()
    ))
}

/// Open the directory `name` below `parent` without following it, first
/// creating it when it is missing and `create` holds a mode, and refuse it
/// when it is a Git work tree of its own (a `.git` directory, `gitdir:`
/// file, or link).
fn descend(parent: &BeneathDir, name: &OsStr, create: Option<Mode>) -> BeneathResult<BeneathDir> {
    let path = parent.path.join(name);
    let opened = match (open_dir_at(parent, name), create) {
        (Err(Errno::NOENT), Some(mode)) => match rustix::fs::mkdirat(&parent.file, name, mode) {
            Ok(()) | Err(Errno::EXIST) => open_dir_at(parent, name),
            Err(errno) => Err(errno),
        },
        (opened, _) => opened,
    };
    let fd = opened.map_err(|errno| {
        if is_walk_refusal(errno) {
            refused_dir(&path)
        } else {
            errno.into()
        }
    })?;
    let dir = BeneathDir {
        file: File::from(fd),
        path,
    };
    match rustix::fs::statat(&dir.file, ".git", AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => Err(BeneathError::Traversal(format!(
            "inside a nested Git work tree: {}",
            dir.path.display()
        ))),
        Err(Errno::NOENT) => Ok(dir),
        Err(errno) => Err(errno.into()),
    }
}

fn open_dir_at(parent: &BeneathDir, name: &OsStr) -> rustix::io::Result<OwnedFd> {
    rustix::fs::openat(
        &parent.file,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
}

/// Walk Reflect's own subdirectories (`.reflect/…`) below `from` the way
/// [`open_dir_beneath`] walks a relative directory.
fn walk(from: &BeneathDir, names: &[&str], create: Option<Mode>) -> BeneathResult<BeneathDir> {
    let mut dir = BeneathDir {
        file: from.file.try_clone()?,
        path: from.path.clone(),
    };
    for name in names {
        dir = descend(&dir, OsStr::new(name), create)?;
    }
    Ok(dir)
}

/// `name` when it is one plain path component: not empty, `.`, or `..`, and
/// free of `/` and NUL.
fn plain_name(name: &OsStr) -> BeneathResult<&OsStr> {
    let bytes = name.as_bytes();
    if bytes.is_empty()
        || bytes == b"."
        || bytes == b".."
        || bytes.contains(&b'/')
        || bytes.contains(&0)
    {
        return Err(BeneathError::Traversal(format!(
            "not a plain file name: {}",
            name.to_string_lossy()
        )));
    }
    Ok(name)
}

/// The file a name held when it was read: device, inode, size, and
/// modification and status-change times in nanoseconds. A replace commits
/// only while the name still holds exactly this file. `i128` holds every
/// platform's `stat` field types without a cast.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Identity {
    dev: i128,
    ino: i128,
    size: i128,
    mtime_ns: i128,
    ctime_ns: i128,
}

impl Identity {
    fn of(stat: &Stat) -> Self {
        let nanos = |secs: i128, nsecs: i128| secs * 1_000_000_000 + nsecs;
        Self {
            dev: i128::from(stat.st_dev),
            ino: i128::from(stat.st_ino),
            size: i128::from(stat.st_size),
            mtime_ns: nanos(i128::from(stat.st_mtime), i128::from(stat.st_mtime_nsec)),
            ctime_ns: nanos(i128::from(stat.st_ctime), i128::from(stat.st_ctime_nsec)),
        }
    }
}

/// A regular file's bytes and the file they came from.
#[derive(Debug)]
pub(crate) struct FileBytes {
    /// Everything the file held.
    pub(crate) bytes: Vec<u8>,
    /// What a [`Persist::Replace`] built on these bytes must still find.
    pub(crate) identity: Identity,
}

/// Read the regular file `name` in `dir`. The open never follows a symlink
/// and never blocks: with `O_NONBLOCK`, a FIFO planted at the name refuses
/// at once instead of waiting for a writer. Anything but a regular file is
/// [`BeneathError::Traversal`]. A dataless file is [`BeneathError::Offline`],
/// and materialization stays off for the whole read ([`NoMaterialize`]), so
/// an eviction racing the check (`EDEADLK`) is too, never a download.
pub(crate) fn read_beneath(dir: &BeneathDir, name: impl AsRef<OsStr>) -> BeneathResult<FileBytes> {
    let name = plain_name(name.as_ref())?;
    let _no_materialize = NoMaterialize::engage();
    let (mut file, stat) = open_file(dir, name)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(BeneathError::Traversal(format!(
            "not a regular file: {}",
            dir.path.join(name).display()
        )));
    }
    if dataless(&file)? {
        return Err(BeneathError::Offline);
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).map_err(|err| {
        if err.kind() == std::io::ErrorKind::Deadlock {
            BeneathError::Offline
        } else {
            err.into()
        }
    })?;
    Ok(FileBytes {
        bytes,
        identity: Identity::of(&stat),
    })
}

/// Open `name` read-only without following it or blocking on it, with its
/// `stat`.
fn open_file(dir: &BeneathDir, name: &OsStr) -> BeneathResult<(File, Stat)> {
    let fd = rustix::fs::openat(
        &dir.file,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|errno| match errno {
        Errno::LOOP => BeneathError::Traversal(format!(
            "a symlink is in the way: {}",
            dir.path.join(name).display()
        )),
        Errno::DEADLK => BeneathError::Offline,
        errno => errno.into(),
    })?;
    let file = File::from(fd);
    let stat = rustix::fs::fstat(&file)?;
    Ok((file, stat))
}

/// [`is_dataless`] on an open file's metadata.
fn dataless(file: &File) -> BeneathResult<bool> {
    #[cfg(test)]
    if seam::DATALESS.get() {
        return Ok(true);
    }
    Ok(is_dataless(&file.metadata()?))
}

/// How [`persist_beneath`] may treat the name it writes.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Persist {
    /// Replace the file a [`read_beneath`] returned, only while the name
    /// still holds it.
    Replace(Identity),
    /// Create the file, only while the name is free.
    NoClobber,
}

/// What [`persist_beneath`] did. Only `Replaced` and `Created` changed
/// anything; both carry the new file's mtime in epoch milliseconds when the
/// platform reports one.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Persisted {
    /// The new bytes replaced the file that was read.
    Replaced(Option<u64>),
    /// The new bytes claimed the free name.
    Created(Option<u64>),
    /// [`Persist::Replace`]: the name no longer holds the file that was read.
    ChangedOnDisk,
    /// [`Persist::NoClobber`]: something already holds the name.
    Collision,
}

/// Atomically write `bytes` to `name` in `dir`. The temp file (`0o600`,
/// created with `O_EXCL | O_NOFOLLOW` under a random name) sits in
/// `.reflect/tmp/`, walked from `graph_root` like any directory here, or
/// beside the target under a hidden name when the staging directory is on
/// another volume. A replace carries the old file's permission bits and
/// provider-ignore attributes over. The bytes are flushed (`F_FULLFSYNC` on
/// Apple platforms) before one rename lands them: a replace re-checks the
/// name's [`Identity`] right before renaming, a create renames with
/// `RENAME_EXCL` / `RENAME_NOREPLACE`. Every path that does not land the
/// bytes unlinks the temp.
pub(crate) fn persist_beneath(
    graph_root: &BeneathDir,
    dir: &BeneathDir,
    name: impl AsRef<OsStr>,
    bytes: &[u8],
    persist: Persist,
) -> BeneathResult<Persisted> {
    let name = plain_name(name.as_ref())?;
    let carried = match persist {
        Persist::Replace(expected) => match carried_from(dir, name, expected)? {
            Some(carried) => Some(carried),
            None => return Ok(Persisted::ChangedOnDisk),
        },
        Persist::NoClobber => None,
    };
    let staged = Staged::write(graph_root, dir, bytes, carried.as_ref())?;
    #[cfg(test)]
    seam::before_commit()?;
    match persist {
        Persist::Replace(expected) => {
            if identity_at(dir, name)? != Some(expected) {
                return Ok(Persisted::ChangedOnDisk);
            }
            rustix::fs::renameat(staged.dir(), staged.name.as_str(), &dir.file, name)?;
        }
        Persist::NoClobber => match rustix::fs::renameat_with(
            staged.dir(),
            staged.name.as_str(),
            &dir.file,
            name,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {}
            Err(Errno::EXIST) => return Ok(Persisted::Collision),
            Err(errno) => return Err(errno.into()),
        },
    }
    let modified_ms = staged.landed();
    sync_dir(dir);
    Ok(match persist {
        Persist::Replace(_) => Persisted::Replaced(modified_ms),
        Persist::NoClobber => Persisted::Created(modified_ms),
    })
}

/// What a replace carries from the old file to the new one: its permission
/// bits and, on macOS, the provider-ignore attributes that keep a file out
/// of File Provider and Dropbox sync.
struct Carried {
    mode: Mode,
    #[cfg(target_os = "macos")]
    xattrs: Vec<(&'static str, Vec<u8>)>,
}

impl Carried {
    #[cfg(target_os = "macos")]
    fn of(file: &File, stat: &Stat) -> std::io::Result<Self> {
        use xattr::FileExt;
        let mut xattrs = Vec::new();
        for (name, _) in super::io::LOCAL_ONLY_XATTRS {
            if let Some(value) = file.get_xattr(name)? {
                xattrs.push((name, value));
            }
        }
        Ok(Self {
            mode: Mode::from_raw_mode(stat.st_mode) & PERMISSION_BITS,
            xattrs,
        })
    }

    #[cfg(not(target_os = "macos"))]
    fn of(_file: &File, stat: &Stat) -> std::io::Result<Self> {
        Ok(Self {
            mode: Mode::from_raw_mode(stat.st_mode) & PERMISSION_BITS,
        })
    }

    fn apply(&self, file: &File) -> BeneathResult<()> {
        rustix::fs::fchmod(file, self.mode)?;
        #[cfg(target_os = "macos")]
        {
            use xattr::FileExt;
            for (name, value) in &self.xattrs {
                file.set_xattr(name, value)?;
            }
        }
        Ok(())
    }
}

/// What a replace carries over from the file at `name`, or `None` when the
/// name no longer holds the `expected` file. Materialization stays off: the
/// attributes are metadata, and a save is never worth a download.
fn carried_from(
    dir: &BeneathDir,
    name: &OsStr,
    expected: Identity,
) -> BeneathResult<Option<Carried>> {
    let _no_materialize = NoMaterialize::engage();
    let (file, stat) = match missing_as_none(open_file(dir, name)) {
        Ok(Some(opened)) => opened,
        Ok(None) | Err(BeneathError::Traversal(_)) => return Ok(None),
        Err(err) => return Err(err),
    };
    if Identity::of(&stat) != expected {
        return Ok(None);
    }
    Ok(Some(Carried::of(&file, &stat)?))
}

/// The identity of whatever `name` holds now, without following it; `None`
/// when nothing does.
fn identity_at(dir: &BeneathDir, name: &OsStr) -> BeneathResult<Option<Identity>> {
    match rustix::fs::statat(&dir.file, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => Ok(Some(Identity::of(&stat))),
        Err(Errno::NOENT) => Ok(None),
        Err(errno) => Err(errno.into()),
    }
}

/// A flushed temp file holding new bytes, unlinked on drop unless it landed.
struct Staged<'a> {
    /// `.reflect/tmp/`, or `None` when the temp sits beside the target.
    staging: Option<BeneathDir>,
    target: &'a BeneathDir,
    name: String,
    file: File,
    landed: bool,
}

impl<'a> Staged<'a> {
    fn write(
        graph_root: &BeneathDir,
        target: &'a BeneathDir,
        bytes: &[u8],
        carried: Option<&Carried>,
    ) -> BeneathResult<Self> {
        let staging = staging_dir(graph_root, target)?;
        let name = format!(".reflect-tmp-{}", random_hex()?);
        let fd = rustix::fs::openat(
            &staging.as_ref().unwrap_or(target).file,
            name.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            TEMP_MODE,
        )?;
        let mut staged = Self {
            staging,
            target,
            name,
            file: File::from(fd),
            landed: false,
        };
        if let Some(carried) = carried {
            carried.apply(&staged.file)?;
        }
        staged.file.write_all(bytes)?;
        staged.file.sync_all()?;
        Ok(staged)
    }

    /// The directory holding the temp.
    fn dir(&self) -> &File {
        &self.staging.as_ref().unwrap_or(self.target).file
    }

    /// The temp now holds the target's name: keep it, and report its mtime
    /// from its own descriptor.
    fn landed(mut self) -> Option<u64> {
        self.landed = true;
        self.file.metadata().ok().as_ref().and_then(modified_ms)
    }
}

impl Drop for Staged<'_> {
    fn drop(&mut self) {
        if !self.landed {
            let _ = rustix::fs::unlinkat(self.dir(), self.name.as_str(), AtFlags::empty());
        }
    }
}

/// `.reflect/tmp/` under the graph root when it shares `target`'s volume, so
/// the final rename stays atomic; `None` puts the temp beside the target.
fn staging_dir(graph_root: &BeneathDir, target: &BeneathDir) -> BeneathResult<Option<BeneathDir>> {
    let staging = walk(graph_root, &[REFLECT_DIR, STAGING_DIR], Some(DIR_MODE))?;
    #[cfg(test)]
    if seam::STAGING_ELSEWHERE.get() {
        return Ok(None);
    }
    Ok(same_volume(&staging, target)?.then_some(staging))
}

fn same_volume(one: &BeneathDir, other: &BeneathDir) -> BeneathResult<bool> {
    Ok(rustix::fs::fstat(&one.file)?.st_dev == rustix::fs::fstat(&other.file)?.st_dev)
}

/// Flush the directory entry a rename changed. Best-effort: the bytes have
/// already landed, and failing now would report a landed save as lost.
fn sync_dir(dir: &BeneathDir) {
    if let Err(err) = dir.file.sync_all() {
        tracing::warn!(path = %dir.path.display(), %err, "failed to flush a directory after a rename");
    }
}

/// What [`rename_beneath`] did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Renamed {
    /// The entry moved, or only its spelling changed.
    Moved,
    /// The destination holds another entry; nothing moved.
    Collision,
}

/// Rename `from_name` in `from_dir` to `to_name` in `to_dir`, never replacing
/// an entry (`RENAME_EXCL` / `RENAME_NOREPLACE`) or following a symlink. A
/// respelling (`a.md` → `A.md`) on a case-insensitive volume renames
/// outright on APFS; a volume that instead reports the file itself as the
/// collision gets the plain rename, when the destination is the source's
/// only directory entry (same device and inode, and one link or a
/// directory). Two links of one file stay a collision: renaming one onto the
/// other would report success and move nothing. Crossing volumes is
/// [`BeneathError::CrossDevice`].
pub(crate) fn rename_beneath(
    from_dir: &BeneathDir,
    from_name: impl AsRef<OsStr>,
    to_dir: &BeneathDir,
    to_name: impl AsRef<OsStr>,
) -> BeneathResult<Renamed> {
    let from_name = plain_name(from_name.as_ref())?;
    let to_name = plain_name(to_name.as_ref())?;
    match rustix::fs::renameat_with(
        &from_dir.file,
        from_name,
        &to_dir.file,
        to_name,
        RenameFlags::NOREPLACE,
    ) {
        Ok(()) => Ok(Renamed::Moved),
        Err(Errno::EXIST) if respelling(from_dir, from_name, to_dir, to_name)? => {
            rustix::fs::renameat(&from_dir.file, from_name, &to_dir.file, to_name)
                .map_err(rename_error)?;
            Ok(Renamed::Moved)
        }
        Err(Errno::EXIST) => Ok(Renamed::Collision),
        Err(errno) => Err(rename_error(errno)),
    }
}

/// Whether the destination is the source's own directory entry under
/// another spelling: the same file, with no other link to it.
fn respelling(
    from_dir: &BeneathDir,
    from_name: &OsStr,
    to_dir: &BeneathDir,
    to_name: &OsStr,
) -> BeneathResult<bool> {
    let source = rustix::fs::statat(&from_dir.file, from_name, AtFlags::SYMLINK_NOFOLLOW)?;
    let destination = rustix::fs::statat(&to_dir.file, to_name, AtFlags::SYMLINK_NOFOLLOW)?;
    let only_entry =
        source.st_nlink == 1 || FileType::from_raw_mode(source.st_mode) == FileType::Directory;
    Ok(source.st_dev == destination.st_dev && source.st_ino == destination.st_ino && only_entry)
}

fn rename_error(errno: Errno) -> BeneathError {
    if errno == Errno::XDEV {
        BeneathError::CrossDevice
    } else {
        errno.into()
    }
}

/// Move `name` out of `dir` into a fresh `.reflect/trash/<128-bit random>/`
/// directory (`0o700`, walked from `graph_root`) and return its path there
/// for the OS trash: that call only takes a path, and this one names a
/// directory nothing else can occupy. The move never replaces an entry or
/// follows a symlink, and must stay on the note's volume (else
/// [`BeneathError::CrossDevice`]). On failure the note stays where it was.
pub(crate) fn trash_beneath(
    graph_root: &BeneathDir,
    dir: &BeneathDir,
    name: impl AsRef<OsStr>,
) -> BeneathResult<PathBuf> {
    let name = plain_name(name.as_ref())?;
    let trash = walk(
        graph_root,
        &[REFLECT_DIR, TRASH_DIR],
        Some(PRIVATE_DIR_MODE),
    )?;
    let slot = random_hex()?;
    rustix::fs::mkdirat(&trash.file, slot.as_str(), PRIVATE_DIR_MODE)?;
    let moved = move_into_slot(&trash, &slot, dir, name);
    if moved.is_err() {
        let _ = rustix::fs::unlinkat(&trash.file, slot.as_str(), AtFlags::REMOVEDIR);
    }
    moved
}

fn move_into_slot(
    trash: &BeneathDir,
    slot: &str,
    dir: &BeneathDir,
    name: &OsStr,
) -> BeneathResult<PathBuf> {
    let slot_dir = descend(trash, OsStr::new(slot), None)?;
    if !same_volume(&slot_dir, dir)? {
        return Err(BeneathError::CrossDevice);
    }
    rustix::fs::renameat_with(
        &dir.file,
        name,
        &slot_dir.file,
        name,
        RenameFlags::NOREPLACE,
    )
    .map_err(rename_error)?;
    Ok(slot_dir.path.join(name))
}

/// One note's unsaved text, kept when a save could not land.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryCopy {
    /// The graph-relative path the text was written for.
    pub(crate) path: String,
    /// When the copy was written, in epoch milliseconds.
    pub(crate) saved_at_ms: u64,
    /// The unsaved buffer, verbatim.
    pub(crate) contents: String,
}

/// Keep `contents` as `path`'s recovery copy (mode `0o600`, in `0o700`
/// `.reflect/recovery/`), replacing any earlier copy atomically. Staged and
/// walked like every write here.
pub(crate) fn write_recovery(
    graph_root: &BeneathDir,
    path: &str,
    contents: &str,
) -> BeneathResult<()> {
    let dir = walk(
        graph_root,
        &[REFLECT_DIR, RECOVERY_DIR],
        Some(PRIVATE_DIR_MODE),
    )?;
    let copy = RecoveryCopy {
        path: path.to_owned(),
        saved_at_ms: now_ms(),
        contents: contents.to_owned(),
    };
    let json = serde_json::to_vec(&copy).map_err(std::io::Error::other)?;
    let staged = Staged::write(graph_root, &dir, &json, None)?;
    rustix::fs::renameat(
        staged.dir(),
        staged.name.as_str(),
        &dir.file,
        recovery_slot(path).as_str(),
    )?;
    staged.landed();
    sync_dir(&dir);
    Ok(())
}

/// `path`'s recovery copy, or `None` when it has none.
pub(crate) fn read_recovery(
    graph_root: &BeneathDir,
    path: &str,
) -> BeneathResult<Option<RecoveryCopy>> {
    let Some(dir) = missing_as_none(walk(graph_root, &[REFLECT_DIR, RECOVERY_DIR], None))? else {
        return Ok(None);
    };
    let Some(read) = missing_as_none(read_beneath(&dir, recovery_slot(path)))? else {
        return Ok(None);
    };
    serde_json::from_slice(&read.bytes)
        .map(Some)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err).into())
}

/// Drop `path`'s recovery copy; having none is fine.
pub(crate) fn clear_recovery(graph_root: &BeneathDir, path: &str) -> BeneathResult<()> {
    let Some(dir) = missing_as_none(walk(graph_root, &[REFLECT_DIR, RECOVERY_DIR], None))? else {
        return Ok(());
    };
    match rustix::fs::unlinkat(&dir.file, recovery_slot(path).as_str(), AtFlags::empty()) {
        Ok(()) | Err(Errno::NOENT) => Ok(()),
        Err(errno) => Err(errno.into()),
    }
}

/// A note's recovery slot: the SHA-256 of its path folded to lowercase, so
/// the spellings APFS opens as one file (`Notes/A.md`, `notes/a.md`) share a
/// slot. Unicode normalization is not folded; callers pass the indexed
/// spelling.
fn recovery_slot(path: &str) -> String {
    format!(
        "{}.json",
        hex(&Sha256::digest(path.to_lowercase().as_bytes()))
    )
}

/// `Ok(None)` for something missing, so absence is an answer, not an error.
fn missing_as_none<T>(result: BeneathResult<T>) -> BeneathResult<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(BeneathError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// 128 random bits as 32 hex digits: a staging or trash name nothing else
/// can guess or hold.
fn random_hex() -> BeneathResult<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|err| std::io::Error::other(err.to_string()))?;
    Ok(hex(&bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Test-only fault and platform injection, thread-local so parallel tests
/// never see each other's.
#[cfg(test)]
mod seam {
    use std::cell::{Cell, RefCell};

    type Hook = Box<dyn FnMut() -> std::io::Result<()>>;

    thread_local! {
        /// Runs once the temp is flushed, before the commit's identity check
        /// and rename; an error stands in for the rename failing.
        pub(super) static BEFORE_COMMIT: RefCell<Option<Hook>> = const { RefCell::new(None) };
        /// Report `.reflect/tmp/` as if it sat on another volume.
        pub(super) static STAGING_ELSEWHERE: Cell<bool> = const { Cell::new(false) };
        /// Report every opened file as dataless: userland cannot set
        /// `SF_DATALESS`, so no fixture can be made.
        pub(super) static DATALESS: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn before_commit() -> std::io::Result<()> {
        BEFORE_COMMIT.with_borrow_mut(|hook| hook.as_mut().map_or(Ok(()), |hook| hook()))
    }

    pub(super) fn reset() {
        BEFORE_COMMIT.set(None);
        STAGING_ELSEWHERE.set(false);
        DATALESS.set(false);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::fs;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::{mpsc, Barrier};
    use std::time::Duration;

    use tempfile::TempDir;

    use super::*;
    use crate::fs::io::bootstrap;

    /// A bootstrapped graph and a raw-store folder beside it, both canonical:
    /// `O_NOFOLLOW_ANY` refuses macOS's `/var` → `/private/var` link.
    struct Fixture {
        _dir: TempDir,
        graph: PathBuf,
        raw: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let base = dir.path().canonicalize().unwrap();
            let graph = base.join("graph");
            bootstrap(&graph).unwrap();
            fs::write(graph.join("notes/kept.md"), "# Kept\n").unwrap();
            let raw = base.join("raw/secure");
            fs::create_dir_all(&raw).unwrap();
            Self {
                _dir: dir,
                graph,
                raw,
            }
        }

        fn root(&self) -> BeneathDir {
            open_dir_beneath(&self.graph, Path::new(""), false).unwrap()
        }

        fn raw_dir(&self, rel: &str) -> BeneathDir {
            open_dir_beneath(&self.raw, Path::new(rel), true).unwrap()
        }

        fn staging(&self) -> Vec<String> {
            entries(&self.graph.join(".reflect/tmp"))
        }
    }

    /// Clears the test seams however the test ends.
    struct Seams;

    impl Drop for Seams {
        fn drop(&mut self) {
            seam::reset();
        }
    }

    /// The names in `dir`, sorted; none when it does not exist.
    fn entries(dir: &Path) -> Vec<String> {
        let Ok(listing) = fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = listing
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Every entry below `dir`: file bytes, link targets, and directories.
    fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut found = BTreeMap::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(current) = pending.pop() {
            for entry in fs::read_dir(&current).unwrap() {
                let path = entry.unwrap().path();
                let file_type = fs::symlink_metadata(&path).unwrap().file_type();
                let contents = if file_type.is_symlink() {
                    fs::read_link(&path)
                        .unwrap()
                        .as_os_str()
                        .as_bytes()
                        .to_vec()
                } else if file_type.is_dir() {
                    pending.push(path.clone());
                    b"<dir>".to_vec()
                } else {
                    fs::read(&path).unwrap()
                };
                found.insert(path.strip_prefix(dir).unwrap().to_path_buf(), contents);
            }
        }
        found
    }

    fn fail_the_rename() -> std::io::Result<()> {
        Err(std::io::Error::other("injected rename failure"))
    }

    #[test]
    fn writes_land_and_report_the_new_files_mtime() {
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir("deep/er"));
        let target = fixture.raw.join("deep/er/note.md");

        let Persisted::Created(Some(created_ms)) =
            persist_beneath(&root, &dir, "note.md", b"# One\n", Persist::NoClobber).unwrap()
        else {
            panic!("the create should land with an mtime");
        };
        assert_eq!(
            Some(created_ms),
            modified_ms(&fs::metadata(&target).unwrap())
        );
        let read = read_beneath(&dir, "note.md").unwrap();
        assert_eq!(read.bytes, b"# One\n");

        let Persisted::Replaced(Some(replaced_ms)) = persist_beneath(
            &root,
            &dir,
            "note.md",
            b"# Two\n",
            Persist::Replace(read.identity),
        )
        .unwrap() else {
            panic!("the replace should land with an mtime");
        };
        assert_eq!(
            Some(replaced_ms),
            modified_ms(&fs::metadata(&target).unwrap())
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Two\n");
        assert_eq!(entries(&dir.path), vec!["note.md"]);
        assert_eq!(fixture.staging(), Vec::<String>::new());
    }

    /// (a) A directory below the target swapped for a link into `notes/`
    /// after validation: refused when the walk meets the link, and written
    /// into the pinned, moved-aside directory when the swap comes after the
    /// open. Either way `notes/` stays byte-identical.
    #[test]
    fn a_a_swapped_subdirectory_never_redirects_a_write_into_notes() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let notes = fixture.graph.join("notes");
        let before = snapshot(&notes);
        let (sub, aside) = (fixture.raw.join("sub"), fixture.raw.join("sub-aside"));
        fs::create_dir(&aside).unwrap();

        symlink(&notes, &sub).unwrap();
        assert!(matches!(
            open_dir_beneath(&fixture.raw, Path::new("sub"), true),
            Err(BeneathError::Traversal(_))
        ));

        fs::remove_file(&sub).unwrap();
        fs::rename(&aside, &sub).unwrap();
        let dir = fixture.raw_dir("sub");
        fs::rename(&sub, &aside).unwrap();
        symlink(&notes, &sub).unwrap();
        assert!(matches!(
            persist_beneath(&root, &dir, "x.md", b"# X\n", Persist::NoClobber),
            Ok(Persisted::Created(_))
        ));
        assert_eq!(fs::read(aside.join("x.md")).unwrap(), b"# X\n");

        assert_eq!(snapshot(&notes), before);
    }

    /// (b) The base itself swapped for a link: refused, and nothing is
    /// created through it.
    #[test]
    fn b_a_base_swapped_for_a_symlink_is_refused() {
        let fixture = Fixture::new();
        let notes = fixture.graph.join("notes");
        let before = snapshot(&notes);
        fs::rename(&fixture.raw, fixture.raw.with_file_name("secure-aside")).unwrap();
        symlink(&notes, &fixture.raw).unwrap();

        for rel in ["", "sub"] {
            assert!(
                matches!(
                    open_dir_beneath(&fixture.raw, Path::new(rel), true),
                    Err(BeneathError::Traversal(_))
                ),
                "{rel:?}"
            );
        }
        assert_eq!(snapshot(&notes), before);
    }

    /// (b) On Apple platforms a link at any component of the base refuses,
    /// not just at its last one.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    #[test]
    fn b_a_symlink_anywhere_in_the_base_is_refused() {
        let fixture = Fixture::new();
        let raw_root = fixture.raw.parent().unwrap();
        let link = raw_root.with_file_name("raw-link");
        symlink(raw_root, &link).unwrap();

        assert!(matches!(
            open_dir_beneath(&link.join("secure"), Path::new(""), false),
            Err(BeneathError::Traversal(_))
        ));
        assert!(open_dir_beneath(&fixture.raw, Path::new(""), false).is_ok());
    }

    /// (c) A symlinked final component: the checked read refuses.
    #[test]
    fn c_a_symlinked_file_is_never_read() {
        let fixture = Fixture::new();
        symlink(
            fixture.graph.join("notes/kept.md"),
            fixture.raw.join("leaf.md"),
        )
        .unwrap();
        let dir = fixture.raw_dir("");

        assert!(matches!(
            read_beneath(&dir, "leaf.md"),
            Err(BeneathError::Traversal(_))
        ));
    }

    /// (d) `NoClobber` never replaces a file, and of two racing creates
    /// exactly one lands.
    #[test]
    fn d_no_clobber_claims_only_a_free_name() {
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        fs::write(fixture.raw.join("taken.md"), "# Theirs\n").unwrap();

        assert_eq!(
            persist_beneath(&root, &dir, "taken.md", b"# Ours\n", Persist::NoClobber).unwrap(),
            Persisted::Collision
        );
        assert_eq!(
            fs::read_to_string(fixture.raw.join("taken.md")).unwrap(),
            "# Theirs\n"
        );

        let barrier = Barrier::new(2);
        let outcomes: Vec<(&[u8], Persisted)> = std::thread::scope(|scope| {
            let claims: Vec<_> = [b"# First\n".as_slice(), b"# Second\n".as_slice()]
                .into_iter()
                .map(|bytes| {
                    let (root, dir, barrier) = (&root, &dir, &barrier);
                    scope.spawn(move || {
                        barrier.wait();
                        let outcome =
                            persist_beneath(root, dir, "claim.md", bytes, Persist::NoClobber);
                        (bytes, outcome.unwrap())
                    })
                })
                .collect();
            claims
                .into_iter()
                .map(|claim| claim.join().unwrap())
                .collect()
        });
        let created: Vec<&[u8]> = outcomes
            .iter()
            .filter(|(_, outcome)| matches!(outcome, Persisted::Created(_)))
            .map(|(bytes, _)| *bytes)
            .collect();
        assert_eq!(created.len(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|(_, outcome)| *outcome == Persisted::Collision)
                .count(),
            1
        );
        assert_eq!(fs::read(fixture.raw.join("claim.md")).unwrap(), created[0]);
        assert_eq!(fixture.staging(), Vec::<String>::new());
    }

    /// (e) A rename that fails leaves the folder as it was and staging empty.
    #[test]
    fn e_a_failed_rename_changes_nothing() {
        let _seams = Seams;
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        fs::write(fixture.raw.join("note.md"), "# Old\n").unwrap();
        let read = read_beneath(&dir, "note.md").unwrap();
        let before = snapshot(&fixture.raw);
        seam::BEFORE_COMMIT.set(Some(Box::new(fail_the_rename)));

        assert!(persist_beneath(
            &root,
            &dir,
            "note.md",
            b"# New\n",
            Persist::Replace(read.identity)
        )
        .is_err());
        assert!(
            persist_beneath(&root, &dir, "fresh.md", b"# Fresh\n", Persist::NoClobber).is_err()
        );

        assert_eq!(snapshot(&fixture.raw), before);
        assert_eq!(fixture.staging(), Vec::<String>::new());
    }

    /// (f) With `.reflect/tmp/` on another volume the temp sits beside the
    /// target under a hidden name, and a failed write removes it.
    #[test]
    fn f_the_beside_target_temp_is_removed_on_failure() {
        let _seams = Seams;
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        seam::STAGING_ELSEWHERE.set(true);
        let raw = fixture.raw.clone();
        seam::BEFORE_COMMIT.set(Some(Box::new(move || {
            let temps = entries(&raw)
                .into_iter()
                .filter(|name| name.starts_with(".reflect-tmp-"))
                .count();
            assert_eq!(temps, 1, "the temp should sit beside the target");
            fail_the_rename()
        })));

        assert!(persist_beneath(&root, &dir, "note.md", b"# New\n", Persist::NoClobber).is_err());
        assert_eq!(entries(&fixture.raw), Vec::<String>::new());
        assert_eq!(fixture.staging(), Vec::<String>::new());

        seam::BEFORE_COMMIT.set(None);
        assert!(matches!(
            persist_beneath(&root, &dir, "note.md", b"# New\n", Persist::NoClobber),
            Ok(Persisted::Created(_))
        ));
        assert_eq!(entries(&fixture.raw), vec!["note.md"]);
    }

    /// The sync and backup exclusions `mark_dir_local_only` stores as
    /// extended attributes.
    #[cfg(target_os = "macos")]
    const EXCLUSION_MARKS: [&str; 3] = [
        "com.apple.fileprovider.ignore#P",
        "com.dropbox.ignored",
        "com.apple.metadata:com_apple_backup_excludeItem",
    ];

    #[cfg(target_os = "macos")]
    fn exclusion_marks(path: &Path) -> Vec<String> {
        xattr::list(path)
            .unwrap()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| EXCLUSION_MARKS.contains(&name.as_str()))
            .collect()
    }

    /// (g) A fresh file carries no provider-ignore or backup-exclusion mark,
    /// though it was staged inside `.reflect/`, which carries them all.
    #[cfg(target_os = "macos")]
    #[test]
    fn g_a_fresh_file_carries_no_exclusion_marks() {
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        assert_eq!(
            exclusion_marks(&fixture.graph.join(".reflect")).len(),
            EXCLUSION_MARKS.len()
        );

        assert!(matches!(
            persist_beneath(&root, &dir, "fresh.md", b"# Fresh\n", Persist::NoClobber),
            Ok(Persisted::Created(_))
        ));
        assert_eq!(
            exclusion_marks(&fixture.raw.join("fresh.md")),
            Vec::<String>::new()
        );
    }

    /// (h) Creating directories refuses a symlinked intermediate one and
    /// creates nothing through it.
    #[test]
    fn h_creating_directories_refuses_a_symlinked_intermediate() {
        let fixture = Fixture::new();
        let notes = fixture.graph.join("notes");
        symlink(&notes, fixture.raw.join("link")).unwrap();
        let before = snapshot(&notes);

        assert!(matches!(
            open_dir_beneath(&fixture.raw, Path::new("link/new"), true),
            Err(BeneathError::Traversal(_))
        ));
        assert_eq!(snapshot(&notes), before);
        assert!(open_dir_beneath(&fixture.raw, Path::new("real/new"), true).is_ok());
        assert!(fixture.raw.join("real/new").is_dir());
    }

    fn make_fifo(path: &Path) {
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o644) }, 0);
    }

    /// (i) A FIFO at the note's name errors at once instead of waiting for a
    /// writer, and a save of another note meanwhile completes.
    #[test]
    fn i_a_fifo_at_the_name_errors_without_blocking_other_saves() {
        let fixture = Fixture::new();
        make_fifo(&fixture.raw.join("pipe.md"));
        let reader_dir = fixture.raw_dir("");
        let (sender, receiver) = mpsc::channel();
        // Unscoped, so a regression that blocks fails the timeout below
        // instead of hanging the test.
        std::thread::spawn(move || {
            let _ = sender.send(read_beneath(&reader_dir, "pipe.md").map(|read| read.bytes));
        });

        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        assert!(matches!(
            persist_beneath(&root, &dir, "other.md", b"# Other\n", Persist::NoClobber),
            Ok(Persisted::Created(_))
        ));
        let read = receiver
            .recv_timeout(Duration::from_secs(10))
            .expect("a FIFO read must not block");
        assert!(matches!(read, Err(BeneathError::Traversal(_))));
    }

    /// (j) The target replaced between the read and the rename:
    /// `ChangedOnDisk`, and the newcomer's bytes stand.
    #[test]
    fn j_a_target_replaced_before_the_rename_is_changed_on_disk() {
        let _seams = Seams;
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        let target = fixture.raw.join("note.md");
        fs::write(&target, "# Old\n").unwrap();
        let read = read_beneath(&dir, "note.md").unwrap();
        let raw = fixture.raw.clone();
        seam::BEFORE_COMMIT.set(Some(Box::new(move || {
            fs::write(raw.join("theirs.tmp"), "# Theirs\n")?;
            fs::rename(raw.join("theirs.tmp"), raw.join("note.md"))
        })));

        assert_eq!(
            persist_beneath(
                &root,
                &dir,
                "note.md",
                b"# Ours\n",
                Persist::Replace(read.identity)
            )
            .unwrap(),
            Persisted::ChangedOnDisk
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Theirs\n");
        assert_eq!(fixture.staging(), Vec::<String>::new());

        // A replace that starts after the change refuses before staging.
        seam::BEFORE_COMMIT.set(None);
        assert_eq!(
            persist_beneath(
                &root,
                &dir,
                "note.md",
                b"# Ours\n",
                Persist::Replace(read.identity)
            )
            .unwrap(),
            Persisted::ChangedOnDisk
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Theirs\n");
    }

    /// (k) Replace keeps the old file's permission bits.
    #[test]
    fn k_replace_keeps_permission_bits() {
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        let target = fixture.raw.join("note.md");
        fs::write(&target, "# Old\n").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        let read = read_beneath(&dir, "note.md").unwrap();

        assert!(matches!(
            persist_beneath(
                &root,
                &dir,
                "note.md",
                b"# New\n",
                Persist::Replace(read.identity)
            ),
            Ok(Persisted::Replaced(_))
        ));
        assert_eq!(fs::read_to_string(&target).unwrap(), "# New\n");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
            0o640
        );
    }

    /// (k) Replace keeps both provider-ignore attributes and their values.
    #[cfg(target_os = "macos")]
    #[test]
    fn k_replace_keeps_provider_ignore_xattrs() {
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        let target = fixture.raw.join("note.md");
        fs::write(&target, "# Old\n").unwrap();
        let carried: [(&str, &[u8]); 2] = [
            ("com.apple.fileprovider.ignore#P", b"1"),
            ("com.dropbox.ignored", b"yes"),
        ];
        for (name, value) in carried {
            xattr::set(&target, name, value).unwrap();
        }
        let read = read_beneath(&dir, "note.md").unwrap();

        assert!(matches!(
            persist_beneath(
                &root,
                &dir,
                "note.md",
                b"# New\n",
                Persist::Replace(read.identity)
            ),
            Ok(Persisted::Replaced(_))
        ));
        assert_eq!(fs::read_to_string(&target).unwrap(), "# New\n");
        for (name, value) in carried {
            assert_eq!(
                xattr::get(&target, name).unwrap(),
                Some(value.to_vec()),
                "{name}"
            );
        }
    }

    /// (l) `.reflect/tmp/` swapped for a link into `notes/`: refused, and
    /// nothing is written under `notes/`.
    #[test]
    fn l_a_symlinked_staging_directory_is_refused() {
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        let notes = fixture.graph.join("notes");
        let staging = fixture.graph.join(".reflect/tmp");
        let _ = fs::remove_dir_all(&staging);
        symlink(&notes, &staging).unwrap();
        let before = snapshot(&notes);

        assert!(matches!(
            persist_beneath(&root, &dir, "note.md", b"# New\n", Persist::NoClobber),
            Err(BeneathError::Traversal(_))
        ));
        assert_eq!(snapshot(&notes), before);
        assert!(!fixture.raw.join("note.md").exists());
    }

    /// (m) A case-only rename succeeds (APFS and case-sensitive volumes
    /// rename it outright under `RENAME_EXCL`). Another file at the
    /// destination, or another link of the same file, is a collision that
    /// moves nothing.
    #[test]
    fn m_a_case_only_rename_succeeds() {
        let fixture = Fixture::new();
        let dir = fixture.raw_dir("");
        fs::write(fixture.raw.join("note.md"), "# Note\n").unwrap();

        assert_eq!(
            rename_beneath(&dir, "note.md", &dir, "Note.md").unwrap(),
            Renamed::Moved
        );
        assert_eq!(entries(&fixture.raw), vec!["Note.md"]);
        assert_eq!(
            fs::read_to_string(fixture.raw.join("Note.md")).unwrap(),
            "# Note\n"
        );

        fs::write(fixture.raw.join("other.md"), "# Other\n").unwrap();
        fs::hard_link(fixture.raw.join("other.md"), fixture.raw.join("link.md")).unwrap();
        assert_eq!(
            rename_beneath(&dir, "Note.md", &dir, "other.md").unwrap(),
            Renamed::Collision
        );
        assert_eq!(
            rename_beneath(&dir, "other.md", &dir, "link.md").unwrap(),
            Renamed::Collision
        );
        assert_eq!(
            entries(&fixture.raw),
            vec!["Note.md", "link.md", "other.md"]
        );
        assert_eq!(
            fs::read_to_string(fixture.raw.join("Note.md")).unwrap(),
            "# Note\n"
        );

        let elsewhere = fixture.raw_dir("elsewhere");
        assert_eq!(
            rename_beneath(&dir, "Note.md", &elsewhere, "note.md").unwrap(),
            Renamed::Moved
        );
        assert_eq!(entries(&fixture.raw.join("elsewhere")), vec!["note.md"]);
    }

    /// The fallback's test for a volume that reports a respelling as a
    /// collision: the destination must be the source's own entry, which a
    /// second hard link never is.
    #[test]
    fn a_respelling_is_the_same_entry_never_another_link() {
        let fixture = Fixture::new();
        let dir = fixture.raw_dir("");
        fs::write(fixture.raw.join("note.md"), "# Note\n").unwrap();
        fs::write(fixture.raw.join("other.md"), "# Other\n").unwrap();
        fs::hard_link(fixture.raw.join("other.md"), fixture.raw.join("link.md")).unwrap();
        fs::create_dir(fixture.raw.join("folder")).unwrap();
        let respelt = |from: &str, to: &str| {
            respelling(&dir, OsStr::new(from), &dir, OsStr::new(to)).unwrap()
        };

        assert!(respelt("note.md", "note.md"));
        assert!(respelt("folder", "folder"));
        assert!(!respelt("note.md", "other.md"));
        assert!(!respelt("other.md", "link.md"));
    }

    /// (n) Trashing stages the note in a fresh `.reflect/trash/<random>/`.
    /// Once `.reflect` is swapped for a link, the path-based OS-trash call
    /// finds nothing (it canonicalizes the parent, then trashes by path),
    /// and the note stays staged.
    #[test]
    fn n_a_staged_note_survives_a_swapped_reflect_directory() {
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        fs::write(fixture.raw.join("note.md"), "# Note\n").unwrap();

        let staged = trash_beneath(&root, &dir, "note.md").unwrap();
        let slot = staged
            .parent()
            .and_then(Path::file_name)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert_eq!(slot.len(), 32);
        let trash = fixture.graph.join(".reflect/trash");
        assert_eq!(staged, trash.join(&slot).join("note.md"));
        assert_eq!(fs::read_to_string(&staged).unwrap(), "# Note\n");
        assert!(!fixture.raw.join("note.md").exists());
        for private in [trash.clone(), trash.join(&slot)] {
            assert_eq!(
                fs::metadata(&private).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }

        let real = fixture.graph.join(".reflect-real");
        fs::rename(fixture.graph.join(".reflect"), &real).unwrap();
        symlink(fixture.graph.join("notes"), fixture.graph.join(".reflect")).unwrap();
        assert!(staged.parent().unwrap().canonicalize().is_err());
        assert!(fs::symlink_metadata(&staged).is_err());
        assert_eq!(
            fs::read_to_string(real.join("trash").join(&slot).join("note.md")).unwrap(),
            "# Note\n"
        );
    }

    #[test]
    fn a_failed_trash_move_leaves_the_note_and_no_slot() {
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));

        assert!(matches!(
            trash_beneath(&root, &dir, "missing.md"),
            Err(BeneathError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound
        ));
        assert_eq!(
            entries(&fixture.graph.join(".reflect/trash")),
            Vec::<String>::new()
        );
    }

    /// (o) A directory below the base that is a Git work tree of its own
    /// refuses the walk, whatever form its `.git` takes.
    #[test]
    fn o_a_nested_git_work_tree_refuses_the_write() {
        let fixture = Fixture::new();
        fs::create_dir_all(fixture.raw.join("repo/.git")).unwrap();
        fs::create_dir_all(fixture.raw.join("submodule")).unwrap();
        fs::write(
            fixture.raw.join("submodule/.git"),
            "gitdir: ../.git/modules/x\n",
        )
        .unwrap();
        fs::create_dir_all(fixture.raw.join("linked")).unwrap();
        symlink("/nonexistent", fixture.raw.join("linked/.git")).unwrap();

        for rel in ["repo", "repo/deeper", "submodule", "linked"] {
            assert!(
                matches!(
                    open_dir_beneath(&fixture.raw, Path::new(rel), true),
                    Err(BeneathError::Traversal(_))
                ),
                "{rel}"
            );
        }
        assert!(!fixture.raw.join("repo/deeper").exists());
        // The base is the resolver's to check: a graph root holding its
        // backup repository opens.
        fs::create_dir_all(fixture.graph.join(".git")).unwrap();
        assert!(open_dir_beneath(&fixture.graph, Path::new(""), false).is_ok());
    }

    /// (p) A dataless file (mocked: userland cannot set `SF_DATALESS`) is
    /// never read.
    #[test]
    fn p_a_dataless_file_is_refused() {
        let _seams = Seams;
        let fixture = Fixture::new();
        let dir = fixture.raw_dir("");
        fs::write(fixture.raw.join("note.md"), "# Note\n").unwrap();
        assert!(read_beneath(&dir, "note.md").is_ok());

        seam::DATALESS.set(true);
        assert!(matches!(
            read_beneath(&dir, "note.md"),
            Err(BeneathError::Offline)
        ));
    }

    #[test]
    fn names_and_directories_must_be_plain() {
        let fixture = Fixture::new();
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        for name in ["", ".", "..", "a/b.md", "nul\0.md"] {
            assert!(
                matches!(read_beneath(&dir, name), Err(BeneathError::Traversal(_))),
                "{name:?}"
            );
            assert!(
                matches!(
                    persist_beneath(&root, &dir, name, b"x", Persist::NoClobber),
                    Err(BeneathError::Traversal(_))
                ),
                "{name:?}"
            );
        }
        for rel in ["..", "../secure", "sub/../..", "/tmp"] {
            assert!(
                matches!(
                    open_dir_beneath(&fixture.raw, Path::new(rel), true),
                    Err(BeneathError::Traversal(_))
                ),
                "{rel}"
            );
        }
        // Refused before the walk: nothing was created on the way.
        assert!(!fixture.raw.join("sub").exists());
        assert!(matches!(
            open_dir_beneath(Path::new("relative"), Path::new(""), false),
            Err(BeneathError::Traversal(_))
        ));
    }

    #[test]
    fn recovery_copies_round_trip_in_one_private_slot_per_note() {
        let fixture = Fixture::new();
        let root = fixture.root();
        assert_eq!(read_recovery(&root, "secure/note.md").unwrap(), None);
        let before = now_ms();

        write_recovery(&root, "secure/note.md", "first").unwrap();
        write_recovery(&root, "secure/note.md", "unsaved").unwrap();
        let copy = read_recovery(&root, "Secure/Note.md").unwrap().unwrap();
        assert_eq!(copy.contents, "unsaved");
        assert_eq!(copy.path, "secure/note.md");
        assert!(copy.saved_at_ms >= before);

        let recovery = fixture.graph.join(".reflect/recovery");
        let slot = "ae29e28a182b23223d7c44ad0b9c6b6d82e5449af72de5f9ad5906a4cc33de09.json";
        assert_eq!(entries(&recovery), vec![slot]);
        assert_eq!(
            fs::metadata(&recovery).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(recovery.join(slot))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(fixture.staging(), Vec::<String>::new());

        clear_recovery(&root, "SECURE/note.md").unwrap();
        assert_eq!(read_recovery(&root, "secure/note.md").unwrap(), None);
        clear_recovery(&root, "secure/note.md").unwrap();
    }

    #[test]
    fn a_symlinked_recovery_directory_is_refused() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let notes = fixture.graph.join("notes");
        symlink(&notes, fixture.graph.join(".reflect/recovery")).unwrap();
        let before = snapshot(&notes);

        assert!(matches!(
            write_recovery(&root, "secure/note.md", "unsaved"),
            Err(BeneathError::Traversal(_))
        ));
        assert!(matches!(
            read_recovery(&root, "secure/note.md"),
            Err(BeneathError::Traversal(_))
        ));
        assert!(matches!(
            clear_recovery(&root, "secure/note.md"),
            Err(BeneathError::Traversal(_))
        ));
        assert_eq!(snapshot(&notes), before);
    }

    #[test]
    fn errors_map_onto_the_ipc_contract() {
        let kind =
            |err: BeneathError| serde_json::to_value(AppError::from(err)).unwrap()["kind"].clone();
        assert_eq!(kind(BeneathError::Traversal("link".into())), "traversal");
        assert_eq!(kind(BeneathError::Offline), "io");
        assert_eq!(kind(BeneathError::CrossDevice), "io");
        assert_eq!(
            kind(BeneathError::Io(std::io::ErrorKind::NotFound.into())),
            "notFound"
        );
    }
}
