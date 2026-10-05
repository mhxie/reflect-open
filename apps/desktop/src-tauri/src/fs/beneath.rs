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
//! ([`Identity`]), a create only while the name is free. An upload already
//! staged in `.reflect/tmp/` lands the same way, under the first free name.
//! A delete first moves the file into a fresh random directory under
//! `.reflect/trash/` (or, for a file on another volume, a fresh hidden one
//! beside it), so the path-based OS-trash call that follows names a place
//! nothing else can occupy. `.reflect/recovery/` keeps one unsaved
//! buffer per note and editor session.
//!
//! Git sync's pull walks the graph the same way before it moves an entry
//! out of a path it writes (`git::displace`): it inspects entries without
//! following them ([`entry_beneath`], [`names_beneath`],
//! [`read_link_beneath`]), moves them only with the exclusive
//! [`rename_beneath`], and deletes nothing but files and links
//! ([`remove_beneath`]).
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
    read_beneath_with_limit(dir, name.as_ref(), None)
}

/// Read a regular file through the same no-follow boundary, enforcing a byte limit.
pub(crate) fn read_bounded_beneath(
    dir: &BeneathDir,
    name: impl AsRef<OsStr>,
    max_bytes: u64,
) -> BeneathResult<FileBytes> {
    read_beneath_with_limit(dir, name.as_ref(), Some(max_bytes))
}

fn read_beneath_with_limit(
    dir: &BeneathDir,
    name: &OsStr,
    max_bytes: Option<u64>,
) -> BeneathResult<FileBytes> {
    let name = plain_name(name)?;
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
    let oversized = || {
        BeneathError::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "file exceeds the permitted byte limit",
        ))
    };
    if let Some(limit) = max_bytes {
        if file.metadata()?.len() > limit {
            return Err(oversized());
        }
    }
    let mut bytes = Vec::new();
    let read = match max_bytes {
        Some(limit) => file.take(limit.saturating_add(1)).read_to_end(&mut bytes),
        None => file.read_to_end(&mut bytes),
    };
    read.map_err(|err| {
        if err.kind() == std::io::ErrorKind::Deadlock {
            BeneathError::Offline
        } else {
            err.into()
        }
    })?;
    if max_bytes.is_some_and(|limit| bytes.len() as u64 > limit) {
        return Err(oversized());
    }
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

/// Check that `name` in `dir` is a regular file whose bytes are on this Mac,
/// without reading it: the check before a move or delete. A symlink or
/// anything but a regular file is [`BeneathError::Traversal`], a dataless
/// file [`BeneathError::Offline`] (moving one out of its file provider's
/// folder would strand its bytes in the cloud), and a missing one `NotFound`.
pub(crate) fn regular_file_beneath(dir: &BeneathDir, name: impl AsRef<OsStr>) -> BeneathResult<()> {
    let name = plain_name(name.as_ref())?;
    let _no_materialize = NoMaterialize::engage();
    let (file, stat) = open_file(dir, name)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(BeneathError::Traversal(format!(
            "not a regular file: {}",
            dir.path.join(name).display()
        )));
    }
    if dataless(&file)? {
        return Err(BeneathError::Offline);
    }
    Ok(())
}

/// Whether anything holds `name` in `dir`, or its iCloud eviction
/// placeholder does ([`evicted_beneath`]): a create must treat either as
/// taken. Nothing is followed.
pub(crate) fn occupied_beneath(dir: &BeneathDir, name: impl AsRef<OsStr>) -> BeneathResult<bool> {
    let name = plain_name(name.as_ref())?;
    Ok(identity_at(dir, name)?.is_some() || evicted_beneath(dir, name)?)
}

/// Whether `name` in `dir` exists only as an iCloud eviction placeholder
/// (`.<name>.icloud`): the note comes back at `name` when it re-downloads.
pub(crate) fn evicted_beneath(dir: &BeneathDir, name: impl AsRef<OsStr>) -> BeneathResult<bool> {
    let name = plain_name(name.as_ref())?;
    let mut placeholder = std::ffi::OsString::from(".");
    placeholder.push(name);
    placeholder.push(".icloud");
    Ok(identity_at(dir, &placeholder)?.is_some())
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

/// Atomically create or replace a regular file's current revision, refusing concurrent changes.
pub(crate) fn write_current_beneath(
    graph_root: &BeneathDir,
    dir: &BeneathDir,
    name: impl AsRef<OsStr>,
    bytes: &[u8],
) -> BeneathResult<Persisted> {
    let name = plain_name(name.as_ref())?;
    let persist = identity_at(dir, name)?.map_or(Persist::NoClobber, Persist::Replace);
    persist_beneath(graph_root, dir, name, bytes, persist)
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
        Self::fill(graph_root, target, carried, |file| file.write_all(bytes))
    }

    /// A flushed temp holding whatever `fill` writes into it.
    fn fill(
        graph_root: &BeneathDir,
        target: &'a BeneathDir,
        carried: Option<&Carried>,
        fill: impl FnOnce(&mut File) -> std::io::Result<()>,
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
        fill(&mut staged.file)?;
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

/// What a directory entry is, seen without following it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EntryKind {
    Directory,
    File,
    Symlink,
    /// A FIFO, socket, or device node.
    Other,
}

/// A directory entry as `lstat` reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EntryStat {
    pub(crate) kind: EntryKind,
    /// Its size in bytes (for a link, the length of its target).
    pub(crate) size: u64,
    /// Its inode: two spellings that reach one inode name one entry.
    pub(crate) inode: i128,
}

/// What `name` in `dir` is, without following it; `None` when nothing holds
/// the name. On a volume that folds case or Unicode normalization another
/// spelling of an existing name reaches that entry, and [`names_beneath`]
/// gives its on-disk spelling.
pub(crate) fn entry_beneath(
    dir: &BeneathDir,
    name: impl AsRef<OsStr>,
) -> BeneathResult<Option<EntryStat>> {
    let name = plain_name(name.as_ref())?;
    let stat = match rustix::fs::statat(&dir.file, name, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(stat) => stat,
        Err(Errno::NOENT) => return Ok(None),
        Err(errno) => return Err(errno.into()),
    };
    let kind = match FileType::from_raw_mode(stat.st_mode) {
        FileType::Directory => EntryKind::Directory,
        FileType::RegularFile => EntryKind::File,
        FileType::Symlink => EntryKind::Symlink,
        _ => EntryKind::Other,
    };
    Ok(Some(EntryStat {
        kind,
        size: u64::try_from(stat.st_size).unwrap_or(0),
        inode: i128::from(stat.st_ino),
    }))
}

