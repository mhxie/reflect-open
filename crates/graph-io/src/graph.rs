//! The open graph session (Plan 02): the root plus its generation and its
//! per-graph configuration, the catalog cache, and the note operations that
//! run under the graph lock.
//!
//! Markdown files are the durable source of truth; this module moves bytes and
//! paths, not meaning. All paths are **graph-relative**, and the root lives in
//! [`GraphState`], so a caller can never address files outside it
//! (path-traversal guard, [`crate::resolve`]). Writes are atomic (temp file + rename,
//! [`io`]). What a delete does with the file (OS trash, graph-local trash) is
//! the caller's choice, passed into [`delete_note_locked`].

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use reflect_graph_paths::{LocalOnlyFolders, eviction_placeholder};
use reflect_types::{AppError, AppResult, FileMeta};

use crate::graph_lock::with_graph_lock;
use crate::io::{self, AtomicCreateOutcome, atomic_write, modified_ms};
use crate::own_writes;
use crate::resolve::{EditTarget, LocalOnlyEntry, TargetKind, resolve_note_edit, resolve_write};

/// Why a write refuses when the file no longer holds what its writer read
/// (it appeared or went missing). The app's idempotent patches re-read and
/// retry once on exactly this text.
pub const CHANGED_ON_DISK: &str = "Note changed on disk; reload before retrying";

/// Why sync refuses while the local-only configuration is unknown.
const SYNC_PAUSED: &str = "Sync is paused: Reflect cannot tell which folders are local-only \
     (see the warning shown when the graph opened). Restore the local-only configuration, \
     then reopen the graph.";

/// Why sharing refuses while the local-only configuration is unknown.
const SHARING_PAUSED: &str = "Sharing is paused: Reflect cannot tell which folders are \
     local-only, so nothing leaves this device (see the warning shown when the graph \
     opened). Restore the local-only configuration, then reopen the graph.";

/// What a graph open loaded from the user's settings for that graph. It is
/// swapped with the root, so one value feeds the walk, the read guards, the
/// watcher, the index flag, Git, and [`GraphInfo`].
#[derive(Clone, Debug, Default)]
pub struct GraphConfig {
    /// The graph's local-only folders.
    pub local_only: Option<Arc<LocalOnlyFolders>>,
    /// The local-only configuration problems found at open, shown to the user.
    pub local_only_warnings: Vec<String>,
    /// The settings file was unreadable at open: which folders are
    /// local-only is unknown, so sync and sharing refuse ([`graph_for_sync`],
    /// [`graph_for_sharing`]).
    pub local_only_unknown: bool,
    /// The configuration is unknown, so the index open only adds to the
    /// folders it recorded instead of replacing them ([`graph_for_index`]).
    pub local_only_grow_record: bool,
    /// The graph's Git backup size limit in bytes; `None` until a graph opens.
    pub backup_max_file_bytes: Option<u64>,
    /// The history roots Git sync may join.
    pub accepted_history_roots: Vec<git2::Oid>,
    /// The backup settings' configuration problems found at open (the size
    /// limit and the accepted history roots).
    pub backup_warnings: Vec<String>,
}

/// The open graph root plus a monotonic generation, kept **under one lock** so
/// they swap atomically (the same pattern as the index's `IndexState`, Plan 04b).
/// Mutating commands carry the generation they were issued for and are rejected
/// when it's stale — so a write enqueued for one graph can never land in another
/// graph's same-named file after a switch swaps the root.
#[derive(Default)]
pub struct GraphInner {
    pub generation: u64,
    pub root: Option<PathBuf>,
    /// The open graph's configuration, loaded with the root.
    config: GraphConfig,
    /// Cached vault catalog for the current root, dropped on every write path
    /// and watcher/iCloud change so listings never pin deleted files.
    catalog: Option<io::FileCatalog>,
    /// Monotonic invalidation epoch. A scan runs without the graph lock; it
    /// may publish into the cache only if no invalidation happened since it
    /// began — otherwise its result is returned to its caller but not pinned.
    catalog_revision: u64,
}

impl GraphInner {
    /// Refuse a command issued for an earlier graph session; `None` accepts
    /// whichever graph is open.
    fn check_generation(&self, generation: Option<u64>) -> AppResult<()> {
        if generation.is_some_and(|generation| generation != self.generation) {
            return Err(AppError::io(
                "the graph changed since this command was issued; dropping it",
            ));
        }
        Ok(())
    }

    /// The open graph's local-only folders (for the watcher, which reads
    /// them under the state lock it already holds).
    pub fn local_only(&self) -> Option<Arc<LocalOnlyFolders>> {
        self.config.local_only.clone()
    }

    /// Install a local-only configuration directly: command-tier tests
    /// build their `GraphState` without the settings store.
    #[cfg(any(test, feature = "test-support"))]
    pub fn set_local_only(&mut self, folders: Option<LocalOnlyFolders>) {
        self.config.local_only = folders.map(Arc::new);
    }

    /// Mark the configuration unknown (an unreadable settings file, or
    /// recorded names gone missing), keeping whatever folders are set, for
    /// command-tier tests.
    #[cfg(any(test, feature = "test-support"))]
    pub fn set_local_only_unknown(&mut self) {
        self.config.local_only_unknown = true;
        self.config.local_only_grow_record = true;
    }

    /// Install accepted history roots directly, for command-tier tests.
    #[cfg(any(test, feature = "test-support"))]
    pub fn set_accepted_history_roots(&mut self, roots: Vec<git2::Oid>) {
        self.config.accepted_history_roots = roots;
    }
}

/// Tauri-managed state holding the currently open graph (root + generation).
#[derive(Default)]
pub struct GraphState(pub Mutex<GraphInner>);

/// Identity of an open graph, returned to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphInfo {
    /// Absolute path of the graph root.
    pub root: String,
    /// Display name (the root folder name).
    pub name: String,
    /// Open-session generation; mutating file commands must echo it back.
    pub generation: u64,
    /// The local-only folder names configured for this graph (empty when
    /// none): notes inside them are private everywhere, and read-only unless
    /// every one of these names on their path is also editable.
    pub local_only_folders: Vec<String>,
    /// The local-only folder names this graph edits in place (a subset of
    /// `local_only_folders`; empty when every local-only folder is
    /// read-only, which is all a phone, an unknown configuration, or a too
    /// broad rawRoot ever gets).
    pub local_only_editable_folders: Vec<String>,
    /// Problems with that configuration the user must see (dropped names,
    /// an unusable rawRoot, an unreadable settings file); empty when none.
    pub local_only_warnings: Vec<String>,
    /// Problems with the graph's backup settings the user must see (a size
    /// limit out of range, a malformed accepted history root, a key naming a
    /// missing folder); empty when none.
    pub backup_warnings: Vec<String>,
}

/// Result of claiming a note path without overwriting an existing file.
#[derive(Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum NoteCreateOutcome {
    /// The path was free and now contains the supplied bytes.
    Created { modified_ms: Option<u64> },
    /// A file or iCloud eviction placeholder already owns the path.
    Collision,
}