/// Open the directory `name` below `dir` without following it, refusing it
/// as every walk here does when it is a Git work tree of its own.
pub(crate) fn subdir_beneath(
    dir: &BeneathDir,
    name: impl AsRef<OsStr>,
) -> BeneathResult<BeneathDir> {
    descend(dir, plain_name(name.as_ref())?, None)
}

/// Every name in `dir`, never `.` or `..`, with its inode, in the
/// directory's own order: how an entry another spelling reached is spelled
/// on disk.
pub(crate) fn names_beneath(dir: &BeneathDir) -> BeneathResult<Vec<(std::ffi::OsString, i128)>> {
    let mut listing = rustix::fs::Dir::read_from(&dir.file)?;
    let mut names = Vec::new();
    while let Some(entry) = listing.read() {
        let entry = entry?;
        let name = entry.file_name().to_bytes();
        if name == b"." || name == b".." {
            continue;
        }
        names.push((
            OsStr::from_bytes(name).to_os_string(),
            i128::from(entry.ino()),
        ));
    }
    Ok(names)
}

/// The target of the symlink `name` in `dir`, as raw bytes.
pub(crate) fn read_link_beneath(
    dir: &BeneathDir,
    name: impl AsRef<OsStr>,
) -> BeneathResult<Vec<u8>> {
    let name = plain_name(name.as_ref())?;
    Ok(rustix::fs::readlinkat(&dir.file, name, Vec::new())?.into_bytes())
}

/// Remove the file or symlink `name` from `dir`. A link goes, never what it
/// points at, and a directory is refused: nothing here deletes a folder.
pub(crate) fn remove_beneath(dir: &BeneathDir, name: impl AsRef<OsStr>) -> BeneathResult<()> {
    let name = plain_name(name.as_ref())?;
    rustix::fs::unlinkat(&dir.file, name, AtFlags::empty())?;
    Ok(())
}

/// Land `staged`, a flushed regular file in `.reflect/tmp/` (an upload or
/// import, staged by path), in `dir` under the first of `names` no entry
/// holds, and return the name it took; `None` when every one is taken. Each
/// try is one rename that never replaces an entry (`RENAME_EXCL` /
/// `RENAME_NOREPLACE`) or follows a symlink, so a name is decided once, by
/// the filesystem. When `.reflect/tmp/` is on another volume the bytes are
/// first copied into a flushed hidden temp beside the target, which lands
/// the same way or is unlinked; the staged original then stays for its owner
/// to remove.
pub(crate) fn land_staged_beneath(
    graph_root: &BeneathDir,
    staged: impl AsRef<OsStr>,
    dir: &BeneathDir,
    names: impl IntoIterator<Item = String>,
) -> BeneathResult<Option<String>> {
    let staged = plain_name(staged.as_ref())?;
    if let Some(staging) = staging_dir(graph_root, dir)? {
        let stat = rustix::fs::statat(&staging.file, staged, AtFlags::SYMLINK_NOFOLLOW)?;
        if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
            return Err(BeneathError::Traversal(format!(
                "not a regular file: {}",
                staging.path.join(staged).display()
            )));
        }
        return land_under_a_free_name(&staging.file, staged, dir, names);
    }
    let staging = walk(graph_root, &[REFLECT_DIR, STAGING_DIR], None)?;
    let (mut source, stat) = open_file(&staging, staged)?;
    if FileType::from_raw_mode(stat.st_mode) != FileType::RegularFile {
        return Err(BeneathError::Traversal(format!(
            "not a regular file: {}",
            staging.path.join(staged).display()
        )));
    }
    let copy = Staged::fill(graph_root, dir, None, |file| {
        std::io::copy(&mut source, file).map(|_| ())
    })?;
    let landed = land_under_a_free_name(copy.dir(), OsStr::new(&copy.name), dir, names)?;
    if landed.is_some() {
        copy.landed();
    }
    Ok(landed)
}

/// Rename `from_name` in `from_dir` into `dir` under the first of `names`
/// nothing holds there.
fn land_under_a_free_name(
    from_dir: &File,
    from_name: &OsStr,
    dir: &BeneathDir,
    names: impl IntoIterator<Item = String>,
) -> BeneathResult<Option<String>> {
    for name in names {
        let candidate = plain_name(OsStr::new(&name))?;
        match rustix::fs::renameat_with(
            from_dir,
            from_name,
            &dir.file,
            candidate,
            RenameFlags::NOREPLACE,
        ) {
            Ok(()) => {
                sync_dir(dir);
                return Ok(Some(name));
            }
            Err(Errno::EXIST) => {}
            Err(errno) => return Err(rename_error(errno)),
        }
    }
    Ok(None)
}

/// Where [`trash_beneath`] staged a note for the path-based OS-trash call.
#[derive(Debug)]
pub(crate) enum TrashStage {
    /// In a fresh `.reflect/trash/<random>/`, on the graph's volume. The
    /// note stays there when the OS trash refuses it.
    Graph(PathBuf),
    /// In a fresh hidden directory beside the note, on the note's own volume
    /// (its folder is not on the graph's). The note goes back under its name
    /// when the OS trash refuses it.
    Beside(BesideStage),
}

impl TrashStage {
    /// The staged note's path, for the OS-trash call.
    pub(crate) fn path(&self) -> PathBuf {
        match self {
            Self::Graph(path) => path.clone(),
            Self::Beside(stage) => stage.slot_dir.path.join(&stage.name),
        }
    }

    /// The OS trash took the note: drop the emptied hidden directory (best
    /// effort; a staged `.reflect/trash/` slot stays like any other).
    pub(crate) fn trashed(self) {
        if let Self::Beside(stage) = self {
            let _ = rustix::fs::unlinkat(&stage.dir.file, stage.slot.as_str(), AtFlags::REMOVEDIR);
        }
    }