// ---- state accessors --------------------------------------------------------

pub fn graph_info(root: &Path, generation: u64, config: &GraphConfig) -> GraphInfo {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let local_only = config.local_only.as_deref();
    GraphInfo {
        root: root.to_string_lossy().into_owned(),
        name,
        generation,
        local_only_folders: local_only
            .map(|folders| folders.names().to_vec())
            .unwrap_or_default(),
        local_only_editable_folders: local_only
            .map(|folders| folders.editable_names().to_vec())
            .unwrap_or_default(),
        local_only_warnings: config.local_only_warnings.clone(),
        backup_warnings: config.backup_warnings.clone(),
    }
}

/// Set the active root and its configuration (bumping the generation
/// atomically) and return its info. Loading the configuration and recording
/// the graph in recents are the caller's job.
pub fn activate(state: &GraphState, root: &Path, config: GraphConfig) -> AppResult<GraphInfo> {
    let mut inner = lock_graph(state)?;
    // A displacement record belongs to the session whose pull made it.
    if let Some(previous) = inner.root.as_deref() {
        crate::displaced_revisions::clear(previous);
    }
    crate::displaced_revisions::clear(root);
    inner.generation += 1;
    inner.root = Some(root.to_path_buf());
    inner.config = config;
    inner.catalog = None;
    inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
    Ok(graph_info(root, inner.generation, &inner.config))
}

pub fn lock_graph(state: &GraphState) -> AppResult<std::sync::MutexGuard<'_, GraphInner>> {
    state.0.lock().map_err(|err| {
        // A poisoned lock means a command panicked while holding it — the panic
        // itself is the bug; this context points at the blast radius.
        tracing::error!(?err, "graph state lock poisoned by an earlier panic");
        AppError::io("graph state lock poisoned")
    })
}

pub fn current_root(state: &GraphState) -> AppResult<PathBuf> {
    lock_graph(state)?
        .root
        .clone()
        .ok_or_else(AppError::no_graph)
}

/// The open graph's identity as a pure read — the note-window bootstrap
/// (`windows::window_bootstrap`) must *adopt* the session, never re-open it:
/// a generation bump here would strand every command the main window has
/// pinned to the current one.
pub fn current_graph_info(state: &GraphState) -> AppResult<GraphInfo> {
    let inner = lock_graph(state)?;
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok(graph_info(&root, inner.generation, &inner.config))
}

/// The current root, verified against the generation a mutating command was
/// issued for. A stale generation means the graph was switched after the
/// command was enqueued — the mutation must be rejected (loudly), or it would
/// land in the *new* graph's same-named file.
pub fn root_for_generation(state: &GraphState, generation: u64) -> AppResult<PathBuf> {
    Ok(graph_for(state, Some(generation))?.0)
}

/// `current_root`, or `root_for_generation` when the caller pinned the
/// command. Read commands take an optional pin: UI reads for the open graph
/// omit it, background passes (audio-memo reconcile) that can span a graph
/// switch must supply it so every step of a pass sees one graph.
pub fn root_for(state: &GraphState, generation: Option<u64>) -> AppResult<PathBuf> {
    Ok(graph_for(state, generation)?.0)
}

/// The open graph's root and local-only folders, read under one lock so the
/// pair always describes the same graph. `generation` is the optional pin of
/// [`root_for`]: a stale pin is rejected exactly like [`root_for_generation`].
pub fn graph_for(
    state: &GraphState,
    generation: Option<u64>,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>)> {
    let inner = lock_graph(state)?;
    inner.check_generation(generation)?;
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok((root, inner.config.local_only.clone()))
}

/// [`graph_for`] that also refuses, under the same lock, while the open
/// graph's local-only configuration is unknown.
fn graph_when_known(
    state: &GraphState,
    generation: Option<u64>,
    refusal: &'static str,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>)> {
    let inner = lock_graph(state)?;
    inner.check_generation(generation)?;
    if inner.config.local_only_unknown {
        return Err(AppError::io(refusal));
    }
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok((root, inner.config.local_only.clone()))
}

/// [`graph_for`] for Git sync and the iCloud sweep and move-in, which must
/// know what to leave alone.
pub fn graph_for_sync(
    state: &GraphState,
    generation: u64,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>)> {
    graph_when_known(state, Some(generation), SYNC_PAUSED)
}

/// [`graph_for`] for bytes about to leave this device (AI, transcription,
/// asset description, capture enrichment, summaries).
pub fn graph_for_sharing(
    state: &GraphState,
    generation: Option<u64>,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>)> {
    graph_when_known(state, generation, SHARING_PAUSED)
}

/// The open graph's root and local-only folders plus whether the index may
/// only grow its record of them, under one lock: the index open marks rows
/// private either way, and while the configuration is unknown it only adds
/// the names to the record.
pub fn graph_for_index(
    state: &GraphState,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>, bool)> {
    let inner = lock_graph(state)?;
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok((
        root,
        inner.config.local_only.clone(),
        inner.config.local_only_grow_record,
    ))
}

/// The open graph's Git backup size limit, verified against the generation
/// the command was issued for (like [`root_for_generation`]); `None` when the
/// open did not load one.
pub fn backup_max_file_bytes(state: &GraphState, generation: u64) -> AppResult<Option<u64>> {
    let inner = lock_graph(state)?;
    inner.check_generation(Some(generation))?;
    Ok(inner.config.backup_max_file_bytes)
}

/// The open graph's accepted history roots, verified against the generation
/// the sync command was issued for (like [`root_for_generation`]); empty
/// when the open loaded none.
pub fn accepted_history_roots(state: &GraphState, generation: u64) -> AppResult<Vec<git2::Oid>> {
    let inner = lock_graph(state)?;
    inner.check_generation(Some(generation))?;
    Ok(inner.config.accepted_history_roots.clone())
}

/// Reads and OS opens accept any supported attachment anywhere in the vault:
/// an adopted vault keeps its images beside its notes. Classification is the
/// shared `graph-paths` policy, so neither surface can serve a note, a hidden
/// file, or a traversal path. Writes are deliberately untouched — Reflect
/// only ever creates files under `assets/` and `audio-memos/`, and widening
/// reads must not widen what Reflect will write.
pub fn ensure_readable_attachment_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_attachment(path) {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a supported attachment path: {path}"
    )))
}

/// Paths the OS default app may open: supported attachments, plus pages
/// (`.html`) that Reflect never reads or serves itself but a browser may run.
pub fn ensure_openable_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_openable(path) {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a supported attachment path: {path}"
    )))
}

/// A shareable read serves visible Markdown only: notes, and the
/// `assets/<file>.reflect.md` description sidecars the read_assets tool reads.
/// The traversal guard alone admits hidden trees (`.git/`, `.reflect/`) and
/// every file type, and these paths are model-supplied, so anything else is
/// refused before any IO.
pub fn ensure_shareable_note_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_safe_visible(path) && path.ends_with(".md") {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a shareable note path: {path}"
    )))
}