    /// The OS trash refused the note. Staged in the graph's trash it stays
    /// there (`Ok(true)`); staged beside, it moves back under its name, never
    /// replacing whatever took that name meanwhile (`Ok(false)`).
    pub(crate) fn refused(self) -> BeneathResult<bool> {
        let stage = match self {
            Self::Graph(_) => return Ok(true),
            Self::Beside(stage) => stage,
        };
        rustix::fs::renameat_with(
            &stage.slot_dir.file,
            stage.name.as_os_str(),
            &stage.dir.file,
            stage.name.as_os_str(),
            RenameFlags::NOREPLACE,
        )
        .map_err(rename_error)?;
        sync_dir(&stage.dir);
        let _ = rustix::fs::unlinkat(&stage.dir.file, stage.slot.as_str(), AtFlags::REMOVEDIR);
        Ok(false)
    }
}

/// A note staged in a hidden directory beside it ([`TrashStage::Beside`]).
#[derive(Debug)]
pub(crate) struct BesideStage {
    /// The note's own directory.
    dir: BeneathDir,
    /// The hidden directory's name in `dir`.
    slot: String,
    slot_dir: BeneathDir,
    name: std::ffi::OsString,
}

/// Move `name` out of `dir` into a fresh `.reflect/trash/<128-bit random>/`
/// directory (`0o700`, walked from `graph_root`) and return its path there
/// for the OS trash: that call only takes a path, and this one names a
/// directory nothing else can occupy. When `dir` is on another volume than
/// the graph, the note moves instead into a fresh hidden
/// `.reflect-trash-<128-bit random>/` directory (`0o700`) beside it, so its
/// bytes never leave their volume. The move never replaces an entry or
/// follows a symlink. On failure the note stays where it was.
pub(crate) fn trash_beneath(
    graph_root: &BeneathDir,
    dir: &BeneathDir,
    name: impl AsRef<OsStr>,
) -> BeneathResult<TrashStage> {
    let name = plain_name(name.as_ref())?;
    let trash = walk(
        graph_root,
        &[REFLECT_DIR, TRASH_DIR],
        Some(PRIVATE_DIR_MODE),
    )?;
    if !on_graph_volume(&trash, dir)? {
        return Ok(TrashStage::Beside(stage_beside(dir, name)?));
    }
    let slot = random_hex()?;
    rustix::fs::mkdirat(&trash.file, slot.as_str(), PRIVATE_DIR_MODE)?;
    let moved = move_into_slot(&trash, &slot, dir, name);
    if moved.is_err() {
        let _ = rustix::fs::unlinkat(&trash.file, slot.as_str(), AtFlags::REMOVEDIR);
    }
    moved.map(TrashStage::Graph)
}

/// Whether `dir` shares the graph trash's volume.
fn on_graph_volume(trash: &BeneathDir, dir: &BeneathDir) -> BeneathResult<bool> {
    #[cfg(test)]
    if seam::TRASH_ELSEWHERE.get() {
        return Ok(false);
    }
    same_volume(trash, dir)
}

/// Move `name` into a fresh hidden directory in `dir` itself.
fn stage_beside(dir: &BeneathDir, name: &OsStr) -> BeneathResult<BesideStage> {
    let owned = BeneathDir {
        file: dir.file.try_clone()?,
        path: dir.path.clone(),
    };
    let slot = format!(".reflect-trash-{}", random_hex()?);
    rustix::fs::mkdirat(&dir.file, slot.as_str(), PRIVATE_DIR_MODE)?;
    let staged = descend(dir, OsStr::new(&slot), None).and_then(|slot_dir| {
        rustix::fs::renameat_with(
            &dir.file,
            name,
            &slot_dir.file,
            name,
            RenameFlags::NOREPLACE,
        )
        .map_err(rename_error)?;
        sync_dir(dir);
        Ok(slot_dir)
    });
    match staged {
        Ok(slot_dir) => Ok(BesideStage {
            dir: owned,
            slot,
            slot_dir,
            name: name.to_owned(),
        }),
        Err(err) => {
            let _ = rustix::fs::unlinkat(&dir.file, slot.as_str(), AtFlags::REMOVEDIR);
            Err(err)
        }
    }
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

/// One editor session's unsaved note text, kept when a save could not land.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecoveryCopy {
    /// The graph-relative path the text was written for.
    pub(crate) path: String,
    pub(crate) owner_id: String,
    pub(crate) token: String,
    pub(crate) source_revision: Option<String>,
    sequence: u64,
    /// When the copy was written, in epoch milliseconds.
    pub(crate) saved_at_ms: u64,
    /// The unsaved buffer, verbatim.
    pub(crate) contents: String,
}

/// Replace only this session's recovery copy. Callers hold `NOTE_WRITE_LOCK`.
pub(crate) fn write_recovery(
    graph_root: &BeneathDir,
    path: &str,
    owner_id: &str,
    source_revision: Option<&str>,
    contents: &str,
) -> BeneathResult<RecoveryCopy> {
    recovery_name(owner_id)?;
    let slot = recovery_slot(path);
    let dir = walk(
        graph_root,
        &[REFLECT_DIR, RECOVERY_DIR, &slot],
        Some(PRIVATE_DIR_MODE),
    )?;
    let copy = RecoveryCopy {
        path: path.to_owned(),
        owner_id: owner_id.to_owned(),
        token: random_hex()?,
        source_revision: source_revision.map(str::to_owned),
        sequence: next_recovery_sequence(&dir, path)?,
        saved_at_ms: now_ms(),
        contents: contents.to_owned(),
    };
    land_recovery_copy(graph_root, &dir, &copy)?;
    sync_dir(&dir);
    Ok(copy)
}

/// One past the highest sequence among the copies in `dir`.
fn next_recovery_sequence(dir: &BeneathDir, path: &str) -> BeneathResult<u64> {
    Ok(recovery_copies(dir, path)?
        .into_iter()
        .map(|copy| copy.sequence)
        .max()
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| std::io::Error::other("recovery sequence exhausted"))?)
}

/// Atomically put `copy` in `dir` as its owner's file, replacing that owner's earlier one.
fn land_recovery_copy(
    graph_root: &BeneathDir,
    dir: &BeneathDir,
    copy: &RecoveryCopy,
) -> BeneathResult<()> {
    let name = recovery_name(&copy.owner_id)?;
    let json = serde_json::to_vec(copy).map_err(std::io::Error::other)?;
    let staged = Staged::write(graph_root, dir, &json, None)?;
    rustix::fs::renameat(staged.dir(), staged.name.as_str(), &dir.file, name.as_str())?;
    staged.landed();
    Ok(())
}

/// The newest unresolved session copy, ordered independently of wall-clock time.
pub(crate) fn read_recovery(
    graph_root: &BeneathDir,
    path: &str,
) -> BeneathResult<Option<RecoveryCopy>> {
    let slot = recovery_slot(path);
    let Some(dir) = missing_as_none(walk(graph_root, &[REFLECT_DIR, RECOVERY_DIR, &slot], None))?
    else {
        return Ok(None);
    };
    Ok(recovery_copies(&dir, path)?
        .into_iter()
        .max_by(|first, second| {
            first
                .sequence
                .cmp(&second.sequence)
                .then_with(|| first.token.cmp(&second.token))
        }))
}

/// Delete only the named version. Callers hold `NOTE_WRITE_LOCK` across the comparison and unlink.
pub(crate) fn clear_recovery(
    graph_root: &BeneathDir,
    path: &str,
    owner_id: &str,
    token: &str,
) -> BeneathResult<()> {
    let name = recovery_name(owner_id)?;
    recovery_name(token)?;
    let slot = recovery_slot(path);
    let Some(dir) = missing_as_none(walk(graph_root, &[REFLECT_DIR, RECOVERY_DIR, &slot], None))?
    else {
        return Ok(());
    };
    let Some(read) = missing_as_none(read_beneath(&dir, &name))? else {
        return Ok(());
    };
    let Some(copy) = parse_recovery_copy(&dir, &name, &read.bytes, owner_id, path) else {
        return Ok(()); // not a version anyone holds a token for
    };
    if copy.token != token {
        return Ok(());
    }
    rustix::fs::unlinkat(&dir.file, name.as_str(), AtFlags::empty())?;
    sync_dir(&dir);
    Ok(())
}

/// Drop every session's copy for the note at `path`, slot and all: the note
/// was deleted. Callers hold `NOTE_WRITE_LOCK`.
pub(crate) fn drop_recovery(graph_root: &BeneathDir, path: &str) -> BeneathResult<()> {
    let Some(recovery) = missing_as_none(walk(graph_root, &[REFLECT_DIR, RECOVERY_DIR], None))?
    else {
        return Ok(());
    };
    let slot = recovery_slot(path);
    let Some(dir) = missing_as_none(descend(&recovery, OsStr::new(&slot), None))? else {
        return Ok(());
    };
    for entry in rustix::fs::Dir::read_from(&dir.file)? {
        let entry = entry?;
        let name = entry.file_name();
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        // Never follows: a link is removed as itself, and a directory refuses.
        rustix::fs::unlinkat(&dir.file, name, AtFlags::empty())?;
    }
    rustix::fs::unlinkat(&recovery.file, slot.as_str(), AtFlags::REMOVEDIR)?;
    sync_dir(&recovery);
    Ok(())
}

/// Carry every session's copy for the note at `from` over to `to`, where the
/// note moved, rewritten for its new path and ordered after any copy already
/// there. Callers hold `NOTE_WRITE_LOCK`.
pub(crate) fn move_recovery(graph_root: &BeneathDir, from: &str, to: &str) -> BeneathResult<()> {
    let from_slot = recovery_slot(from);
    let Some(from_dir) = missing_as_none(walk(
        graph_root,
        &[REFLECT_DIR, RECOVERY_DIR, &from_slot],
        None,
    ))?
    else {
        return Ok(());
    };
    let mut copies = recovery_copies(&from_dir, from)?;
    if !copies.is_empty() {
        copies.sort_by_key(|copy| copy.sequence);
        let to_slot = recovery_slot(to);
        let to_dir = walk(
            graph_root,
            &[REFLECT_DIR, RECOVERY_DIR, &to_slot],
            Some(PRIVATE_DIR_MODE),
        )?;
        let after = next_recovery_sequence(&to_dir, to)?;
        for mut copy in copies {
            copy.path = to.to_owned();
            copy.sequence = copy
                .sequence
                .checked_add(after)
                .ok_or_else(|| std::io::Error::other("recovery sequence exhausted"))?;
            land_recovery_copy(graph_root, &to_dir, &copy)?;
        }
        sync_dir(&to_dir);
    }
    drop_recovery(graph_root, from)
}

/// Every usable copy in `dir`. An entry that is not a copy for this slot
/// (unparsable, or naming another owner, path, or token) is skipped with a
/// warning, so one damaged file never stops the others from being kept or
/// offered. A read the walk refuses (a symlink) still fails.
fn recovery_copies(dir: &BeneathDir, path: &str) -> BeneathResult<Vec<RecoveryCopy>> {
    let mut copies = Vec::new();
    for entry in rustix::fs::Dir::read_from(&dir.file)? {
        let entry = entry?;
        let Ok(name) = entry.file_name().to_str() else {
            continue;
        };
        let Some(owner_id) = name.strip_suffix(".json") else {
            continue;
        };
        if recovery_name(owner_id).is_err() {
            continue;
        }
        let read = read_beneath(dir, name)?;
        if let Some(copy) = parse_recovery_copy(dir, name, &read.bytes, owner_id, path) {
            copies.push(copy);
        }
    }
    Ok(copies)
}