/// How a local note read (the desktop `note_read_local` command) found the
/// note on disk.
#[derive(Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum LocalNoteRead {
    /// The bytes are local; here they are. `local_only` reports whether the
    /// note lies in a local-only folder, decided by the entry the path
    /// resolves to: bulk passes fold text across notes (asset descriptions
    /// into the notes that embed them) and must not carry it out of one.
    Content { content: String, local_only: bool },
    /// The note is iCloud-evicted (a dataless file, or an `.icloud` stub in
    /// the logical path's place). Reading it would block on an on-demand
    /// download — this command refuses instead.
    Evicted,
}

/// How a shareable note read (the desktop `note_read_shareable` command)
/// found the note.
#[derive(Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum ShareableNoteRead {
    /// The note may leave this machine; here are its bytes.
    Content { content: String },
    /// The note lies in a local-only folder, by its requested path or by the
    /// entry the filesystem resolves it to. Nothing was read.
    LocalOnly,
}

/// What a note write left on disk.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteWriteOutcome {
    /// The note's on-disk mtime (epoch ms) after the call.
    pub modified_ms: Option<u64>,
    /// The full note text now on disk, when the note had moved past the
    /// expected revision and the file holds something other than `contents`.
    pub merged: Option<String>,
}

/// A checked write: the note at `rel` must still hold `expected` (`None`: no
/// file yet). One whose file moved past `expected` merges through the
/// conflict ladder, unless `expected` is the revision the latest pull moved
/// away from `rel` (`displaced_revisions`): the open edits of a displaced
/// note follow its copy, so that write is refused like one whose file
/// appeared or went missing, as [`CHANGED_ON_DISK`]. A note in an editable
/// local-only folder (never displaced) takes the same rules through directory
/// descriptors that never follow a link (`local_only_edit`). `still_current`
/// runs under the graph lock before any write.
pub fn write_note_revision(
    root: &Path,
    rel: &str,
    contents: &str,
    expected: Option<&str>,
    local_only: Option<&LocalOnlyFolders>,
    still_current: impl FnOnce() -> AppResult<()>,
) -> AppResult<NoteWriteOutcome> {
    with_graph_lock(root, || {
        still_current()?;
        match resolve_note_edit(root, rel, local_only, TargetKind::Note)? {
            EditTarget::Graph(target) => {
                match (expected, read_current(root, &target)?) {
                    (None, None) => {}
                    (Some(base), Some(current)) if current != base => {
                        if crate::displaced_revisions::names(root, rel, base) {
                            return Err(AppError::io(CHANGED_ON_DISK));
                        }
                        return merge_into_moved_note(root, rel, &target, contents, base, current);
                    }
                    (Some(_), Some(_)) => {}
                    _ => return Err(AppError::io(CHANGED_ON_DISK)),
                }
                write_own(root, rel, &target, contents)
            }
            EditTarget::LocalOnly(entry) => {
                let outcome = crate::local_only_edit::write_note(&entry, contents, expected)?;
                let landed = outcome.merged.as_deref().unwrap_or(contents);
                own_writes::record(root, rel, landed.as_bytes());
                Ok(outcome)
            }
        }
    })
}

/// [`write_note_revision`] for a change that is not an edit: the note keeps
/// its modification time. The file must exist and still hold `expected`
/// exactly, or the write is refused as [`CHANGED_ON_DISK`] (a background
/// patch re-reads and retries rather than merging into a newer edit). A note
/// in a local-only folder is refused (`Unsupported`): its descriptor-based
/// write path has no way to carry the time across. Returns the kept mtime.
pub fn write_note_keeping_modified(
    root: &Path,
    rel: &str,
    contents: &str,
    expected: &str,
    local_only: Option<&LocalOnlyFolders>,
    still_current: impl FnOnce() -> AppResult<()>,
) -> AppResult<Option<u64>> {
    with_graph_lock(root, || {
        still_current()?;
        let target = match resolve_note_edit(root, rel, local_only, TargetKind::Note)? {
            EditTarget::Graph(target) => target,
            EditTarget::LocalOnly(_) => {
                return Err(AppError::unsupported(
                    "a note in a local-only folder can't be written without touching its \
                     modification time",
                ));
            }
        };
        if read_current(root, &target)?.as_deref() != Some(expected) {
            return Err(AppError::io(CHANGED_ON_DISK));
        }
        let modified = fs::symlink_metadata(&target)?.modified()?;
        let modified_ms = io::atomic_write_with_modified(root, &target, contents, modified)?;
        own_writes::record(root, rel, contents.as_bytes());
        Ok(modified_ms)
    })
}

/// Atomically create the note at `rel` only while the path is still free: a
/// concurrent sync checkout or creator wins as `Collision`, with its file
/// left byte-for-byte intact. A note in an editable local-only folder is
/// claimed the same way, through directory descriptors that never follow a
/// link. `still_current` runs under the graph lock before any write.
pub fn create_note(
    root: &Path,
    rel: &str,
    contents: &str,
    local_only: Option<&LocalOnlyFolders>,
    still_current: impl FnOnce() -> AppResult<()>,
) -> AppResult<NoteCreateOutcome> {
    with_graph_lock(root, || {
        still_current()?;
        let outcome = match resolve_note_edit(root, rel, local_only, TargetKind::Note)? {
            EditTarget::Graph(target) => match io::atomic_create(root, &target, contents)? {
                AtomicCreateOutcome::Created(modified_ms) => {
                    NoteCreateOutcome::Created { modified_ms }
                }
                AtomicCreateOutcome::Collision => NoteCreateOutcome::Collision,
            },
            EditTarget::LocalOnly(entry) => crate::local_only_edit::create_note(&entry, contents)?,
        };
        if matches!(outcome, NoteCreateOutcome::Created { .. }) {
            own_writes::record(root, rel, contents.as_bytes());
        }
        Ok(outcome)
    })
}

/// The note at `target` as `note_read` returns it, or `None` when there is no
/// file. The graph root may legitimately sit behind a symlink (`/var`, a
/// linked `~/Dropbox`): canonicalize it once, police the rest.
fn read_current(root: &Path, target: &Path) -> AppResult<Option<String>> {
    let rest = target
        .strip_prefix(root)
        .map_err(|_| AppError::traversal("note path is outside the graph"))?;
    match io::read_note_no_follow(&root.canonicalize()?, rest) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Write a note without a revision check, for tests that stage a file. The
/// caller holds the graph lock.
#[cfg(any(test, feature = "test-support"))]
pub fn write_unchecked(root: &Path, rel: &str, contents: &str) -> AppResult<NoteWriteOutcome> {
    write_own(root, rel, &crate::resolve(root, rel)?, contents)
}

fn write_own(root: &Path, rel: &str, target: &Path, contents: &str) -> AppResult<NoteWriteOutcome> {
    let modified_ms = atomic_write(root, target, contents)?;
    own_writes::record(root, rel, contents.as_bytes());
    Ok(NoteWriteOutcome {
        modified_ms,
        merged: None,
    })
}

fn merge_into_moved_note(
    root: &Path,
    rel: &str,
    target: &Path,
    contents: &str,
    base: &str,
    current: String,
) -> AppResult<NoteWriteOutcome> {
    let disk_ms = fs::metadata(target).ok().as_ref().and_then(modified_ms);
    let unchanged = |merged: Option<String>| NoteWriteOutcome {
        modified_ms: disk_ms,
        merged,
    };
    let Some(content) = merged_text(base, contents, &current, disk_ms)? else {
        return Ok(unchanged(None));
    };
    if content == current {
        return Ok(unchanged(Some(content)));
    }
    let modified_ms = write_own(root, rel, target, &content)?.modified_ms;
    Ok(NoteWriteOutcome {
        modified_ms,
        merged: Some(content),
    })
}

/// The text a checked write lands when the note moved past the writer's
/// revision `base`: the conflict ladder's merge of `contents` (the writer's
/// side, stamped now) with `current` (the disk's side, stamped `disk_ms`).
/// `None` when the two sides already agree.
pub(crate) fn merged_text(
    base: &str,
    contents: &str,
    current: &str,
    disk_ms: Option<u64>,
) -> AppResult<Option<String>> {
    use crate::conflict::ladder::{self, ConflictInput};
    use crate::conflict::{ConflictSide, Resolution};

    if current == contents {
        return Ok(None);
    }
    let disk_ms_value = disk_ms.unwrap_or(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
        .max(disk_ms_value + 1);
    let resolution = ladder::resolve(ConflictInput {
        base: Some(base),
        sides: (
            ConflictSide {
                content: contents.to_string(),
                modified_ms: now_ms,
            },
            ConflictSide {
                content: current.to_string(),
                modified_ms: disk_ms_value,
            },
        ),
        merge_loop_detected: false,
    })?;
    Ok(match resolution {
        Resolution::AlreadyResolved => None,
        Resolution::Merged { content } | Resolution::Reconciled { content } => Some(content),
    })
}

/// The per-segment transcript cache lives under `.reflect/transcripts/`:
/// derived, rebuildable data (deleting it re-bills a transcription, never
/// loses content), invisible to the watcher, indexer, and sync like the rest
/// of `.reflect/`. It gets its own narrow commands because the attachment
/// IPC is deliberately fenced to `assets/` and `audio-memos/`.
pub fn transcript_cache_file(
    root: &Path,
    name: &str,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<std::path::PathBuf> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name == "."
        || name == ".."
    {
        return Err(AppError::traversal(format!(
            "transcript cache name must be a plain filename: {name:?}"
        )));
    }
    // Through the shared guard: a cache directory (or entry) symlinked
    // outside the graph must not redirect IO past the generation-pinned
    // root, nor into a local-only folder. The plain-filename check above
    // stays — `resolve` would accept a nested relative path, and a cache
    // name must be a single segment.
    let path = resolve_write(root, &format!(".reflect/transcripts/{name}"), local_only)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(path)
}

pub fn ensure_revealable_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_safe_visible(path) {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a revealable path: {path}"
    )))
}

/// Both ends of a user's note move, on the same side of every local-only
/// boundary ([`resolve_note_move`]).
pub enum NoteMove {
    /// Between ordinary paths, absolute.
    Graph { from_abs: PathBuf, to_abs: PathBuf },
    /// Within editable local-only folders.
    LocalOnly {
        from_entry: LocalOnlyEntry,
        to_entry: LocalOnlyEntry,
    },
}

/// Resolve both ends of a user's note move ([`resolve_note_edit`]), refusing
/// one that crosses a local-only boundary: a note moves within ordinary
/// paths or within editable local-only folders, never into or out of them
/// (that changes where it is backed up and who may read it). The rename
/// pipeline calls this before any index row moves, and the rename itself
/// resolves again.
pub fn resolve_note_move(
    root: &Path,
    from: &str,
    to: &str,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<NoteMove> {
    let from_target = resolve_note_edit(root, from, local_only, TargetKind::Note)?;
    let to_target = resolve_note_edit(root, to, local_only, TargetKind::Note)?;
    match (from_target, to_target) {
        (EditTarget::Graph(from_abs), EditTarget::Graph(to_abs)) => {
            Ok(NoteMove::Graph { from_abs, to_abs })
        }
        (EditTarget::LocalOnly(from_entry), EditTarget::LocalOnly(to_entry)) => {
            Ok(NoteMove::LocalOnly {
                from_entry,
                to_entry,
            })
        }
        _ => Err(AppError::traversal(format!(
            "moving {from} to {to} crosses a local-only boundary"
        ))),
    }
}

/// Rename `from` → `to` on disk (both graph-relative, traversal-guarded).
/// The caller holds the graph lock.
///
/// An occupied destination refuses (loudly), matching the projection half
/// (`reflect_index` `move_note`): the collision probe raced something —
/// nothing is deleted or overwritten, the caller compensates, and the rename
/// simply reports failed. One rule, no adoption heuristics; the filename
/// drifts until the next settled rename retries. A move never crosses a
/// local-only boundary ([`resolve_note_move`]).
pub fn move_note_file(
    root: &Path,
    from: &str,
    to: &str,
    local_only: Option<&LocalOnlyFolders>,
) -> AppResult<()> {
    match resolve_note_move(root, from, to, local_only)? {
        NoteMove::Graph { from_abs, to_abs } => {
            // Occupied includes an evicted iCloud note (placeholder only on
            // disk): renaming onto it would collide with the re-download
            // (Plan 21).
            if io::file_occupied(&to_abs) {
                return Err(AppError::io(format!(
                    "cannot move note: {to} already exists on disk"
                )));
            }
            if let Some(parent) = to_abs.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(from_abs, to_abs)?;
        }
        NoteMove::LocalOnly {
            from_entry,
            to_entry,
        } => {
            crate::local_only_edit::move_note(&from_entry, &to_entry, to)?;
            // The kept unsaved text follows the note to its new path.
            crate::local_only_edit::carry_recovery(&from_entry.graph_root, from, to);
        }
    }
    // Carry the note's sync ancestor across the rename (Plan 21) — a missed
    // move only degrades one future merge, never blocks the rename.
    crate::conflict::shadow::ShadowStore::new(root).record_move(from, to);
    Ok(())
}

/// Where a note delete goes, decided by [`delete_note_locked`].
pub enum DeleteTarget {
    /// An ordinary graph file: the note, or the iCloud stub that stands for
    /// an evicted one.
    Graph(PathBuf),
    /// A note in an editable local-only folder, for the directory-fd staging
    /// in `local_only_edit`.
    LocalOnly(LocalOnlyEntry),
}

/// Delete the note at `path` through `trash`, which decides what the delete
/// does with the file, then drop its sync ancestor. The caller holds the
/// graph lock. A note in a read-only local-only folder is refused.
pub fn delete_note_locked<T>(
    root: &Path,
    path: &str,
    local_only: Option<&LocalOnlyFolders>,
    trash: impl FnOnce(DeleteTarget) -> AppResult<T>,
) -> AppResult<T> {
    let target = match resolve_note_edit(root, path, local_only, TargetKind::Note)? {
        EditTarget::Graph(abs) => {
            // An iCloud-evicted note exists only as its `.name.md.icloud`
            // stub — trashing the logical path would fail and the note would
            // be undeletable. Removing the stub deletes the iCloud item
            // (Plan 21).
            let target = if abs.exists() {
                abs
            } else {
                eviction_placeholder(&abs)
                    .filter(|stub| stub.exists())
                    .unwrap_or(abs)
            };
            DeleteTarget::Graph(target)
        }
        EditTarget::LocalOnly(entry) => DeleteTarget::LocalOnly(entry),
    };
    let trashed = trash(target)?;
    // A deleted note's sync ancestor is meaningless — drop it (Plan 21).
    crate::conflict::shadow::ShadowStore::new(root).forget(path);
    Ok(trashed)
}

/// Move a deleted file under `<graph>/.reflect/trash/`, stamping the name
/// with epoch millis — and a counter beyond that — until the name is free
/// (repeat deletes of `a.md`, even within one millisecond).
pub fn move_to_graph_trash(root: &Path, abs: &Path) -> AppResult<()> {
    let trash_dir = root.join(".reflect").join("trash");
    fs::create_dir_all(&trash_dir)?;
    let name = abs
        .file_name()
        .ok_or_else(|| AppError::io("delete target has no file name"))?;
    let name = Path::new(name);
    let stem = name
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("note");
    let ext = name.extension().and_then(|value| value.to_str());
    let with_suffix = |suffix: &str| match ext {
        Some(ext) => format!("{stem}{suffix}.{ext}"),
        None => format!("{stem}{suffix}"),
    };
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| AppError::io(err.to_string()))?
        .as_millis();
    let mut target = trash_dir.join(with_suffix(""));
    let mut attempt: u32 = 0;
    while target.exists() {
        attempt += 1;
        let suffix = if attempt == 1 {
            format!("-{millis}")
        } else {
            format!("-{millis}-{attempt}")
        };
        target = trash_dir.join(with_suffix(&suffix));
    }
    fs::rename(abs, target)?;
    Ok(())
}