/// `bytes` as `owner_id`'s copy for `path`, or `None` (logged) when they are not one.
fn parse_recovery_copy(
    dir: &BeneathDir,
    name: &str,
    bytes: &[u8],
    owner_id: &str,
    path: &str,
) -> Option<RecoveryCopy> {
    let parsed = serde_json::from_slice::<RecoveryCopy>(bytes)
        .map_err(|err| err.to_string())
        .and_then(|copy| {
            if copy.owner_id != owner_id || copy.path != path {
                Err("it does not match its slot".to_owned())
            } else if recovery_name(&copy.token).is_err() {
                Err("its token is invalid".to_owned())
            } else {
                Ok(copy)
            }
        });
    match parsed {
        Ok(copy) => Some(copy),
        Err(reason) => {
            tracing::warn!(
                dir = %dir.path.display(),
                name,
                %reason,
                "skipping an unusable recovery copy"
            );
            None
        }
    }
}

fn recovery_name(identity: &str) -> BeneathResult<String> {
    if identity.len() != 32
        || !identity
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(BeneathError::Traversal("invalid recovery identity".into()));
    }
    Ok(format!("{identity}.json"))
}

/// A recovery directory keyed by the exact graph-relative wire path.
/// Callers use the indexed spelling; distinct legal paths never share copies.
fn recovery_slot(path: &str) -> String {
    hex(&Sha256::digest(path.as_bytes()))
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
        /// Report every note's directory as on another volume than the
        /// graph's trash.
        pub(super) static TRASH_ELSEWHERE: Cell<bool> = const { Cell::new(false) };
    }

    pub(super) fn before_commit() -> std::io::Result<()> {
        BEFORE_COMMIT.with_borrow_mut(|hook| hook.as_mut().map_or(Ok(()), |hook| hook()))
    }

    pub(super) fn reset() {
        BEFORE_COMMIT.set(None);
        STAGING_ELSEWHERE.set(false);
        DATALESS.set(false);
        TRASH_ELSEWHERE.set(false);
    }
}

/// Test-only, for the commands built on this module: every file this thread
/// opens here reads as dataless until the guard drops (userland cannot set
/// `SF_DATALESS`, so no fixture can be made).
#[cfg(test)]
pub(crate) struct PretendDataless;

#[cfg(test)]
impl PretendDataless {
    pub(crate) fn engage() -> Self {
        seam::DATALESS.set(true);
        Self
    }
}

#[cfg(test)]
impl Drop for PretendDataless {
    fn drop(&mut self) {
        seam::DATALESS.set(false);
    }
}

/// Test-only, for the commands built on this module: every note directory
/// this thread trashes from reads as on another volume than the graph
/// until the guard drops (a second filesystem can't be mounted in tests).
#[cfg(test)]
pub(crate) struct PretendTrashElsewhere;

#[cfg(test)]
impl PretendTrashElsewhere {
    pub(crate) fn engage() -> Self {
        seam::TRASH_ELSEWHERE.set(true);
        Self
    }
}