/// Counts from the vault catalog. `skipped` is what the walk refused or
/// failed to list (unreadable directories, symlinks, default-pruned trees) —
/// the number that keeps "why isn't my file showing up" diagnosable.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultScanStats {
    pub notes: u32,
    pub attachments: u32,
    pub skipped: u32,
}

/// The same note listing as the desktop `list_files` command, callable with a
/// plain root — the iCloud conflict sweep walks the disk fresh, outside the
/// cache. Local-only links are not followed here, and the iCloud sweep drops
/// real local-only folders from this listing itself (it writes shadow bases
/// and folds conflict copies over what it lists). The index reconcile uses
/// [`indexable_note_files`].
pub fn note_files(root: &Path) -> Vec<FileMeta> {
    io::collect_note_files(root)
}

/// [`note_files`] plus the notes inside the graph's local-only folders: the
/// listing the index reconcile diffs against (the same population as
/// `list_files`). Reconcile's whole job is to re-verify what is actually
/// there, so it walks the disk fresh, outside the cache.
pub fn indexable_note_files(root: &Path, local_only: Option<&LocalOnlyFolders>) -> Vec<FileMeta> {
    io::collect_file_catalog(root, local_only).notes
}

/// Notes and supported attachments from one fresh walk of the disk, following
/// no local-only link (the iCloud sweep's listing; see [`note_files`]).
pub fn note_and_attachment_files(root: &Path) -> (Vec<FileMeta>, Vec<FileMeta>) {
    let catalog = io::collect_file_catalog(root, None);
    (catalog.notes, catalog.attachments)
}

/// Cached catalog for the current graph. The scan runs without the graph
/// lock; the result is always returned to the caller (fresh as of its own
/// start), and is published into the cache only when generation, root, and
/// invalidation epoch are unchanged — a snapshot that predates a concurrent
/// write may serve its own caller but must never be pinned. No retry loop:
/// under sustained writes every caller simply keeps paying for its own scan.
pub fn file_catalog(state: &GraphState, generation: Option<u64>) -> AppResult<io::FileCatalog> {
    file_catalog_with(state, generation, io::collect_file_catalog)
}

fn file_catalog_with<F>(
    state: &GraphState,
    generation: Option<u64>,
    scan: F,
) -> AppResult<io::FileCatalog>
where
    F: FnOnce(&Path, Option<&LocalOnlyFolders>) -> io::FileCatalog,
{
    let (root, local_only, expected_generation, expected_revision) = {
        let inner = lock_graph(state)?;
        inner.check_generation(generation)?;
        if let Some(catalog) = &inner.catalog {
            return Ok(catalog.clone());
        }
        (
            inner.root.clone().ok_or_else(AppError::no_graph)?,
            inner.config.local_only.clone(),
            inner.generation,
            inner.catalog_revision,
        )
    };

    let catalog = scan(&root, local_only.as_deref());
    let mut inner = lock_graph(state)?;
    if inner.generation == expected_generation
        && inner.root.as_deref() == Some(root.as_path())
        && inner.catalog.is_none()
        && inner.catalog_revision == expected_revision
    {
        inner.catalog = Some(catalog.clone());
    }
    Ok(catalog)
}

/// Invalidate the session for a graph delete: under one lock hold, check the
/// generation, clear the root and its configuration and bump the generation,
/// so a pinned write that waited on the graph lock fails its re-check
/// afterwards instead of recreating directories under the trashed path.
pub fn invalidate_for_delete(state: &GraphState, generation: u64) -> AppResult<()> {
    let mut inner = lock_graph(state)?;
    inner.check_generation(Some(generation))?;
    let root = inner.root.take().ok_or_else(AppError::no_graph)?;
    crate::displaced_revisions::clear(&root);
    inner.config = GraphConfig::default();
    inner.generation += 1;
    inner.catalog = None;
    inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
    Ok(())
}

/// Invalidate the catalog only if `root` is still the active generation's
/// root. A late watcher/iCloud callback for a previous graph is harmless.
pub fn invalidate_file_catalog(state: &GraphState, root: &Path) {
    match state.0.lock() {
        Ok(mut inner) if inner.root.as_deref() == Some(root) => {
            inner.catalog = None;
            inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
        }
        Ok(_) => {}
        Err(error) => tracing::error!(
            ?error,
            "graph state lock poisoned while invalidating catalog"
        ),
    }
}

#[cfg(test)]
mod transcript_cache_tests {
    use super::transcript_cache_file;

    #[test]
    fn accepts_a_plain_name_and_creates_the_cache_dir() {
        let graph = tempfile::tempdir().expect("graph");
        let path =
            transcript_cache_file(graph.path(), "memo.part-001.m4a.json", None).expect("path");
        assert!(path.ends_with(".reflect/transcripts/memo.part-001.m4a.json"));
        assert!(graph.path().join(".reflect/transcripts").is_dir());
    }

    #[test]
    fn rejects_path_shaped_names() {
        let graph = tempfile::tempdir().expect("graph");
        assert!(transcript_cache_file(graph.path(), "../escape.json", None).is_err());
        assert!(transcript_cache_file(graph.path(), "a/b.json", None).is_err());
        assert!(transcript_cache_file(graph.path(), "", None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_cache_dir_symlinked_outside_the_graph() {
        let graph = tempfile::tempdir().expect("graph");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::create_dir_all(graph.path().join(".reflect")).expect("reflect dir");
        std::os::unix::fs::symlink(outside.path(), graph.path().join(".reflect/transcripts"))
            .expect("symlink");
        assert!(transcript_cache_file(graph.path(), "memo.json", None).is_err());
    }
}

#[cfg(test)]
mod file_catalog_tests {
    use super::{
        GraphConfig, GraphInner, GraphState, file_catalog, file_catalog_with,
        invalidate_file_catalog,
    };
    use std::fs;
    use std::sync::Mutex;

    fn graph_at(root: &std::path::Path, generation: u64) -> GraphState {
        GraphState(Mutex::new(GraphInner {
            generation,
            root: Some(root.to_path_buf()),
            config: GraphConfig::default(),
            catalog: None,
            catalog_revision: 0,
        }))
    }

    #[test]
    fn catalog_is_cached_until_invalidated_and_pinned_to_the_generation() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("write root note");
        fs::create_dir_all(vault.path().join("Media")).expect("create media");
        fs::write(vault.path().join("Media/diagram.png"), b"png").expect("write attachment");
        let graph = graph_at(vault.path(), 7);

        let first = file_catalog(&graph, Some(7)).expect("first catalog");
        assert_eq!(first.notes[0].path, "README.md");
        assert_eq!(first.attachments[0].path, "Media/diagram.png");

        fs::create_dir_all(vault.path().join("Projects")).expect("create projects");
        fs::write(vault.path().join("Projects/plan.md"), "# Plan\n").expect("write nested note");
        let cached = file_catalog(&graph, Some(7)).expect("cached catalog");
        assert_eq!(cached.notes.len(), 1);

        invalidate_file_catalog(&graph, vault.path());
        let refreshed = file_catalog(&graph, Some(7)).expect("refreshed catalog");
        assert_eq!(
            refreshed
                .notes
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["Projects/plan.md", "README.md"]
        );

        assert!(file_catalog(&graph, Some(6)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn the_catalog_lists_local_only_folders_but_the_sweep_listing_does_not() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().expect("dir");
        let base = dir.path().canonicalize().expect("canonical");
        let (vault, raw) = (base.join("vault"), base.join("raw"));
        fs::create_dir_all(vault.join("finance")).expect("finance");
        fs::create_dir_all(raw.join("finance/secure")).expect("raw");
        fs::write(vault.join("README.md"), "# Root\n").expect("root note");
        fs::write(raw.join("finance/secure/bank.md"), "# Bank\n").expect("bank");
        symlink(raw.join("finance/secure"), vault.join("finance/secure")).expect("link");
        let graph = graph_at(&vault, 2);
        graph.0.lock().expect("graph lock").set_local_only(Some(
            reflect_graph_paths::LocalOnlyFolders::new(["secure"], Some(&raw)).expect("folders"),
        ));

        let listed: Vec<String> = file_catalog(&graph, Some(2))
            .expect("catalog")
            .notes
            .into_iter()
            .map(|file| file.path)
            .collect();
        assert_eq!(listed, vec!["README.md", "finance/secure/bank.md"]);
        let swept: Vec<String> = super::note_files(&vault)
            .into_iter()
            .map(|file| file.path)
            .collect();
        assert_eq!(swept, vec!["README.md"]);
    }

    #[test]
    fn invalidation_from_an_old_root_cannot_clear_the_active_catalog() {
        let vault = tempfile::tempdir().expect("vault");
        let old_vault = tempfile::tempdir().expect("old vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("write root note");
        let graph = graph_at(vault.path(), 3);
        file_catalog(&graph, Some(3)).expect("catalog");

        invalidate_file_catalog(&graph, old_vault.path());

        assert!(graph.0.lock().expect("graph lock").catalog.is_some());
    }

    #[test]
    fn a_scan_racing_an_invalidation_serves_its_caller_but_is_never_pinned() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("write root note");
        let graph = graph_at(vault.path(), 5);

        let stale = file_catalog_with(&graph, Some(5), |root, local_only| {
            let scanned = super::io::collect_file_catalog(root, local_only);
            // A write lands while the scan is in flight: the scan's snapshot
            // may serve its own caller, but must not become the cache.
            fs::write(root.join("arrived.md"), "# Arrived\n").expect("write racing note");
            invalidate_file_catalog(&graph, root);
            scanned
        })
        .expect("racing catalog");
        assert_eq!(stale.notes.len(), 1);
        assert!(graph.0.lock().expect("graph lock").catalog.is_none());

        let fresh = file_catalog(&graph, Some(5)).expect("fresh catalog");
        assert_eq!(
            fresh
                .notes
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["README.md", "arrived.md"]
        );
    }
}

#[cfg(test)]
mod graph_info_tests {
    use super::{GraphConfig, graph_info};
    use reflect_graph_paths::LocalOnlyFolders;
    use serde_json::json;
    use std::path::Path;
    use std::sync::Arc;

    fn config(folders: Option<LocalOnlyFolders>) -> GraphConfig {
        GraphConfig {
            local_only: folders.map(Arc::new),
            ..GraphConfig::default()
        }
    }

    #[test]
    fn graph_info_carries_the_editable_folders_to_the_typescript_boundary() {
        let (folders, _) = LocalOnlyFolders::new(["secure", "archive"], None)
            .unwrap()
            .with_editable(["secure"]);
        let info = graph_info(Path::new("/vaults/notes"), 3, &config(Some(folders)));
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["localOnlyFolders"], json!(["secure", "archive"]));
        assert_eq!(value["localOnlyEditableFolders"], json!(["secure"]));

        let read_only = LocalOnlyFolders::new(["secure"], None).unwrap();
        let info = graph_info(Path::new("/vaults/notes"), 3, &config(Some(read_only)));
        assert_eq!(
            serde_json::to_value(&info).unwrap()["localOnlyEditableFolders"],
            json!([])
        );
        let info = graph_info(Path::new("/vaults/notes"), 3, &config(None));
        assert_eq!(
            serde_json::to_value(&info).unwrap()["localOnlyEditableFolders"],
            json!([])
        );
    }
}

#[cfg(test)]
mod note_create_tests {
    use super::NoteCreateOutcome;
    use serde_json::json;

    #[test]
    fn outcome_serializes_for_the_typescript_boundary() {
        assert_eq!(
            serde_json::to_value(NoteCreateOutcome::Created {
                modified_ms: Some(1_234),
            })
            .unwrap(),
            json!({ "kind": "created", "modifiedMs": 1_234 })
        );
        assert_eq!(
            serde_json::to_value(NoteCreateOutcome::Collision).unwrap(),
            json!({ "kind": "collision" })
        );
    }
}

#[cfg(test)]
mod move_tests {
    use super::{
        ensure_openable_path, ensure_readable_attachment_path, ensure_revealable_path,
        move_note_file,
    };
    use std::fs;

    fn graph() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        dir
    }

    #[test]
    fn renames_when_the_destination_is_free() {
        let root = graph();
        fs::write(root.path().join("notes/a.md"), "# A\n").unwrap();
        move_note_file(root.path(), "notes/a.md", "notes/b.md", None).unwrap();
        assert!(!root.path().join("notes/a.md").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("notes/b.md")).unwrap(),
            "# A\n"
        );
    }

    #[test]
    fn an_occupied_destination_refuses_with_both_files_intact() {
        // Whatever appeared at the destination after the collision probe,
        // nothing is deleted or overwritten — the rename just fails.
        let root = graph();
        fs::write(root.path().join("notes/a.md"), "# Mine\n").unwrap();
        fs::write(root.path().join("notes/b.md"), "# Theirs\n").unwrap();
        assert!(move_note_file(root.path(), "notes/a.md", "notes/b.md", None).is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "# Mine\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/b.md")).unwrap(),
            "# Theirs\n"
        );
    }

    #[test]
    fn an_evicted_destination_also_refuses() {
        // The destination exists only as an iCloud eviction placeholder — it
        // looks vacant to is_file(), but the real note comes back on
        // re-download, so the rename must refuse exactly like a present file.
        let root = graph();
        fs::write(root.path().join("notes/a.md"), "# Mine\n").unwrap();
        fs::write(root.path().join("notes/.b.md.icloud"), "stub").unwrap();
        assert!(move_note_file(root.path(), "notes/a.md", "notes/b.md", None).is_err());
        assert!(root.path().join("notes/a.md").exists());
    }

    #[test]
    fn a_page_opens_externally_but_is_never_read_or_served() {
        assert!(ensure_openable_path("assets/explainer.html").is_ok());
        assert!(ensure_openable_path("career/2027 Job Hunting/assets/q07.HTM").is_ok());
        assert!(ensure_openable_path("assets/cat.png").is_ok());
        // Reads (`asset_read`, the asset protocol) keep refusing it.
        assert!(ensure_readable_attachment_path("assets/explainer.html").is_err());
        assert!(ensure_openable_path("notes/secret.md").is_err());
        assert!(ensure_openable_path("tools/script.sh").is_err());
        assert!(ensure_openable_path(".hidden/page.html").is_err());
        assert!(ensure_openable_path("../page.html").is_err());
    }

    #[test]
    fn asset_open_accepts_supported_attachments_anywhere_and_nothing_else() {
        assert!(ensure_readable_attachment_path("assets/cat.png").is_ok());
        assert!(ensure_readable_attachment_path("assets/report.docx").is_ok());
        assert!(ensure_readable_attachment_path("assets/archive.zip").is_ok());
        assert!(ensure_readable_attachment_path("Projects/Media/cat.png").is_ok());
        assert!(ensure_readable_attachment_path("audio-memos/memo.m4a").is_ok());
        // Notes, hidden components, traversal, extensionless paths, and
        // executable formats refuse.
        assert!(ensure_readable_attachment_path("notes/secret.md").is_err());
        assert!(ensure_readable_attachment_path("tools/script.sh").is_err());
        assert!(ensure_readable_attachment_path(".obsidian/cat.png").is_err());
        assert!(ensure_readable_attachment_path("../cat.png").is_err());
        assert!(ensure_readable_attachment_path("assets/").is_err());
        assert!(ensure_readable_attachment_path("assets").is_err());
    }

    #[test]
    fn asset_reveal_accepts_any_safe_visible_path_and_nothing_else() {
        // The reveal fallback must cover exactly the files the open guard
        // refuses by extension, so it checks lexical safety only.
        assert!(ensure_revealable_path("assets/tool.xyz").is_ok());
        assert!(ensure_revealable_path("assets/report.docx").is_ok());
        assert!(ensure_revealable_path("Projects/Media/cat.png").is_ok());
        assert!(ensure_revealable_path(".reflect/index.sqlite").is_err());
        assert!(ensure_revealable_path("../outside.png").is_err());
        assert!(ensure_revealable_path("/absolute.png").is_err());
    }
}