#[cfg(test)]
impl Drop for PretendTrashElsewhere {
    fn drop(&mut self) {
        seam::TRASH_ELSEWHERE.set(false);
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

        let TrashStage::Graph(staged) = trash_beneath(&root, &dir, "note.md").unwrap() else {
            panic!("a note on the graph's volume stages in .reflect/trash");
        };
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

    /// A note on another volume than the graph stages beside itself, in a
    /// fresh private hidden directory: its bytes never cross volumes. A
    /// refusal puts it back; a landed trash leaves no directory behind.
    #[test]
    fn a_note_on_another_volume_stages_beside_itself() {
        let fixture = Fixture::new();
        let _seams = Seams;
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        seam::TRASH_ELSEWHERE.set(true);
        for refuse in [true, false] {
            fs::write(fixture.raw.join("note.md"), "# Note\n").unwrap();
            let stage = trash_beneath(&root, &dir, "note.md").unwrap();
            assert!(matches!(stage, TrashStage::Beside(_)));
            let staged = stage.path();
            let slot = staged.parent().unwrap().to_path_buf();
            assert_eq!(slot.parent().unwrap(), fixture.raw);
            let slot_name = slot.file_name().unwrap().to_string_lossy().into_owned();
            assert!(slot_name.starts_with(".reflect-trash-"), "{slot_name}");
            assert_eq!(
                fs::metadata(&slot).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(fs::read_to_string(&staged).unwrap(), "# Note\n");
            assert!(!fixture.raw.join("note.md").exists());
            assert_eq!(
                entries(&fixture.graph.join(".reflect/trash")),
                Vec::<String>::new()
            );
            if refuse {
                assert!(!stage.refused().unwrap());
                assert_eq!(
                    fs::read_to_string(fixture.raw.join("note.md")).unwrap(),
                    "# Note\n"
                );
            } else {
                fs::remove_file(&staged).unwrap(); // the OS trash took it
                stage.trashed();
                assert!(!fixture.raw.join("note.md").exists());
            }
            assert!(!slot.exists());
        }
    }

    /// A refused note whose name was taken meanwhile is never put back over
    /// the newcomer: it stays staged and the refusal says so.
    #[test]
    fn a_refused_note_never_replaces_what_took_its_name() {
        let fixture = Fixture::new();
        let _seams = Seams;
        let (root, dir) = (fixture.root(), fixture.raw_dir(""));
        seam::TRASH_ELSEWHERE.set(true);
        fs::write(fixture.raw.join("note.md"), "# Note\n").unwrap();
        let stage = trash_beneath(&root, &dir, "note.md").unwrap();
        let staged = stage.path();
        fs::write(fixture.raw.join("note.md"), "# Newcomer\n").unwrap();
        assert!(stage.refused().is_err());
        assert_eq!(
            fs::read_to_string(fixture.raw.join("note.md")).unwrap(),
            "# Newcomer\n"
        );
        assert_eq!(fs::read_to_string(staged).unwrap(), "# Note\n");
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
    fn recovery_copies_round_trip_in_one_private_slot_per_session() {
        let fixture = Fixture::new();
        let root = fixture.root();
        assert_eq!(read_recovery(&root, "secure/note.md").unwrap(), None);
        let before = now_ms();

        let owner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let first = write_recovery(&root, "secure/note.md", owner, Some("disk"), "first").unwrap();
        write_recovery(&root, "secure/note.md", owner, Some("disk"), "unsaved").unwrap();
        let copy = read_recovery(&root, "secure/note.md").unwrap().unwrap();
        assert_eq!(copy.contents, "unsaved");
        assert_eq!(copy.path, "secure/note.md");
        assert_eq!(copy.source_revision.as_deref(), Some("disk"));
        assert_ne!(copy.token, first.token);
        assert!(copy.saved_at_ms >= before);

        let recovery = fixture.graph.join(".reflect/recovery");
        let slot = "ae29e28a182b23223d7c44ad0b9c6b6d82e5449af72de5f9ad5906a4cc33de09";
        assert_eq!(entries(&recovery), vec![slot]);
        assert_eq!(entries(&recovery.join(slot)), vec![format!("{owner}.json")]);
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
            0o700
        );
        assert_eq!(
            fs::metadata(recovery.join(slot).join(format!("{owner}.json")))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(fixture.staging(), Vec::<String>::new());

        clear_recovery(&root, "secure/note.md", owner, &first.token).unwrap();
        assert_eq!(
            read_recovery(&root, "secure/note.md").unwrap(),
            Some(copy.clone())
        );
        clear_recovery(&root, "secure/note.md", owner, &copy.token).unwrap();
        assert_eq!(read_recovery(&root, "secure/note.md").unwrap(), None);
        clear_recovery(&root, "secure/note.md", owner, &copy.token).unwrap();
    }

    #[test]
    fn case_distinct_notes_keep_separate_recovery_copies_for_each_owner() {
        let owner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        for lower_owner in [owner, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"] {
            let fixture = Fixture::new();
            let root = fixture.root();
            let upper_path = "secure/Bank.md";
            let lower_path = "secure/bank.md";
            assert!(reflect_graph_paths::is_note(upper_path));
            assert!(reflect_graph_paths::is_note(lower_path));
            let upper = write_recovery(&root, upper_path, owner, None, "Bank draft").unwrap();
            assert_eq!(read_recovery(&root, lower_path).unwrap(), None);
            let lower = write_recovery(&root, lower_path, lower_owner, None, "bank draft").unwrap();
            assert_eq!(entries(&fixture.graph.join(".reflect/recovery")).len(), 2);
            assert_eq!(
                read_recovery(&root, upper_path).unwrap(),
                Some(upper.clone())
            );
            assert_eq!(
                read_recovery(&root, lower_path).unwrap(),
                Some(lower.clone())
            );

            clear_recovery(&root, lower_path, owner, &upper.token).unwrap();
            assert_eq!(
                read_recovery(&root, lower_path).unwrap(),
                Some(lower.clone())
            );
            clear_recovery(&root, upper_path, owner, &upper.token).unwrap();
            assert_eq!(read_recovery(&root, upper_path).unwrap(), None);
            assert_eq!(
                read_recovery(&root, lower_path).unwrap(),
                Some(lower.clone())
            );
            clear_recovery(&root, lower_path, lower_owner, &lower.token).unwrap();
            assert_eq!(read_recovery(&root, lower_path).unwrap(), None);
        }
    }

    #[test]
    fn same_millisecond_copies_are_offered_in_write_order_without_losing_either() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let path = "secure/note.md";
        let owner_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let owner_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let mut first = write_recovery(&root, path, owner_a, None, "A").unwrap();
        let mut second = write_recovery(&root, path, owner_b, None, "B").unwrap();
        first.saved_at_ms = 5;
        second.saved_at_ms = 5;
        let dir = fixture
            .graph
            .join(".reflect/recovery")
            .join(recovery_slot(path));
        for copy in [&first, &second] {
            fs::write(
                dir.join(format!("{}.json", copy.owner_id)),
                serde_json::to_vec(copy).unwrap(),
            )
            .unwrap();
        }
        assert_eq!(read_recovery(&root, path).unwrap(), Some(second.clone()));
        clear_recovery(&root, path, owner_b, &second.token).unwrap();
        assert_eq!(read_recovery(&root, path).unwrap(), Some(first.clone()));
        clear_recovery(&root, path, owner_a, &first.token).unwrap();
        assert_eq!(read_recovery(&root, path).unwrap(), None);
    }

    #[test]
    fn an_unusable_recovery_entry_is_skipped_without_losing_the_others() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let path = "secure/note.md";
        let owner_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let owner_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let owner_c = "cccccccccccccccccccccccccccccccc";
        let kept = write_recovery(&root, path, owner_a, None, "A").unwrap();
        let dir = fixture
            .graph
            .join(".reflect/recovery")
            .join(recovery_slot(path));
        fs::write(dir.join(format!("{owner_b}.json")), b"{ truncated").unwrap();
        let elsewhere = RecoveryCopy {
            path: "secure/other.md".into(),
            ..kept.clone()
        };
        fs::write(
            dir.join(format!("{owner_c}.json")),
            serde_json::to_vec(&RecoveryCopy {
                owner_id: owner_c.into(),
                ..elsewhere
            })
            .unwrap(),
        )
        .unwrap();

        assert_eq!(read_recovery(&root, path).unwrap(), Some(kept.clone()));
        // Writing still works, the damaged owner's slot included.
        let replaced = write_recovery(&root, path, owner_b, None, "B").unwrap();
        assert_eq!(read_recovery(&root, path).unwrap(), Some(replaced.clone()));
        clear_recovery(&root, path, owner_c, &kept.token).unwrap();
        clear_recovery(&root, path, owner_b, &replaced.token).unwrap();
        assert_eq!(read_recovery(&root, path).unwrap(), Some(kept));
    }

    #[test]
    fn a_deleted_notes_copies_go_and_a_moved_notes_copies_follow_it() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let (from, to) = ("secure/note.md", "secure/2026/note.md");
        let owner_a = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let owner_b = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let recovery = fixture.graph.join(".reflect/recovery");
        // Nothing kept: both are no-ops.
        drop_recovery(&root, from).unwrap();
        move_recovery(&root, from, to).unwrap();
        assert_eq!(entries(&recovery), Vec::<String>::new());

        let waiting = write_recovery(&root, to, owner_b, None, "already at to").unwrap();
        write_recovery(&root, from, owner_a, Some("disk"), "first").unwrap();
        let newest = write_recovery(&root, from, owner_b, None, "newest").unwrap();
        move_recovery(&root, from, to).unwrap();
        assert_eq!(read_recovery(&root, from).unwrap(), None);
        assert_eq!(entries(&recovery), vec![recovery_slot(to)]);
        let carried = read_recovery(&root, to).unwrap().unwrap();
        assert_eq!(
            (carried.path.as_str(), carried.contents.as_str()),
            (to, "newest")
        );
        assert_eq!(carried.token, newest.token);
        assert_ne!(carried.token, waiting.token);
        // The carried copies resolve by their tokens at the new path.
        clear_recovery(&root, to, owner_b, &newest.token).unwrap();
        let first = read_recovery(&root, to).unwrap().unwrap();
        assert_eq!(first.contents, "first");
        assert_eq!(first.source_revision.as_deref(), Some("disk"));

        drop_recovery(&root, to).unwrap();
        assert_eq!(read_recovery(&root, to).unwrap(), None);
        assert_eq!(entries(&recovery), Vec::<String>::new());
    }