#[cfg(test)]
mod note_revision_tests {
    use super::*;

    fn write(
        root: &Path,
        rel: &str,
        contents: &str,
        expected: Option<&str>,
    ) -> AppResult<NoteWriteOutcome> {
        write_note_revision(root, rel, contents, expected, None, || Ok(()))
    }

    #[test]
    fn poisoned_ordering_lock_does_not_disable_note_writes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        let _ = std::panic::catch_unwind(|| {
            let _: AppResult<()> = with_graph_lock(&root, || panic!("simulated writer panic"));
        });
        let target = directory.path().join("note.md");
        write(directory.path(), "note.md", "saved", None).unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "saved");
    }

    #[test]
    fn expected_revision_is_compared_with_lf_line_endings() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        fs::write(&target, "a\r\nb\r\n").unwrap();
        let outcome = write(directory.path(), "note.md", "a\nb!\n", Some("a\nb\n")).unwrap();
        assert_eq!(outcome.merged, None);
        assert_eq!(fs::read_to_string(target).unwrap(), "a\nb!\n");
    }

    #[test]
    fn stale_revision_does_not_replace_newer_text() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("daily.md");
        fs::write(&target, "user edited this").unwrap();
        let outcome = write(directory.path(), "daily.md", "bookmark", Some("old text")).unwrap();
        let on_disk = fs::read_to_string(&target).unwrap();
        for word in ["user", "edited", "this", "bookmark"] {
            assert!(on_disk.contains(word), "{word} missing from {on_disk:?}");
        }
        assert_eq!(outcome.merged, Some(on_disk));
        write(
            directory.path(),
            "daily.md",
            "user edited this\nbookmark",
            Some(&fs::read_to_string(&target).unwrap()),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "user edited this\nbookmark"
        );
    }

    #[test]
    fn a_checked_write_against_a_moved_file_merges_under_the_lock() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        fs::write(&target, "a\nb\nc\nd\n").unwrap();
        let outcome = write(directory.path(), "note.md", "A\nb\nc\n", Some("a\nb\nc\n")).unwrap();
        assert_eq!(outcome.merged, Some("A\nb\nc\nd\n".to_string()));
        assert_eq!(fs::read_to_string(&target).unwrap(), "A\nb\nc\nd\n");
        assert_eq!(
            outcome.modified_ms,
            fs::metadata(&target).ok().as_ref().and_then(modified_ms)
        );
        assert!(own_writes::is_own(
            directory.path(),
            "note.md",
            b"A\nb\nc\nd\n"
        ));
    }

    #[test]
    fn a_disk_file_with_marker_text_merges_as_plain_text() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("note.md");
        let base = "intro\n\nmiddle\n\noutro\n";
        let disk =
            "intro\n\n<<<<<<< mac\nmiddle mac\n=======\nmiddle phone\n>>>>>>> phone\n\noutro\n";
        fs::write(&target, disk).unwrap();
        let mine = "INTRO\n\nmiddle\n\noutro\n";
        let outcome = write(root, "note.md", mine, Some(base)).unwrap();
        let merged = outcome.merged.unwrap();
        assert!(merged.starts_with("INTRO\n"), "{merged}");
        assert!(
            merged.contains("<<<<<<< mac\nmiddle mac\n=======\nmiddle phone\n>>>>>>> phone\n"),
            "{merged}"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), merged);
    }

    #[test]
    fn an_identical_racing_write_is_a_no_op() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        fs::write(&target, "a\nb\n").unwrap();
        let before = fs::metadata(&target).ok().as_ref().and_then(modified_ms);
        let outcome = write(directory.path(), "note.md", "a\nb\n", Some("a\n")).unwrap();
        assert_eq!(
            outcome,
            NoteWriteOutcome {
                modified_ms: before,
                merged: None,
            }
        );
        assert!(!directory.path().join(".reflect").exists());
    }

    /// A checked write naming the revision a pull moved away from the path
    /// is refused, not merged: the editor follows the copy. Any other stale
    /// revision still merges, and a graph open forgets the record.
    #[test]
    fn a_write_naming_a_displaced_revision_is_refused_until_the_graph_opens() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("note.md");
        fs::write(&target, "theirs\n").unwrap();
        crate::displaced_revisions::replace(root, [("note.md".to_string(), "mine\n".to_string())]);

        let refused = write(root, "note.md", "mine, edited\n", Some("mine\n")).unwrap_err();
        assert_eq!(refused.message(), CHANGED_ON_DISK);
        assert_eq!(fs::read_to_string(&target).unwrap(), "theirs\n");
        let merged = write(root, "note.md", "older, edited\n", Some("older\n")).unwrap();
        assert!(merged.merged.is_some(), "{merged:?}");

        activate(&GraphState::default(), root, GraphConfig::default()).unwrap();
        let merged = write(root, "note.md", "mine, edited\n", Some("mine\n")).unwrap();
        assert!(merged.merged.is_some(), "{merged:?}");
    }

    #[test]
    fn outcome_serializes_for_the_typescript_boundary() {
        assert_eq!(
            serde_json::to_value(NoteWriteOutcome {
                modified_ms: Some(7),
                merged: None,
            })
            .unwrap(),
            serde_json::json!({ "modifiedMs": 7, "merged": null })
        );
    }

    #[test]
    fn missing_revision_never_clobbers_an_existing_daily() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("daily.md");
        write(directory.path(), "daily.md", "first", None).unwrap();
        assert!(write(directory.path(), "daily.md", "second", None).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "first");
    }

    /// An empty file and a missing one are different revisions: a writer that
    /// read nothing must not land over an empty file, nor the reverse.
    #[test]
    fn an_empty_file_is_not_a_missing_one() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("daily.md");
        let refused = write(directory.path(), "daily.md", "text", Some("")).unwrap_err();
        assert_eq!(refused.message(), CHANGED_ON_DISK);
        assert!(!target.exists());

        fs::write(&target, "").unwrap();
        assert!(write(directory.path(), "daily.md", "text", None).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "");

        write(directory.path(), "daily.md", "text", Some("")).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "text");
    }

    #[test]
    fn a_write_keeping_modified_lands_with_the_old_mtime_and_refuses_a_stale_revision() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("plan.md");
        fs::write(&target, "# Plan").unwrap();
        let earlier =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        fs::File::options()
            .write(true)
            .open(&target)
            .unwrap()
            .set_modified(earlier)
            .unwrap();
        let keep = |contents: &str, expected: &str| {
            write_note_keeping_modified(
                directory.path(),
                "plan.md",
                contents,
                expected,
                None,
                || Ok(()),
            )
        };

        assert!(keep("# Replaced", "# Stale").is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Plan");
        let modified_ms = keep("# Replaced", "# Plan").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Replaced");
        assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), earlier);
        assert_eq!(modified_ms, Some(1_600_000_000_000));
        // Never a create.
        let missing =
            write_note_keeping_modified(directory.path(), "new.md", "x", "", None, || Ok(()));
        assert!(missing.is_err());
        assert!(!directory.path().join("new.md").exists());
    }
}

#[cfg(test)]
mod graph_delete_race_tests {
    use super::{
        GraphConfig, GraphInner, GraphState, invalidate_for_delete, root_for_generation,
        with_graph_lock, write_note_revision,
    };
    use crate::graph_lock;
    use std::sync::{Mutex, mpsc};
    use std::time::{Duration, Instant};

    /// A write that waited on the graph lock behind a delete must fail its
    /// generation re-check instead of recreating directories under the
    /// trashed root.
    #[test]
    fn a_write_queued_behind_graph_delete_does_not_recreate_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("graph");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let graph = GraphState(Mutex::new(GraphInner {
            generation: 1,
            root: Some(root.clone()),
            config: GraphConfig::default(),
            catalog: None,
            catalog_revision: 0,
        }));

        std::thread::scope(|scope| {
            let (locked_tx, locked_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel::<()>();
            // Stands in for `graph_delete`: invalidate and trash under the lock.
            let root = &root;
            let graph = &graph;
            let deleter = scope.spawn(move || {
                with_graph_lock(root, || {
                    locked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    invalidate_for_delete(graph, 1)?;
                    std::fs::remove_dir_all(root)?;
                    Ok(())
                })
            });
            locked_rx.recv().unwrap();
            let writer = scope.spawn(move || {
                write_note_revision(root, "notes/late.md", "# Late\n", None, None, || {
                    root_for_generation(graph, 1).map(drop)
                })
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            while graph_lock::holders(root) < 2 {
                assert!(Instant::now() < deadline, "the write never queued");
                std::thread::sleep(Duration::from_millis(5));
            }
            release_tx.send(()).unwrap();
            deleter.join().unwrap().unwrap();
            let error = writer.join().unwrap().unwrap_err();
            assert!(error.message().contains("graph changed"), "{error:?}");
        });
        assert!(!root.exists());
    }
}