    #[test]
    fn recovery_note_directories_and_session_files_never_follow_symlinks() {
        for replace_directory in [true, false] {
            let fixture = Fixture::new();
            let root = fixture.root();
            let path = "secure/note.md";
            let owner = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let copy = write_recovery(&root, path, owner, None, "unsaved").unwrap();
            let notes = fixture.graph.join("notes");
            let dir = fixture
                .graph
                .join(".reflect/recovery")
                .join(recovery_slot(path));
            let file = dir.join(format!("{owner}.json"));
            fs::remove_file(&file).unwrap();
            if replace_directory {
                fs::remove_dir(&dir).unwrap();
                symlink(&notes, &dir).unwrap();
            } else {
                symlink(notes.join("kept.md"), &file).unwrap();
            }
            let before = snapshot(&notes);
            assert!(matches!(
                write_recovery(&root, path, owner, None, "replacement"),
                Err(BeneathError::Traversal(_))
            ));
            assert!(matches!(
                read_recovery(&root, path),
                Err(BeneathError::Traversal(_))
            ));
            assert!(matches!(
                clear_recovery(&root, path, owner, &copy.token),
                Err(BeneathError::Traversal(_))
            ));
            assert_eq!(snapshot(&notes), before);
        }
    }

    #[test]
    fn a_symlinked_recovery_directory_is_refused() {
        let fixture = Fixture::new();
        let root = fixture.root();
        let notes = fixture.graph.join("notes");
        symlink(&notes, fixture.graph.join(".reflect/recovery")).unwrap();
        let before = snapshot(&notes);
        let identity = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        assert!(matches!(
            write_recovery(&root, "secure/note.md", identity, None, "unsaved"),
            Err(BeneathError::Traversal(_))
        ));
        assert!(matches!(
            read_recovery(&root, "secure/note.md"),
            Err(BeneathError::Traversal(_))
        ));
        assert!(matches!(
            clear_recovery(&root, "secure/note.md", identity, identity),
            Err(BeneathError::Traversal(_))
        ));
        assert_eq!(snapshot(&notes), before);
    }

    #[test]
    fn entries_are_inspected_and_removed_without_following_links() {
        let fixture = Fixture::new();
        let dir = fixture.raw_dir("");
        let notes = fixture.graph.join("notes");
        fs::write(fixture.raw.join("note.md"), "# Note\n").unwrap();
        fs::create_dir(fixture.raw.join("folder")).unwrap();
        symlink(&notes, fixture.raw.join("link")).unwrap();
        let before = snapshot(&notes);

        let note = entry_beneath(&dir, "note.md").unwrap().unwrap();
        assert_eq!((note.kind, note.size), (EntryKind::File, 7));
        let folder = entry_beneath(&dir, "folder").unwrap().unwrap();
        assert_eq!(folder.kind, EntryKind::Directory);
        let link = entry_beneath(&dir, "link").unwrap().unwrap();
        assert_eq!(link.kind, EntryKind::Symlink);
        assert_eq!(entry_beneath(&dir, "missing.md").unwrap(), None);
        assert_eq!(
            read_link_beneath(&dir, "link").unwrap(),
            notes.as_os_str().as_bytes()
        );
        assert!(matches!(
            subdir_beneath(&dir, "link"),
            Err(BeneathError::Traversal(_))
        ));
        assert!(subdir_beneath(&dir, "folder").is_ok());

        let mut names = names_beneath(&dir).unwrap();
        names.sort();
        let listed: Vec<&str> = names
            .iter()
            .map(|(name, _)| name.to_str().unwrap())
            .collect();
        assert_eq!(listed, vec!["folder", "link", "note.md"]);
        assert!(names.contains(&("note.md".into(), note.inode)));

        remove_beneath(&dir, "link").unwrap();
        remove_beneath(&dir, "note.md").unwrap();
        assert!(remove_beneath(&dir, "folder").is_err());
        assert_eq!(entries(&fixture.raw), vec!["folder"]);
        assert_eq!(snapshot(&notes), before);
    }

    /// On a volume that folds case another spelling reaches the entry, and
    /// the listing gives the spelling on disk; elsewhere it reaches nothing.
    #[test]
    fn a_folded_spelling_reaches_the_entry_the_listing_spells() {
        let fixture = Fixture::new();
        let dir = fixture.raw_dir("");
        fs::write(fixture.raw.join("Plan.md"), "# Plan\n").unwrap();
        let folds = fixture.raw.join("plan.md").exists();

        let found = entry_beneath(&dir, "plan.md").unwrap();
        assert_eq!(found.is_some(), folds);
        if let Some(found) = found {
            let spelled: Vec<_> = names_beneath(&dir)
                .unwrap()
                .into_iter()
                .filter(|(_, inode)| *inode == found.inode)
                .map(|(name, _)| name)
                .collect();
            assert_eq!(spelled, vec![std::ffi::OsString::from("Plan.md")]);
        }
    }

    #[test]
    fn only_a_regular_local_file_passes_the_move_check() {
        let _seams = Seams;
        let fixture = Fixture::new();
        let dir = fixture.raw_dir("");
        fs::write(fixture.raw.join("note.md"), "# Note\n").unwrap();
        symlink(
            fixture.graph.join("notes/kept.md"),
            fixture.raw.join("link.md"),
        )
        .unwrap();
        make_fifo(&fixture.raw.join("pipe.md"));
        fs::create_dir(fixture.raw.join("folder.md")).unwrap();

        assert!(regular_file_beneath(&dir, "note.md").is_ok());
        for name in ["link.md", "pipe.md", "folder.md"] {
            assert!(
                matches!(
                    regular_file_beneath(&dir, name),
                    Err(BeneathError::Traversal(_))
                ),
                "{name}"
            );
        }
        assert!(matches!(
            regular_file_beneath(&dir, "missing.md"),
            Err(BeneathError::Io(err)) if err.kind() == std::io::ErrorKind::NotFound
        ));
        let _dataless = PretendDataless::engage();
        assert!(matches!(
            regular_file_beneath(&dir, "note.md"),
            Err(BeneathError::Offline)
        ));
    }

    #[test]
    fn a_name_or_its_icloud_placeholder_is_occupied() {
        let fixture = Fixture::new();
        let dir = fixture.raw_dir("");
        fs::write(fixture.raw.join("note.md"), "# Note\n").unwrap();
        fs::write(fixture.raw.join(".evicted.md.icloud"), "stub").unwrap();
        symlink("/nonexistent", fixture.raw.join("dangling.md")).unwrap();

        for name in ["note.md", "evicted.md", "dangling.md"] {
            assert!(occupied_beneath(&dir, name).unwrap(), "{name}");
        }
        assert!(!occupied_beneath(&dir, "free.md").unwrap());
    }

    /// Stage `bytes` in `.reflect/tmp/` the way an upload does (by path),
    /// returning the staged name.
    fn stage_upload(fixture: &Fixture, bytes: &[u8]) -> String {
        let staging = fixture.graph.join(".reflect/tmp");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("upload-1"), bytes).unwrap();
        "upload-1".into()
    }

    fn scan_names() -> Vec<String> {
        ["scan.png", "scan-2.png", "scan-3.png"]
            .into_iter()
            .map(String::from)
            .collect()
    }

    #[test]
    fn a_staged_upload_lands_under_the_first_free_name() {
        let fixture = Fixture::new();
        let (root, assets) = (fixture.root(), fixture.raw_dir("assets"));
        fs::write(fixture.raw.join("assets/scan.png"), "first").unwrap();
        let staged = stage_upload(&fixture, b"second");

        assert_eq!(
            land_staged_beneath(&root, &staged, &assets, scan_names()).unwrap(),
            Some("scan-2.png".into())
        );
        assert_eq!(
            fs::read(fixture.raw.join("assets/scan.png")).unwrap(),
            b"first"
        );
        assert_eq!(
            fs::read(fixture.raw.join("assets/scan-2.png")).unwrap(),
            b"second"
        );
        assert_eq!(fixture.staging(), Vec::<String>::new());

        // Every name taken: nothing moves, and the upload stays staged.
        fs::write(fixture.raw.join("assets/scan-3.png"), "third").unwrap();
        let staged = stage_upload(&fixture, b"fourth");
        assert_eq!(
            land_staged_beneath(&root, &staged, &assets, scan_names()).unwrap(),
            None
        );
        assert_eq!(fixture.staging(), vec!["upload-1"]);
        assert_eq!(
            entries(&fixture.raw.join("assets")),
            vec!["scan-2.png", "scan-3.png", "scan.png"]
        );
    }

    #[test]
    fn across_volumes_a_staged_upload_lands_as_a_copy() {
        let _seams = Seams;
        let fixture = Fixture::new();
        let (root, assets) = (fixture.root(), fixture.raw_dir("assets"));
        seam::STAGING_ELSEWHERE.set(true);
        let staged = stage_upload(&fixture, b"bytes");

        assert_eq!(
            land_staged_beneath(&root, &staged, &assets, scan_names()).unwrap(),
            Some("scan.png".into())
        );
        assert_eq!(
            fs::read(fixture.raw.join("assets/scan.png")).unwrap(),
            b"bytes"
        );
        // No hidden temp is left beside the target, and the original stays
        // for its owner to remove.
        assert_eq!(entries(&fixture.raw.join("assets")), vec!["scan.png"]);
        assert_eq!(fixture.staging(), vec!["upload-1"]);

        // Every name taken: the copy is unlinked.
        fs::write(fixture.raw.join("assets/scan-2.png"), "x").unwrap();
        fs::write(fixture.raw.join("assets/scan-3.png"), "x").unwrap();
        assert_eq!(
            land_staged_beneath(&root, &staged, &assets, scan_names()).unwrap(),
            None
        );
        assert_eq!(
            entries(&fixture.raw.join("assets")),
            vec!["scan-2.png", "scan-3.png", "scan.png"]
        );
    }

    #[test]
    fn a_staged_upload_never_lands_through_a_symlink() {
        let fixture = Fixture::new();
        let (root, assets) = (fixture.root(), fixture.raw_dir("assets"));
        let notes = fixture.graph.join("notes");
        let before = snapshot(&notes);
        // The staged entry swapped for a link to a note.
        let staging = fixture.graph.join(".reflect/tmp");
        fs::create_dir_all(&staging).unwrap();
        symlink(notes.join("kept.md"), staging.join("upload-1")).unwrap();
        assert!(matches!(
            land_staged_beneath(&root, "upload-1", &assets, scan_names()),
            Err(BeneathError::Traversal(_))
        ));
        // `.reflect/tmp/` swapped for a link into `notes/`.
        fs::remove_dir_all(&staging).unwrap();
        symlink(&notes, &staging).unwrap();
        assert!(matches!(
            land_staged_beneath(&root, "kept.md", &assets, scan_names()),
            Err(BeneathError::Traversal(_))
        ));
        assert_eq!(snapshot(&notes), before);
        assert_eq!(entries(&fixture.raw.join("assets")), Vec::<String>::new());
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
