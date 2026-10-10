//! Graph file-IO primitives (Plan 02).
//!
//! Markdown files are the durable source of truth; this module moves bytes and
//! paths, not meaning. All paths are **graph-relative** — the graph root lives
//! in Rust state and the frontend can never address files outside it
//! (path-traversal guard, [`resolve`]). Writes are atomic (temp file + rename,
//! [`io`]) and deletes go to the OS trash. Parsing/indexing live in later plans.

pub mod asset_protocol;
pub mod assets;
#[cfg(unix)]
mod beneath;
pub mod device;
mod image_thumbnail;
mod import;
mod import_assets;
mod io;
mod local_only;
mod local_only_edit;
pub mod pdf_render;
mod preview_cache;
pub mod recovery;
mod resolve;
pub mod trust_report;
pub mod x_archive;
mod x_archive_store;
mod x_download;
pub mod x_media_protocol;
pub mod x_syndication;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};
use reflect_graph_paths::LocalOnlyFolders;

use self::io::{
    atomic_create, atomic_write, bootstrap, collect_files, initialize_runtime, AtomicCreateOutcome,
};
use self::resolve::{
    resolve, resolve_note_edit, resolve_read, resolve_shareable, resolve_write, EditTarget,
    TargetKind,
};

/// What an index recorded about its local-only folders (read by `db`).
pub(crate) use self::local_only::Recorded;

/// Cancellation flag for the running Reflect V1 import, managed as Tauri
/// state in `lib.rs` (`graph_import_cancel` trips it).
pub use self::import::ImportCancel;

/// Atomic byte write staged under `.reflect/tmp/`, shared with the conflict
/// machinery (shadow bases, resolution writes) so every graph write follows
/// the same crash-safe, sync-clean path.
pub(crate) use self::io::atomic_write_bytes;

/// The no-follow directory walk, shared with Git sync's pull: it moves this
/// device's uncommitted entries out of the paths it writes (`git::displace`)
/// and writes conflict copies without clobbering anything.
#[cfg(unix)]
pub(crate) use self::beneath::{
    entry_beneath, names_beneath, open_dir_beneath, persist_beneath, read_beneath,
    read_link_beneath, remove_beneath, rename_beneath, subdir_beneath, BeneathDir, BeneathError,
    EntryKind, EntryStat, Persist, Persisted, Renamed,
};

/// "Occupied" probe (real file OR eviction placeholder), shared with the
/// iCloud sweep's collision folding — an evicted canonical note must not be
/// treated as a free slot (Plan 21).
pub(crate) use self::io::file_occupied;
/// Sync-exclusion marking, shared with `git::repo` (a freshly initialized
/// backup repo must never ride a file-sync provider — Plan 21).
pub(crate) use self::io::mark_dir_local_only;
pub(crate) use self::io::modified_ms;
/// The lexical traversal guard, shared with the conflict stores that mirror
/// note paths under `.reflect/` (shadow bases, conflict archive).
pub(crate) use self::resolve::ensure_relative;
/// The entry-side guard: what a merge never checks out, a commit never
/// stages, and the iCloud sweep never touches.
pub(crate) use self::resolve::entry_is_local_only;
/// The full traversal guard, shared with sibling modules that address graph
/// files (capture promotes screenshots into `assets/`).
pub(crate) use self::resolve::resolve as resolve_in_graph;
/// The sharing guard, shared with on-device transcription: its transcript
/// lands in an ordinary note, so a recording in a local-only folder is
/// never read.
#[cfg(target_os = "macos")]
pub(crate) use self::resolve::resolve_shareable as resolve_shareable_in_graph;
/// The write-side guard, shared with the Git merge: a path the filesystem
/// resolves into a local-only folder (or out of the graph) is never written.
pub(crate) use self::resolve::resolve_write as resolve_write_in_graph;
/// iCloud eviction-placeholder path construction, shared with note deletion
/// and the desktop watcher (which treats an evicted note as present, not
/// deleted — Plan 21). The grammar now lives in `reflect-graph-paths`.
pub(crate) use reflect_graph_paths::eviction_placeholder;
/// iCloud eviction-placeholder name mapping, shared with the iCloud
/// container discovery (`icloud::storage`) — Apple-only, like its callers.
#[cfg(any(target_os = "ios", target_os = "macos"))]
pub(crate) use reflect_graph_paths::icloud_placeholder_target;
/// Dataless-file probe (modern macOS eviction: bytes remote, real path
/// intact), shared with the desktop watcher and the iCloud pending walk —
/// every place that must not mistake an evicted note for a readable one.
pub(crate) use reflect_graph_paths::is_dataless;

/// The open graph root plus a monotonic generation, kept **under one lock** so
/// they swap atomically (the same pattern as the index's `IndexState`, Plan 04b).
/// Mutating commands carry the generation they were issued for and are rejected
/// when it's stale — so a write enqueued for one graph can never land in another
/// graph's same-named file after a switch swaps the root.
#[derive(Default)]
pub struct GraphInner {
    pub generation: u64,
    pub root: Option<PathBuf>,
    /// The open graph's local-only folders (`local_only`), loaded with the
    /// root and swapped with it: one value feeds the walk, the read guard,
    /// the watcher, the index flag, Git, and `GraphInfo`.
    local_only: Option<Arc<LocalOnlyFolders>>,
    /// The configuration problems found at open, shown to the user.
    local_only_warnings: Vec<String>,
    /// The settings file was unreadable at open: which folders are
    /// local-only is unknown, so sync refuses to run ([`graph_for_sync`]).
    local_only_unknown: bool,
    /// The configuration is unknown, so the index open only adds to the
    /// recorded folders (`local_only::LoadedConfig::record`).
    local_only_grow_record: bool,
    /// The open graph's Git backup size limit in bytes (`git::max_file_size`),
    /// loaded with the root; `None` until a graph opens.
    backup_max_file_bytes: Option<u64>,
    /// The open graph's accepted history roots (`git::history_roots`), loaded
    /// with the root: the starting commits Git sync may join.
    accepted_history_roots: Vec<git2::Oid>,
    /// The backup settings' configuration problems found at open (the size
    /// limit and the accepted history roots).
    backup_warnings: Vec<String>,
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

    /// The open graph's local-only folders (shared with the watcher, which
    /// reads them under the graph lock it already holds).
    #[cfg(desktop)]
    pub(crate) fn local_only(&self) -> Option<Arc<LocalOnlyFolders>> {
        self.local_only.clone()
    }

    /// Install a local-only configuration directly: command-tier tests
    /// build their `GraphState` without the settings store.
    #[cfg(test)]
    pub(crate) fn set_local_only(&mut self, folders: Option<LocalOnlyFolders>) {
        self.local_only = folders.map(Arc::new);
    }

    /// Mark the configuration unknown (an unreadable settings file, or
    /// recorded names gone missing), keeping whatever folders are set, for
    /// command-tier tests.
    #[cfg(test)]
    pub(crate) fn set_local_only_unknown(&mut self) {
        self.local_only_unknown = true;
        self.local_only_grow_record = true;
    }

    /// Install accepted history roots directly, for command-tier tests.
    #[cfg(test)]
    pub(crate) fn set_accepted_history_roots(&mut self, roots: Vec<git2::Oid>) {
        self.accepted_history_roots = roots;
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

/// Metadata for a file inside the graph.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub size: u64,
    /// Last-modified time in epoch milliseconds.
    pub modified_ms: u64,
    /// True when the file is iCloud-evicted: the note exists but its content
    /// is not on disk until re-downloaded. Consumers must not read it — a
    /// read blocks on an on-demand download — and must not treat it as
    /// deleted (Plan 21). Covers both eviction forms: for a legacy `.icloud`
    /// stub, `size` and `modified_ms` describe the stub; for a modern
    /// dataless file they are the real (preserved) values.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub placeholder: bool,
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

/// Where [`note_delete`] put the note.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDeleteOutcome {
    pub trashed: Trashed,
}

/// Which trash holds a deleted note.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Trashed {
    /// The system Trash (desktop): Finder's Put Back restores it.
    System,
    /// The graph's own `.reflect/trash/`: mobile has no system Trash, and a
    /// local-only note stays there when the system Trash refuses it.
    Graph,
}

/// Why a write refuses when the file no longer holds what its writer read.
/// The app's idempotent patches re-read and retry once on exactly this text.
const CHANGED_ON_DISK: &str = "Note changed on disk; reload before retrying";

// ---- state accessors --------------------------------------------------------

fn graph_info(
    root: &Path,
    generation: u64,
    local_only: Option<&LocalOnlyFolders>,
    warnings: &[String],
    backup_warnings: &[String],
) -> GraphInfo {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
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
        local_only_warnings: warnings.to_vec(),
        backup_warnings: backup_warnings.to_vec(),
    }
}

/// Set the active root (bumping the generation atomically), record it in
/// recents, and return its info.
fn activate(state: &State<GraphState>, root: &Path) -> AppResult<GraphInfo> {
    // Read the settings store (and the index's record of the folders) before
    // taking the lock: it is file IO.
    let loaded = local_only::load_for_root(root);
    for warning in &loaded.warnings {
        tracing::warn!(root = %root.display(), "local-only folders: {warning}");
    }
    let backup_limit = crate::git::load_max_file_size(root);
    for warning in &backup_limit.warnings {
        tracing::warn!(root = %root.display(), "backup size limit: {warning}");
    }
    let history_roots = crate::git::load_accepted_history_roots(root);
    for warning in &history_roots.warnings {
        tracing::warn!(root = %root.display(), "accepted history roots: {warning}");
    }
    let backup_warnings: Vec<String> = backup_limit
        .warnings
        .iter()
        .chain(&history_roots.warnings)
        .cloned()
        .collect();
    let generation = {
        let mut inner = lock_graph(state)?;
        inner.generation += 1;
        inner.root = Some(root.to_path_buf());
        inner.local_only = loaded.folders.clone();
        inner.local_only_warnings = loaded.warnings.clone();
        inner.local_only_unknown = loaded.unknown;
        inner.local_only_grow_record = !loaded.record;
        inner.backup_max_file_bytes = Some(backup_limit.max_file_bytes);
        inner.accepted_history_roots = history_roots.roots;
        inner.backup_warnings = backup_warnings.clone();
        inner.catalog = None;
        inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
        inner.generation
    };
    let info = graph_info(
        root,
        generation,
        loaded.folders.as_deref(),
        &loaded.warnings,
        &backup_warnings,
    );
    // Recents is a convenience cache: a failure to persist it must not fail the
    // open (which would leave Rust treating the graph as open while the command
    // returns an error, out of sync with the UI). Best-effort, log and move on.
    if let Err(err) = crate::recents::record(root, &info.name) {
        tracing::warn!(?err, "failed to record recent graph");
    }
    Ok(info)
}

fn lock_graph(state: &GraphState) -> AppResult<std::sync::MutexGuard<'_, GraphInner>> {
    state.0.lock().map_err(|err| {
        // A poisoned lock means a command panicked while holding it — the panic
        // itself is the bug; this context points at the blast radius.
        tracing::error!(?err, "graph state lock poisoned by an earlier panic");
        AppError::io("graph state lock poisoned")
    })
}

pub(crate) fn current_root(state: &State<GraphState>) -> AppResult<PathBuf> {
    lock_graph(state)?
        .root
        .clone()
        .ok_or_else(AppError::no_graph)
}

/// The open graph's identity as a pure read — the note-window bootstrap
/// (`windows::window_bootstrap`) must *adopt* the session, never re-open it:
/// a generation bump here would strand every command the main window has
/// pinned to the current one.
pub(crate) fn current_graph_info(state: &State<GraphState>) -> AppResult<GraphInfo> {
    let inner = lock_graph(state)?;
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok(graph_info(
        &root,
        inner.generation,
        inner.local_only.as_deref(),
        &inner.local_only_warnings,
        &inner.backup_warnings,
    ))
}

/// The current root, verified against the generation a mutating command was
/// issued for. A stale generation means the graph was switched after the
/// command was enqueued — the mutation must be rejected (loudly), or it would
/// land in the *new* graph's same-named file.
pub(crate) fn root_for_generation(
    state: &State<GraphState>,
    generation: u64,
) -> AppResult<PathBuf> {
    Ok(graph_for(state, Some(generation))?.0)
}

/// The open graph's root and local-only folders, read under one lock so the
/// pair always describes the same graph. `generation` is the optional pin
/// read commands take: UI reads for the open graph omit it, background passes
/// (audio-memo reconcile) that can span a graph switch must supply it so
/// every step of a pass sees one graph — a stale pin is rejected exactly like
/// [`root_for_generation`].
pub(crate) fn graph_for(
    state: &GraphState,
    generation: Option<u64>,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>)> {
    let inner = lock_graph(state)?;
    inner.check_generation(generation)?;
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok((root, inner.local_only.clone()))
}

/// The open graph's Git backup size limit, verified against the generation
/// the commit was issued for (like [`root_for_generation`]); `None` when the
/// open did not load one.
pub(crate) fn backup_max_file_bytes(state: &GraphState, generation: u64) -> AppResult<Option<u64>> {
    let inner = lock_graph(state)?;
    inner.check_generation(Some(generation))?;
    Ok(inner.backup_max_file_bytes)
}

/// The open graph's accepted history roots, verified against the generation
/// the sync command was issued for (like [`root_for_generation`]); empty
/// when the open loaded none.
pub(crate) fn accepted_history_roots(
    state: &GraphState,
    generation: u64,
) -> AppResult<Vec<git2::Oid>> {
    let inner = lock_graph(state)?;
    inner.check_generation(Some(generation))?;
    Ok(inner.accepted_history_roots.clone())
}

/// Why sync refuses while the local-only configuration is unknown.
const SYNC_PAUSED: &str = "Sync is paused: Reflect cannot tell which folders are local-only \
     (see the warning shown when the graph opened). Restore the local-only configuration, \
     then reopen the graph.";

/// Why sharing refuses while the local-only configuration is unknown.
const SHARING_PAUSED: &str = "Sharing is paused: Reflect cannot tell which folders are \
     local-only, so nothing leaves this device (see the warning shown when the graph \
     opened). Restore the local-only configuration, then reopen the graph.";

/// [`graph_for`] that also refuses, under the same lock, while the open
/// graph's local-only configuration is unknown.
fn graph_when_known(
    state: &GraphState,
    generation: Option<u64>,
    refusal: &'static str,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>)> {
    let inner = lock_graph(state)?;
    inner.check_generation(generation)?;
    if inner.local_only_unknown {
        return Err(AppError::io(refusal));
    }
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok((root, inner.local_only.clone()))
}

/// [`graph_for`] for Git sync and the iCloud sweep and move-in, which must
/// know what to leave alone.
pub(crate) fn graph_for_sync(
    state: &GraphState,
    generation: u64,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>)> {
    graph_when_known(state, Some(generation), SYNC_PAUSED)
}

/// [`graph_for`] for bytes about to leave this device (AI, transcription,
/// asset description, capture enrichment, gists).
pub(crate) fn graph_for_sharing(
    state: &GraphState,
    generation: Option<u64>,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>)> {
    graph_when_known(state, generation, SHARING_PAUSED)
}

/// The open graph's root and local-only folders plus whether the index may
/// replace its record with them, under one lock: the index open marks rows
/// private either way, and while the configuration is unknown it only adds
/// the names to the record.
pub(crate) fn graph_for_index(
    state: &GraphState,
) -> AppResult<(PathBuf, Option<Arc<LocalOnlyFolders>>, bool)> {
    let inner = lock_graph(state)?;
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok((
        root,
        inner.local_only.clone(),
        !inner.local_only_grow_record,
    ))
}

/// Reads and OS opens accept any supported attachment anywhere in the vault:
/// an adopted vault keeps its images beside its notes. Classification is the
/// shared `graph-paths` policy, so neither surface can serve a note, a hidden
/// file, or a traversal path. Writes are deliberately untouched — Reflect
/// only ever creates files under `assets/` and `audio-memos/`, and widening
/// reads must not widen what Reflect will write.
fn ensure_readable_attachment_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_attachment(path) {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a supported attachment path: {path}"
    )))
}

/// Paths the OS default app may open: supported attachments, plus pages
/// (`.html`) that Reflect never reads or serves itself but a browser may run.
fn ensure_openable_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_openable(path) {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a supported attachment path: {path}"
    )))
}

// ---- commands --------------------------------------------------------------

/// Create a new graph at `path` (scaffolds the layout) and open it.
#[tauri::command]
pub fn graph_create(path: String, state: State<GraphState>) -> AppResult<GraphInfo> {
    let root = PathBuf::from(&path);
    fs::create_dir_all(&root)?;
    bootstrap(&root)?;
    activate(&state, &root)
}

/// Import a user-selected Reflect V1 export `.zip` into the open graph. V1's
/// export is already the graph folder shape, so this extracts safe entries
/// directly under the current root; existing files are never replaced (and
/// never fail the import — identical files skip, conflicting notes rename,
/// conflicting daily notes merge). Attachments the notes link to on Firebase
/// Storage or Reflect's asset CDN are downloaded into `assets/` first and the
/// links rewritten, so the imported graph doesn't depend on Reflect V1's
/// infrastructure staying up. Progress is emitted as `import:progress` events,
/// and [`graph_import_cancel`] aborts the run before anything lands in the
/// graph.
#[tauri::command]
pub async fn graph_import_reflect_v1_zip(
    path: String,
    generation: u64,
    app: tauri::AppHandle,
    state: State<'_, GraphState>,
    cancel: State<'_, ImportCancel>,
) -> AppResult<import::ImportSummary> {
    let (root, local_only) = graph_for(&state, Some(generation))?;
    // Holds the one import slot until this command returns on any path — a
    // second import starting mid-run would clear a cancel meant for the
    // first and race its writes.
    let _running = cancel.begin()?;
    let prepared = import::prepare_zip_import(&root, Path::new(&path))?;
    if prepared.remote_asset_count() > 0 {
        emit_import_progress(&app, "downloading", 0, prepared.remote_asset_count());
    }
    let download_app = app.clone();
    let user_agent = crate::app_user_agent(&app);
    let downloads = prepared
        .download_assets(
            &user_agent,
            cancel.flag(),
            std::sync::Arc::new(move |done, total| {
                emit_import_progress(&download_app, "downloading", done, total);
            }),
        )
        .await?;
    // The downloads can take a while; refuse to write into a graph the user
    // has switched away from (or an import the user cancelled) in the
    // meantime — nothing has been written yet.
    cancel.ensure_active()?;
    root_for_generation(&state, generation)?;
    // Writing is fast and local; throttle the events to ~100 per import so a
    // large graph doesn't flood the webview.
    let mut last_emitted = 0usize;
    let folders = local_only.as_deref();
    let summary = import::finalize_import(&root, folders, prepared, downloads, |done, total| {
        let step = (total / 100).max(1);
        if done == total || done >= last_emitted + step {
            last_emitted = done;
            emit_import_progress(&app, "writing", done, total);
        }
    })?;
    invalidate_file_catalog(&state, &root);
    Ok(summary)
}

/// Cancel the running Reflect V1 import (a no-op when none is running). The
/// import aborts before any graph write, so cancellation is always safe.
#[tauri::command]
pub fn graph_import_cancel(cancel: State<ImportCancel>) {
    cancel.cancel();
}

fn emit_import_progress(app: &tauri::AppHandle, stage: &'static str, done: usize, total: usize) {
    let _ = app.emit(
        "import:progress",
        import::ImportProgress { stage, done, total },
    );
}

/// Open an existing Markdown vault in place, adding only `.reflect/` runtime
/// state. Reflect's authoring directories remain lazy for adopted vaults.
#[tauri::command]
pub fn graph_open(path: String, state: State<GraphState>) -> AppResult<GraphInfo> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::not_found(format!("not a directory: {path}")));
    }
    initialize_runtime(&root)?;
    activate(&state, &root)
}

/// Read a note's markdown by graph-relative path. `generation`, when given,
/// pins the read to the issuing graph session (see [`graph_for`]).
///
/// Off the main thread on purpose: this read *does* materialize an evicted
/// iCloud note (that is its contract — bulk passes use [`note_read_local`]),
/// and an on-demand download from a sync command would freeze the whole app
/// for its duration, exactly like the old synchronous asset protocol.
#[tauri::command]
pub async fn note_read(
    path: String,
    generation: Option<u64>,
    state: State<'_, GraphState>,
) -> AppResult<String> {
    let (root, local_only) = graph_for(&state, generation)?;
    let target = resolve_read(&root, &path, local_only.as_deref())?;
    crate::blocking::run_blocking(move || Ok(io::read_note_no_follow(&target.base, &target.rest)?))
        .await
}

/// How a [`note_read_shareable`] request found the note.
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

/// Read a note bound for somewhere beyond this machine (the AI tools, whose
/// paths are model-supplied). Only a visible Markdown file is served
/// ([`ensure_shareable_note_path`]). Rust decides local-only status, not the
/// requested string: a folded spelling (`ſecure`, `SECURE`) or an in-graph
/// alias of a local-only folder answers `LocalOnly` exactly like the
/// canonical path. Otherwise identical to [`note_read`].
#[tauri::command]
pub async fn note_read_shareable(
    path: String,
    generation: Option<u64>,
    state: State<'_, GraphState>,
) -> AppResult<ShareableNoteRead> {
    let (root, local_only) = graph_for_sharing(&state, generation)?;
    read_shareable(root, local_only, path).await
}

async fn read_shareable(
    root: PathBuf,
    local_only: Option<Arc<LocalOnlyFolders>>,
    path: String,
) -> AppResult<ShareableNoteRead> {
    ensure_shareable_note_path(&path)?;
    // By name first, with no IO: a dangling or unmounted link still refuses
    // as local-only rather than as a traversal error.
    if local_only
        .as_deref()
        .is_some_and(|folders| folders.covers(&path))
    {
        return Ok(ShareableNoteRead::LocalOnly);
    }
    let target = resolve_read(&root, &path, local_only.as_deref())?;
    if target.local_only {
        return Ok(ShareableNoteRead::LocalOnly);
    }
    crate::blocking::run_blocking(move || {
        Ok(ShareableNoteRead::Content {
            content: io::read_note_no_follow(&target.base, &target.rest)?,
        })
    })
    .await
}

/// A shareable read serves visible Markdown only: notes, and the
/// `assets/<file>.reflect.md` description sidecars the read_assets tool reads.
/// The traversal guard alone admits hidden trees (`.git/`, `.reflect/`) and
/// every file type, and these paths are model-supplied, so anything else is
/// refused before any IO.
fn ensure_shareable_note_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_safe_visible(path) && path.ends_with(".md") {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a shareable note path: {path}"
    )))
}

/// How a [`note_read_local`] request found the note on disk.
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

/// Read a note's markdown **only when its bytes are local**. Bulk background
/// passes (the embedding backfill, asset-description gathering) must use this
/// instead of [`note_read`]: reading an evicted note makes `fileproviderd`
/// materialize it on demand, and a whole-graph pass over an evicted iCloud
/// graph becomes thousands of serial blocking downloads. Runs off the main
/// thread — even a local read must not stall the UI under a busy provider.
/// Dataless materialization is switched off for the whole check-and-read
/// ([`io::NoMaterialize`], per TN3150), so an eviction racing the stat
/// reports `Evicted` instead of blocking on a download; engaging the policy
/// is best-effort, and on the rare refusal a narrow stat-then-read race
/// remains (see the call-site comment).
#[tauri::command]
pub async fn note_read_local(
    path: String,
    generation: Option<u64>,
    state: State<'_, GraphState>,
) -> AppResult<LocalNoteRead> {
    let (root, local_only) = graph_for(&state, generation)?;
    let target = resolve_read(&root, &path, local_only.as_deref())?;
    let abs = target.path();
    crate::blocking::run_blocking(move || {
        // Best-effort: when the guard refuses to engage, the read keeps a
        // slim stat-then-read race (an eviction landing between the two
        // materializes that one file).
        let _no_materialize = io::NoMaterialize::engage();
        match fs::metadata(&abs) {
            Ok(meta) if is_dataless(&meta) => return Ok(LocalNoteRead::Evicted),
            Err(err)
                if err.kind() == std::io::ErrorKind::NotFound
                    && eviction_placeholder(&abs).is_some_and(|stub| stub.exists()) =>
            {
                return Ok(LocalNoteRead::Evicted);
            }
            _ => {}
        }
        match io::read_note_no_follow(&target.base, &target.rest) {
            Ok(content) => Ok(LocalNoteRead::Content {
                content,
                local_only: target.local_only,
            }),
            // The engaged policy answers a dataless read with EDEADLK
            // instead of downloading: the eviction raced the stat.
            Err(err) if err.kind() == std::io::ErrorKind::Deadlock => Ok(LocalNoteRead::Evicted),
            Err(err) => Err(err.into()),
        }
    })
    .await
}

static NOTE_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Serialize a write into the graph's working tree with Git sync's pull.
/// Note writes and creates, asset writes, note moves, and the V1 import's
/// writes take it; a pull holds it from the scan that moves this
/// device's uncommitted entries out of its way until the working tree is
/// final (`git::merge`), so nothing lands in between to be overwritten. A
/// pull can hold it for seconds, so the commands that take it run on the
/// blocking pool, never on the main thread. A panic while it was held
/// poisons nothing: the guard protects ordering, not data.
pub(crate) fn note_write_guard() -> NoteWriteGuard {
    NoteWriteGuard {
        _held: NOTE_WRITE_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    }
}

/// The note write guard, held ([`note_write_guard`]); dropping it lets the
/// next writer or pull in. A function that must run under it takes one.
pub(crate) struct NoteWriteGuard {
    _held: std::sync::MutexGuard<'static, ()>,
}

/// Atomically write a note's markdown by graph-relative path. `generation` pins
/// the write to the graph it was issued for (see `root_for_generation`).
///
/// Every write is checked: `check_contents` must be `true`, and the file must
/// still hold `expected_contents` (`None`: the file must not exist), or the
/// write is refused and the file is left as it is. A writer that skipped the
/// check could put back text over bytes a sync pull or another device just
/// wrote.
///
/// A note in an editable local-only folder ([`resolve_note_edit`]) is
/// written through directory descriptors that never follow a link, and its
/// revision is checked again, by file identity, right before the rename.
///
/// Returns the written file's on-disk mtime (epoch ms, `None` when the
/// platform can't provide one) so the caller's index echo can stamp the row
/// with the value a later `list_files` will report — a `Date.now()` stamp
/// never matches and costs a re-read on every reconcile.
///
/// `expected_contents` is compared with the note as [`note_read`] returns it,
/// with privacy-preserving line-ending normalization. `contents` is written as given.
///
/// Runs on the blocking pool: the write waits on the note write guard,
/// which a Git pull holds through its checkout.
#[tauri::command]
pub async fn note_write(
    path: String,
    contents: String,
    generation: u64,
    check_contents: Option<bool>,
    expected_contents: Option<String>,
    state: State<'_, GraphState>,
) -> AppResult<Option<u64>> {
    if check_contents != Some(true) {
        return Err(AppError::parse(
            "a note write must name the contents it replaces",
        ));
    }
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let target = resolve_note_edit(&root, &path, local_only.as_deref(), TargetKind::Note)?;
    let written = root.clone();
    let modified_ms = crate::blocking::run_blocking(move || match target {
        EditTarget::Graph(target) => {
            write_note_revision(&written, &target, &contents, expected_contents.as_deref())
        }
        EditTarget::LocalOnly(entry) => {
            let _guard = note_write_guard();
            local_only_edit::write_note(&entry, &contents, expected_contents.as_deref())
        }
    })
    .await?;
    invalidate_file_catalog(&state, &root);
    Ok(modified_ms)
}

/// [`note_write`] for a change that is not an edit: the note keeps its
/// modification time, so the All Notes recency order and "Updated" column
/// don't move. The background AI summary pass writes its `aiSummary`
/// frontmatter block through it; a whole graph of summaries must not read as
/// a graph of fresh edits.
///
/// The file must exist and still hold `expected_contents`. A note in a
/// local-only folder is refused (`Unsupported`): its descriptor-based write
/// path has no way to carry the time across.
///
/// Returns the kept mtime (epoch ms) for the index echo.
#[tauri::command]
pub async fn note_write_keep_modified(
    path: String,
    contents: String,
    generation: u64,
    expected_contents: String,
    state: State<'_, GraphState>,
) -> AppResult<Option<u64>> {
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let target = resolve_note_edit(&root, &path, local_only.as_deref(), TargetKind::Note)?;
    let written = root.clone();
    let modified_ms = crate::blocking::run_blocking(move || match target {
        EditTarget::Graph(target) => {
            write_note_keeping_modified(&written, &target, &contents, &expected_contents)
        }
        EditTarget::LocalOnly(_) => Err(AppError::unsupported(
            "a note in a local-only folder can't be written without touching its modification time",
        )),
    })
    .await?;
    invalidate_file_catalog(&state, &root);
    Ok(modified_ms)
}

fn write_note_keeping_modified(
    root: &Path,
    target: &Path,
    contents: &str,
    expected: &str,
) -> AppResult<Option<u64>> {
    let _guard = note_write_guard();
    check_note_revision(root, target, Some(expected))?;
    let modified = fs::symlink_metadata(target)?.modified()?;
    io::atomic_write_with_modified(root, target, contents, modified)
}

/// Refuse unless the note at `target` holds exactly `expected` (`None`: the
/// file must not exist). The caller holds the note write guard.
fn check_note_revision(root: &Path, target: &Path, expected: Option<&str>) -> AppResult<()> {
    // The graph root may legitimately sit behind a symlink (`/var`, a linked
    // `~/Dropbox`): canonicalize it once, police the rest.
    let rest = target
        .strip_prefix(root)
        .map_err(|_| AppError::traversal("note path is outside the graph"))?;
    let current = match io::read_note_no_follow(&root.canonicalize()?, rest) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if current.as_deref() != expected {
        return Err(AppError::io(CHANGED_ON_DISK));
    }
    Ok(())
}

fn write_note_revision(
    root: &Path,
    target: &Path,
    contents: &str,
    expected: Option<&str>,
) -> AppResult<Option<u64>> {
    let _guard = note_write_guard();
    check_note_revision(root, target, expected)?;
    atomic_write(root, target, contents)
}

/// Atomically create a note only when `path` is still free. Unlike
/// [`note_write`], this is a no-clobber claim: a concurrent sync checkout or
/// creator wins as `Collision`, with its file left byte-for-byte intact. A
/// note in an editable local-only folder is claimed the same way, through
/// directory descriptors that never follow a link.
/// Runs on the blocking pool, like [`note_write`].
#[tauri::command]
pub async fn note_create(
    path: String,
    contents: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<NoteCreateOutcome> {
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let created = root.clone();
    let outcome = crate::blocking::run_blocking(move || {
        let _guard = note_write_guard();
        match resolve_note_edit(&created, &path, local_only.as_deref(), TargetKind::Note)? {
            EditTarget::Graph(target) => match atomic_create(&created, &target, &contents)? {
                AtomicCreateOutcome::Created(modified_ms) => {
                    Ok(NoteCreateOutcome::Created { modified_ms })
                }
                AtomicCreateOutcome::Collision => Ok(NoteCreateOutcome::Collision),
            },
            EditTarget::LocalOnly(entry) => local_only_edit::create_note(&entry, &contents),
        }
    })
    .await?;
    if matches!(outcome, NoteCreateOutcome::Created { .. }) {
        invalidate_file_catalog(&state, &root);
    }
    Ok(outcome)
}

/// Atomically write a binary asset (pasted/dropped image) by graph-relative
/// path. Contents arrive base64-encoded — Tauri IPC args are JSON, and pasted
/// images are small enough that the ~33% encoding overhead is irrelevant.
/// Runs on the blocking pool, like [`note_write`].
#[tauri::command]
pub async fn asset_write(
    path: String,
    contents_base64: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<()> {
    use base64::Engine;
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let target = resolve_write(&root, &path, local_only.as_deref())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|err| AppError::io(format!("invalid base64 asset payload: {err}")))?;
    let written = root.clone();
    crate::blocking::run_blocking(move || {
        let _guard = note_write_guard();
        atomic_write_bytes(&written, &target, &bytes)
    })
    .await?;
    invalidate_file_catalog(&state, &root);
    Ok(())
}

/// Delete one recording under `audio-memos/`: cancelling a recording session
/// discards the segments it already landed. Deliberately scoped to the
/// `audio-memos/` prefix so this command can never grow into a general
/// file-delete IPC. Idempotent — a segment deleted twice (or never written)
/// is fine.
#[tauri::command]
pub fn audio_memo_delete(path: String, generation: u64, state: State<GraphState>) -> AppResult<()> {
    if !path.starts_with("audio-memos/") {
        return Err(AppError::traversal(format!(
            "not an audio memo path: {path}"
        )));
    }
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let abs = resolve_write(&root, &path, local_only.as_deref())?;
    // An iCloud-evicted segment exists only as its `.name.icloud` stub —
    // mirror `note_delete` so a cancelled session's evicted parts still
    // delete (Plan 21).
    let target = if abs.exists() {
        abs
    } else {
        eviction_placeholder(&abs)
            .filter(|stub| stub.exists())
            .unwrap_or(abs)
    };
    match fs::remove_file(target) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

/// The per-segment transcript cache lives under `.reflect/transcripts/`:
/// derived, rebuildable data (deleting it re-bills a transcription, never
/// loses content), invisible to the watcher, indexer, and sync like the rest
/// of `.reflect/`. It gets its own narrow commands because the attachment
/// IPC is deliberately fenced to `assets/` and `audio-memos/`.
fn transcript_cache_file(
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

/// Read one cached segment transcript; `notFound` when nothing is cached.
#[tauri::command]
pub fn transcript_cache_read(
    name: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<String> {
    let (root, local_only) = graph_for(&state, Some(generation))?;
    match fs::read_to_string(transcript_cache_file(&root, &name, local_only.as_deref())?) {
        Ok(contents) => Ok(contents),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Err(AppError::not_found(format!("no cached transcript: {name}")))
        }
        Err(err) => Err(err.into()),
    }
}

/// Cache one segment's transcription result. A torn write is harmless — the
/// reader treats undecodable JSON as "no cache" and re-transcribes.
#[tauri::command]
pub fn transcript_cache_write(
    name: String,
    contents: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    let (root, local_only) = graph_for(&state, Some(generation))?;
    fs::write(
        transcript_cache_file(&root, &name, local_only.as_deref())?,
        contents,
    )?;
    Ok(())
}

/// Read a binary asset's bytes as a **raw IPC response** — no base64, no
/// JSON. Long audio memos read back for transcription would otherwise cross
/// the bridge ~1.33× inflated inside one giant JSON string. Pinned to
/// `generation` for the same reason as [`asset_read`], and refused for
/// local-only files the same way.
#[tauri::command]
pub fn asset_read_binary(
    path: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<tauri::ipc::Response> {
    let (root, local_only) = graph_for_sharing(&state, Some(generation))?;
    let abs = resolve_shareable(&root, &path, local_only.as_deref())?;
    Ok(tauri::ipc::Response::new(fs::read(abs)?))
}

/// Read a binary asset's bytes, base64-encoded for the JSON IPC (e.g. audio
/// memos read back for transcription). Pinned to `generation`, unlike
/// `note_read`: the caller is a background pass that can span a graph
/// switch, and an unpinned read would resolve against the *new* root —
/// handing back (and possibly sending to a provider) another graph's file.
/// Every caller ships the bytes off-device (transcription, asset
/// description, capture enrichment), so a local-only file is refused
/// however its path is spelled.
#[tauri::command]
pub fn asset_read(path: String, generation: u64, state: State<GraphState>) -> AppResult<String> {
    use base64::Engine;
    ensure_readable_attachment_path(&path)?;
    let (root, local_only) = graph_for_sharing(&state, Some(generation))?;
    let bytes = fs::read(resolve_shareable(&root, &path, local_only.as_deref())?)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Open a graph asset in the OS default application. The frontend supplies the
/// graph-relative `assets/...` path from markdown; Rust resolves it inside the
/// generation-pinned graph so the JS opener never gets broad filesystem access.
/// A page (`.html`) opens here too, in the browser, and nowhere in Reflect.
#[tauri::command]
pub fn asset_open(
    path: String,
    generation: u64,
    app: tauri::AppHandle,
    state: State<GraphState>,
) -> AppResult<()> {
    ensure_openable_path(&path)?;
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let abs = resolve_read(&root, &path, local_only.as_deref())?.path();
    if !abs.is_file() {
        return Err(AppError::not_found(format!("asset not found: {path}")));
    }
    open_asset_path(&app, &abs)
}

#[cfg(target_os = "ios")]
fn open_asset_path(app: &tauri::AppHandle, path: &Path) -> AppResult<()> {
    let url = asset_file_url(path)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|err| AppError::io(err.to_string()))
}

#[cfg(not(target_os = "ios"))]
fn open_asset_path(app: &tauri::AppHandle, path: &Path) -> AppResult<()> {
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|err| AppError::io(err.to_string()))
}

/// Reveal a graph file in the OS file manager. Deliberately laxer than
/// [`asset_open`]: revealing never executes anything, so lexical path safety
/// plus existence is the whole requirement. This is the frontend's fallback
/// when `asset_open` refuses a file type.
#[tauri::command]
pub fn asset_reveal(
    path: String,
    generation: u64,
    app: tauri::AppHandle,
    state: State<GraphState>,
) -> AppResult<()> {
    ensure_revealable_path(&path)?;
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let abs = resolve_read(&root, &path, local_only.as_deref())?.path();
    if !abs.is_file() {
        return Err(AppError::not_found(format!("asset not found: {path}")));
    }
    reveal_asset_path(&app, &abs)
}

fn ensure_revealable_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_safe_visible(path) {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a revealable path: {path}"
    )))
}

#[cfg(target_os = "ios")]
fn reveal_asset_path(_app: &tauri::AppHandle, _path: &Path) -> AppResult<()> {
    Err(AppError::io("revealing files is not supported on iOS"))
}

#[cfg(not(target_os = "ios"))]
fn reveal_asset_path(app: &tauri::AppHandle, path: &Path) -> AppResult<()> {
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|err| AppError::io(err.to_string()))
}

#[cfg(any(target_os = "ios", test))]
fn asset_file_url(path: &Path) -> AppResult<tauri::Url> {
    tauri::Url::from_file_path(path).map_err(|()| {
        AppError::io(format!(
            "failed to convert asset path to file URL: {}",
            path.display()
        ))
    })
}

/// List every file (any extension) under a graph-relative directory, e.g.
/// `audio-memos`. Which directory means what is the TypeScript layer's policy;
/// a missing directory lists as empty. Pinned to `generation` for the same
/// reason as `asset_read` — the listing seeds a background pass that must
/// never mix graphs. Files in a local-only folder are left out, including
/// every file of a directory linked into one: the passes this listing seeds
/// (transcription, asset descriptions) must never see them.
#[tauri::command]
pub fn dir_list(
    dir: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<Vec<FileMeta>> {
    let (root, local_only) = graph_for(&state, Some(generation))?;
    resolve(&root, &dir)?; // traversal guard; the walk itself skips symlinks
    let mut out = Vec::new();
    collect_files(&root, &dir, None, &mut out)?;
    if let Some(folders) = local_only.as_deref() {
        out.retain(|file| !entry_is_local_only(&root, &file.path, folders));
    }
    Ok(out)
}

/// Does a graph-relative path currently exist as a file? The collision picker
/// (Plan 17) probes disk as well as the index — the index lags the watcher by
/// a debounce, and an unindexed file must never be clobbered by a new note.
#[tauri::command]
pub fn note_exists(path: String, state: State<GraphState>) -> AppResult<bool> {
    let (root, local_only) = graph_for(&state, None)?;
    // Occupied, not merely readable: an iCloud-evicted note is only a stub on
    // disk, but creating a new note at its path would collide the moment the
    // real file re-downloads (Plan 21).
    Ok(io::file_occupied(
        &resolve_read(&root, &path, local_only.as_deref())?.path(),
    ))
}

/// Rename `from` → `to` on disk (both graph-relative, traversal-guarded).
///
/// An occupied destination refuses (loudly), matching the projection half
/// (`db::write::move_note`): the collision probe raced something — nothing is
/// deleted or overwritten, the caller compensates, and the rename simply
/// reports failed. One rule, no adoption heuristics; the filename drifts
/// until the next settled rename retries. Runs under the note write guard
/// (`_writing`), so a pull never moves either end out from under it; the
/// caller takes it before any other lock it holds across the move.
pub(crate) fn move_note_file(
    _writing: &NoteWriteGuard,
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
            local_only_edit::move_note(&from_entry, &to_entry, to)?;
            // The kept unsaved text follows the note to its new path.
            local_only_edit::carry_recovery(&from_entry.graph_root, from, to);
        }
    }
    // Carry the note's sync ancestor across the rename (Plan 21) — a missed
    // move only degrades one future merge, never blocks the rename.
    crate::conflict::shadow::ShadowStore::new(root).record_move(from, to);
    Ok(())
}

/// Both ends of a user's note move, on the same side of every local-only
/// boundary ([`resolve_note_move`]).
pub(crate) enum NoteMove {
    /// Between ordinary paths, absolute.
    Graph { from_abs: PathBuf, to_abs: PathBuf },
    /// Within editable local-only folders.
    LocalOnly {
        from_entry: resolve::LocalOnlyEntry,
        to_entry: resolve::LocalOnlyEntry,
    },
}

/// Resolve both ends of a user's note move ([`resolve_note_edit`]), refusing
/// one that crosses a local-only boundary: a note moves within ordinary
/// paths or within editable local-only folders, never into or out of them
/// (that changes where it is backed up and who may read it). The rename
/// pipeline calls this before any index row moves, and the rename itself
/// resolves again.
pub(crate) fn resolve_note_move(
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

/// Send a note to the OS trash (recoverable), not a hard delete (pinned to
/// `generation`). Mobile has no OS trash: the file moves into the graph-local
/// `.reflect/trash/` instead (Plan 19), the same recoverability promise, and
/// `.reflect/` is already excluded from sync and indexing.
///
/// A note in an editable local-only folder is first staged through directory
/// descriptors in a fresh random directory (`.reflect/trash/<random>/`, or a
/// hidden one beside the note when its folder is on another volume), so the
/// path-based OS-trash call can only ever reach the file staged there. When
/// the OS trash refuses it, a note staged in `.reflect/trash/` stays there
/// and the outcome says so ([`Trashed::Graph`]); one staged beside goes back
/// under its name and the delete fails. A trashed local-only note's kept
/// unsaved text goes with it.
///
/// Runs on the blocking pool: the local-only staging waits on the note
/// write guard, which a Git pull holds through its checkout.
#[tauri::command]
pub async fn note_delete(
    path: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<NoteDeleteOutcome> {
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let target = resolve_note_edit(&root, &path, local_only.as_deref(), TargetKind::Note)?;
    let (trash_root, trash_path) = (root.clone(), path.clone());
    let trashed = off_main(move || match target {
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
            trash_graph_file(&trash_root, &target)
        }
        EditTarget::LocalOnly(entry) => trash_local_only(&entry, &trash_path),
    })
    .await?;
    // A deleted note's sync ancestor is meaningless — drop it (Plan 21).
    crate::conflict::shadow::ShadowStore::new(&root).forget(&path);
    invalidate_file_catalog(&state, &root);
    Ok(NoteDeleteOutcome { trashed })
}

/// Run a command's filesystem work off the main thread, on the blocking
/// pool. Tests run it on their own thread instead, where the thread-local
/// seams (`os_trash_seam`, `beneath`'s) they install are in effect.
async fn off_main<T, F>(task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    #[cfg(test)]
    {
        task()
    }
    #[cfg(not(test))]
    {
        crate::blocking::run_blocking(task).await
    }
}

/// Trash an ordinary graph file: into the system Trash on desktop, into the
/// graph's own `.reflect/trash/` on mobile.
fn trash_graph_file(root: &Path, target: &Path) -> AppResult<Trashed> {
    #[cfg(desktop)]
    {
        let _ = root;
        os_trash_delete(target)?;
        Ok(Trashed::System)
    }
    #[cfg(mobile)]
    {
        move_to_graph_trash(root, target)?;
        Ok(Trashed::Graph)
    }
}

/// Trash the editable local-only note `entry` (requested as `path`): stage
/// it under the note write guard, hand it to the OS trash, and drop its kept
/// unsaved text once it is gone from its folder.
fn trash_local_only(entry: &resolve::LocalOnlyEntry, path: &str) -> AppResult<Trashed> {
    let stage = {
        let _guard = note_write_guard();
        local_only_edit::trash_note(entry)?
    };
    let trashed = hand_to_os_trash(stage)?;
    let _guard = note_write_guard();
    local_only_edit::forget_recovery(&entry.graph_root, path);
    Ok(trashed)
}

/// Hand a staged local-only note to the OS trash. When the OS trash refuses
/// (or there is none), a note staged in `.reflect/trash/` stays there
/// ([`Trashed::Graph`]); one staged beside its folder moves back under its
/// name, and the refusal is the delete's error.
fn hand_to_os_trash(stage: local_only_edit::TrashStage) -> AppResult<Trashed> {
    #[cfg(desktop)]
    let refusal = match os_trash_delete(&stage.path()) {
        Ok(()) => {
            stage.trashed();
            return Ok(Trashed::System);
        }
        Err(err) => err,
    };
    #[cfg(mobile)]
    let refusal = AppError::io("there is no system Trash on this platform");
    let kept = {
        let _guard = note_write_guard();
        stage.refused()?
    };
    if !kept {
        return Err(refusal);
    }
    tracing::warn!(
        err = ?refusal,
        "the system Trash refused a local-only note; it stays in the graph's .reflect/trash"
    );
    Ok(Trashed::Graph)
}

/// Move the open graph's **entire directory** to the OS trash (recoverable)
/// and drop it from recents. The session is invalidated (root cleared,
/// generation bumped) **before** the filesystem is touched: a concurrent
/// write pinned to this generation must fail its root check instead of
/// `create_dir_all`-recreating directories under a path being trashed. If
/// the trash move itself then fails, the session stays invalidated and the
/// frontend re-opens the intact directory to restore a writable session.
/// Pinned to `generation` — a delete enqueued before a graph switch must
/// never trash the newly opened graph. Desktop-only: mobile's fixed roots
/// have no OS trash and no delete UI.
#[tauri::command]
pub fn graph_delete(generation: u64, state: State<GraphState>) -> AppResult<()> {
    #[cfg(desktop)]
    {
        // Check-and-invalidate under one lock hold — `root_for_generation`
        // followed by a separate invalidation would leave a window where a
        // pinned write still resolves the doomed root.
        let root = {
            let mut inner = lock_graph(&state)?;
            inner.check_generation(Some(generation))?;
            let root = inner.root.take().ok_or_else(AppError::no_graph)?;
            inner.local_only = None;
            inner.local_only_warnings = Vec::new();
            inner.local_only_unknown = false;
            inner.local_only_grow_record = false;
            inner.backup_max_file_bytes = None;
            inner.accepted_history_roots = Vec::new();
            inner.backup_warnings = Vec::new();
            inner.generation += 1;
            inner.catalog = None;
            inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
            root
        };
        os_trash_delete(&root)?;
        // Recents is a convenience cache (same stance as `activate`): the
        // directory is already in the trash, so a failure to persist must not
        // report the delete as failed. A stale entry fails loudly on open.
        if let Err(err) = crate::recents::forget(&root.to_string_lossy()) {
            tracing::warn!(?err, "failed to forget deleted graph");
        }
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = (generation, &state);
        Err(AppError::io(
            "deleting a graph is not supported on this platform",
        ))
    }
}

/// Send a file to the OS trash. On macOS, use `NSFileManager.trashItemAtURL`
/// (`DeleteMethod::NsFileManager`) instead of the `trash` crate default, which
/// drives Finder over AppleScript and fails with `-10010` ("Handler can't
/// handle objects of this class") when the graph lives on a cloud-synced or
/// network volume. The NsFileManager path needs no Automation permission, makes
/// no sound, and still lands the file in the system Trash for recovery.
#[cfg(desktop)]
fn os_trash_delete(abs: &Path) -> AppResult<()> {
    // Tests never reach the real Trash: they get a stand-in.
    #[cfg(test)]
    {
        os_trash_seam::trash(abs)
    }
    #[cfg(not(test))]
    {
        #[cfg(target_os = "macos")]
        let ctx = {
            use trash::macos::{DeleteMethod, TrashContextExtMacos};
            let mut ctx = trash::TrashContext::default();
            ctx.set_delete_method(DeleteMethod::NsFileManager);
            ctx
        };
        #[cfg(not(target_os = "macos"))]
        let ctx = trash::TrashContext::default();

        ctx.delete(abs).map_err(|err| AppError::io(err.to_string()))
    }
}

/// Test-only stand-in for the system Trash, per thread: every call is
/// recorded, and with no stand-in installed the Trash refuses, which leaves
/// the file where it is. Tests must never move files into the real Trash.
#[cfg(all(test, desktop))]
pub(crate) mod os_trash_seam {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    use crate::error::{AppError, AppResult};

    type Hook = Box<dyn FnMut(&Path) -> AppResult<()>>;

    thread_local! {
        static HOOK: RefCell<Option<Hook>> = const { RefCell::new(None) };
        static CALLS: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
    }

    pub(super) fn trash(path: &Path) -> AppResult<()> {
        CALLS.with_borrow_mut(|calls| calls.push(path.to_path_buf()));
        HOOK.with_borrow_mut(|hook| match hook {
            Some(hook) => hook(path),
            None => Err(AppError::io("no system Trash in tests")),
        })
    }

    /// What the system Trash does on this thread until the guard drops.
    pub(crate) fn install(hook: impl FnMut(&Path) -> AppResult<()> + 'static) -> Installed {
        HOOK.set(Some(Box::new(hook)));
        CALLS.set(Vec::new());
        Installed
    }

    /// The paths handed to the system Trash on this thread since the last
    /// install (or the thread's start).
    pub(crate) fn calls() -> Vec<PathBuf> {
        CALLS.with_borrow(Clone::clone)
    }

    /// Restores the refusing Trash when dropped.
    pub(crate) struct Installed;

    impl Drop for Installed {
        fn drop(&mut self) {
            HOOK.set(None);
            CALLS.set(Vec::new());
        }
    }
}

/// Move a deleted file under `<graph>/.reflect/trash/`, stamping the name
/// with epoch millis — and a counter beyond that — until the name is free
/// (repeat deletes of `a.md`, even within one millisecond).
#[cfg(mobile)]
fn move_to_graph_trash(root: &Path, abs: &Path) -> AppResult<()> {
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

/// List eligible Markdown notes anywhere in the vault. `generation`, when
/// given, pins the listing to the issuing graph session (see [`graph_for`]).
///
/// Async because a cold catalog is a full-tree walk; the cached case pays
/// one thread hop, which is noise next to the IPC round-trip itself.
#[tauri::command]
pub async fn list_files<R: tauri::Runtime>(
    generation: Option<u64>,
    app: tauri::AppHandle<R>,
) -> AppResult<Vec<FileMeta>> {
    catalog_off_main(generation, app, |catalog| catalog.notes).await
}

/// List supported local attachments from the same cached catalog as
/// [`list_files`], and off the main thread for the same reason: the editor
/// asks for it as soon as a note opens, possibly before any walk has run.
#[tauri::command]
pub async fn list_attachments<R: tauri::Runtime>(
    generation: Option<u64>,
    app: tauri::AppHandle<R>,
) -> AppResult<Vec<FileMeta>> {
    catalog_off_main(generation, app, |catalog| catalog.attachments).await
}

/// Read one listing out of the cached catalog on the blocking pool.
async fn catalog_off_main<R, F>(
    generation: Option<u64>,
    app: tauri::AppHandle<R>,
    listing: F,
) -> AppResult<Vec<FileMeta>>
where
    R: tauri::Runtime,
    F: FnOnce(io::FileCatalog) -> Vec<FileMeta> + Send + 'static,
{
    // Pin the graph session before the hop, like `note_read` and `db_query`:
    // an unpinned call resolved inside the closure could list a root swapped
    // in after the invoke (the rebuild path calls this without a
    // generation). A pinned call the switch superseded fails the
    // `file_catalog` generation check instead of listing the wrong graph.
    let generation = match generation {
        Some(generation) => generation,
        None => {
            let state = app.state::<GraphState>();
            current_graph_info(&state)?.generation
        }
    };
    crate::blocking::run_blocking(move || {
        let state = app.state::<GraphState>();
        Ok(listing(file_catalog(&state, Some(generation))?))
    })
    .await
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

#[tauri::command]
pub fn vault_scan_stats(
    generation: Option<u64>,
    state: State<GraphState>,
) -> AppResult<VaultScanStats> {
    let catalog = file_catalog(&state, generation)?;
    Ok(VaultScanStats {
        notes: catalog.notes.len() as u32,
        attachments: catalog.attachments.len() as u32,
        skipped: catalog.skipped,
    })
}

/// The same note listing as [`list_files`], callable with a plain root — the
/// iCloud conflict sweep and the index reconcile walk the disk fresh, outside
/// the cache: reconcile's whole job is to re-verify what is actually there.
///
/// Local-only links are not followed here, and the iCloud sweep drops real
/// local-only folders from this listing itself (it writes shadow bases and
/// folds conflict copies over what it lists). The index reconcile uses
/// [`indexable_note_files`].
pub(crate) fn note_files(root: &Path) -> Vec<FileMeta> {
    io::collect_note_files(root)
}

/// [`note_files`] plus the notes inside the graph's local-only folders: the
/// listing the index reconcile diffs against (the same population as
/// [`list_files`]).
pub(crate) fn indexable_note_files(
    root: &Path,
    local_only: Option<&LocalOnlyFolders>,
) -> Vec<FileMeta> {
    io::collect_file_catalog(root, local_only).notes
}

/// Cached catalog for the current graph. The scan runs without the graph
/// lock; the result is always returned to the caller (fresh as of its own
/// start), and is published into the cache only when generation, root, and
/// invalidation epoch are unchanged — a snapshot that predates a concurrent
/// write may serve its own caller but must never be pinned. No retry loop:
/// under sustained writes every caller simply keeps paying for its own scan.
fn file_catalog(state: &GraphState, generation: Option<u64>) -> AppResult<io::FileCatalog> {
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
            inner.local_only.clone(),
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

/// Invalidate the catalog only if `root` is still the active generation's
/// root. A late watcher/iCloud callback for a previous graph is harmless.
pub(crate) fn invalidate_file_catalog(state: &GraphState, root: &Path) {
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
    use super::{file_catalog, file_catalog_with, invalidate_file_catalog, GraphInner, GraphState};
    use std::fs;
    use std::sync::Mutex;

    fn graph_at(root: &std::path::Path, generation: u64) -> GraphState {
        GraphState(Mutex::new(GraphInner {
            generation,
            root: Some(root.to_path_buf()),
            local_only: None,
            local_only_warnings: Vec::new(),
            local_only_unknown: false,
            local_only_grow_record: false,
            backup_max_file_bytes: None,
            accepted_history_roots: Vec::new(),
            backup_warnings: Vec::new(),
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
        graph.0.lock().expect("graph lock").local_only = Some(std::sync::Arc::new(
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
    use super::graph_info;
    use reflect_graph_paths::LocalOnlyFolders;
    use serde_json::json;
    use std::path::Path;

    #[test]
    fn graph_info_carries_the_editable_folders_to_the_typescript_boundary() {
        let (folders, _) = LocalOnlyFolders::new(["secure", "archive"], None)
            .unwrap()
            .with_editable(["secure"]);
        let info = graph_info(Path::new("/vaults/notes"), 3, Some(&folders), &[], &[]);
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["localOnlyFolders"], json!(["secure", "archive"]));
        assert_eq!(value["localOnlyEditableFolders"], json!(["secure"]));

        let read_only = LocalOnlyFolders::new(["secure"], None).unwrap();
        let info = graph_info(Path::new("/vaults/notes"), 3, Some(&read_only), &[], &[]);
        assert_eq!(
            serde_json::to_value(&info).unwrap()["localOnlyEditableFolders"],
            json!([])
        );
        let info = graph_info(Path::new("/vaults/notes"), 3, None, &[], &[]);
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
        asset_file_url, ensure_openable_path, ensure_readable_attachment_path,
        ensure_revealable_path, move_note_file, note_write_guard,
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
        move_note_file(
            &note_write_guard(),
            root.path(),
            "notes/a.md",
            "notes/b.md",
            None,
        )
        .unwrap();
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
        assert!(move_note_file(
            &note_write_guard(),
            root.path(),
            "notes/a.md",
            "notes/b.md",
            None
        )
        .is_err());
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
        assert!(move_note_file(
            &note_write_guard(),
            root.path(),
            "notes/a.md",
            "notes/b.md",
            None
        )
        .is_err());
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

    #[test]
    fn asset_file_url_percent_encodes_local_paths() {
        let path = std::env::temp_dir().join("Reflect Cat Photo.png");
        let url = asset_file_url(&path).unwrap();

        assert_eq!(url.scheme(), "file");
        assert!(url.as_str().contains("Reflect%20Cat%20Photo.png"));
    }
}

#[cfg(test)]
mod note_revision_tests {
    use super::*;

    #[test]
    fn poisoned_ordering_lock_does_not_disable_note_writes() {
        let _ = std::panic::catch_unwind(|| {
            let _guard = NOTE_WRITE_LOCK
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            panic!("simulated writer panic");
        });
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        write_note_revision(directory.path(), &target, "saved", None).unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "saved");
    }

    #[test]
    fn expected_revision_is_compared_with_lf_line_endings() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        fs::write(&target, "a\r\nb\r\n").unwrap();
        assert!(
            write_note_revision(directory.path(), &target, "a\nb!\n", Some("a\r\nb\r\n")).is_err()
        );
        write_note_revision(directory.path(), &target, "a\nb!\n", Some("a\nb\n")).unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "a\nb!\n");
    }

    #[test]
    fn stale_revision_does_not_replace_newer_text() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("daily.md");
        fs::write(&target, "user edited this").unwrap();
        assert!(
            write_note_revision(directory.path(), &target, "bookmark", Some("old text")).is_err()
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "user edited this");
        write_note_revision(
            directory.path(),
            &target,
            "user edited this\nbookmark",
            Some("user edited this"),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "user edited this\nbookmark"
        );
    }

    #[test]
    fn missing_revision_never_clobbers_an_existing_daily() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("daily.md");
        write_note_revision(directory.path(), &target, "first", None).unwrap();
        assert!(write_note_revision(directory.path(), &target, "second", None).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "first");
    }

    /// An empty file and a missing one are different revisions: a writer that
    /// read nothing must not land over an empty file, nor the reverse.
    #[test]
    fn an_empty_file_is_not_a_missing_one() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("daily.md");
        assert!(write_note_revision(directory.path(), &target, "text", Some("")).is_err());
        assert!(!target.exists());

        fs::write(&target, "").unwrap();
        assert!(write_note_revision(directory.path(), &target, "text", None).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "");

        write_note_revision(directory.path(), &target, "text", Some("")).unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "text");
    }
}

#[cfg(test)]
mod note_write_command_tests {
    //! The command-tier contract: `note_write` writes only with a revision
    //! check, whatever the caller sends.
    use super::*;
    use tauri::Manager;

    struct Session {
        app: tauri::App<tauri::test::MockRuntime>,
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    /// An open graph holding one note, `notes/plan.md`.
    fn session() -> Session {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap().join("graph");
        io::bootstrap(&root).unwrap();
        fs::write(root.join("notes/plan.md"), "# Plan").unwrap();
        {
            let state: State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(root.clone());
        }
        Session {
            app,
            _dir: dir,
            root,
        }
    }

    fn write(
        session: &Session,
        path: &str,
        check_contents: Option<bool>,
        expected_contents: Option<&str>,
    ) -> AppResult<Option<u64>> {
        tauri::async_runtime::block_on(note_write(
            path.to_string(),
            "# Replaced".to_string(),
            1,
            check_contents,
            expected_contents.map(str::to_string),
            session.app.state(),
        ))
    }

    #[test]
    fn an_unchecked_write_is_refused_and_leaves_the_note_intact() {
        let session = session();
        for check_contents in [None, Some(false)] {
            for expected_contents in [None, Some("# Plan")] {
                let refused = write(&session, "notes/plan.md", check_contents, expected_contents)
                    .expect_err("an unchecked write must be refused");
                assert!(matches!(refused, AppError::Parse { .. }), "{refused:?}");
            }
        }
        assert_eq!(
            fs::read_to_string(session.root.join("notes/plan.md")).unwrap(),
            "# Plan"
        );
        // An unchecked write never creates a file either.
        assert!(write(&session, "notes/new.md", None, None).is_err());
        assert!(!session.root.join("notes/new.md").exists());
    }

    #[test]
    fn a_checked_write_lands_only_over_the_contents_it_names() {
        let session = session();
        let plan = session.root.join("notes/plan.md");
        assert!(write(&session, "notes/plan.md", Some(true), Some("# Stale")).is_err());
        assert!(write(&session, "notes/plan.md", Some(true), None).is_err());
        assert_eq!(fs::read_to_string(&plan).unwrap(), "# Plan");

        write(&session, "notes/plan.md", Some(true), Some("# Plan")).unwrap();
        assert_eq!(fs::read_to_string(&plan).unwrap(), "# Replaced");

        // `None` names a file that must not exist yet.
        write(&session, "notes/new.md", Some(true), None).unwrap();
        assert_eq!(
            fs::read_to_string(session.root.join("notes/new.md")).unwrap(),
            "# Replaced"
        );
    }

    fn write_keeping_modified(
        session: &Session,
        path: &str,
        expected_contents: &str,
    ) -> AppResult<Option<u64>> {
        tauri::async_runtime::block_on(note_write_keep_modified(
            path.to_string(),
            "# Replaced".to_string(),
            1,
            expected_contents.to_string(),
            session.app.state(),
        ))
    }

    #[test]
    fn a_write_keeping_modified_lands_with_the_old_mtime() {
        let session = session();
        let plan = session.root.join("notes/plan.md");
        let earlier =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        fs::File::options()
            .write(true)
            .open(&plan)
            .unwrap()
            .set_modified(earlier)
            .unwrap();

        let modified_ms = write_keeping_modified(&session, "notes/plan.md", "# Plan").unwrap();
        assert_eq!(fs::read_to_string(&plan).unwrap(), "# Replaced");
        assert_eq!(fs::metadata(&plan).unwrap().modified().unwrap(), earlier);
        assert_eq!(modified_ms, Some(1_600_000_000_000));
    }

    #[test]
    fn a_write_keeping_modified_is_checked_and_never_creates() {
        let session = session();
        let plan = session.root.join("notes/plan.md");
        assert!(write_keeping_modified(&session, "notes/plan.md", "# Stale").is_err());
        assert_eq!(fs::read_to_string(&plan).unwrap(), "# Plan");
        assert!(write_keeping_modified(&session, "notes/new.md", "").is_err());
        assert!(!session.root.join("notes/new.md").exists());
    }
}

#[cfg(all(test, unix))]
mod local_only_command_tests {
    //! Command-tier pins: every command takes the open graph's local-only
    //! configuration from `GraphState` and refuses, or flags, through it.
    //! Each refusal has a control run without the configuration.
    use super::*;
    use std::os::unix::fs::symlink;
    use tauri::Manager;

    struct Session {
        app: tauri::App<tauri::test::MockRuntime>,
        _dir: tempfile::TempDir,
        root: PathBuf,
        raw: PathBuf,
    }

    const FOLDED: &str = "people/\u{17f}ecure/visa.md";

    /// A graph with a real local-only folder (`people/secure`), a linked one
    /// (`finance/secure` into a raw store), and ordinary files beside them.
    fn session(configured: bool) -> Session {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        app.manage(assets::AssetUploads::default());
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (root, raw) = (base.join("graph"), base.join("raw"));
        io::bootstrap(&root).unwrap();
        let files = [
            (root.join("people/secure/visa.md"), "# Visa"),
            (root.join("people/secure/scan.png"), "png"),
            (root.join("people/plan.md"), "# Plan"),
            (root.join("people/photo.png"), "png"),
            (raw.join("finance/secure/bank.md"), "# Bank"),
            (raw.join("finance/secure/statement.png"), "png"),
        ];
        for (path, contents) in files {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        fs::create_dir_all(root.join("finance")).unwrap();
        symlink(raw.join("finance/secure"), root.join("finance/secure")).unwrap();
        {
            let state: State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(root.clone());
            inner.set_local_only(
                configured.then(|| LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap()),
            );
        }
        Session {
            app,
            _dir: dir,
            root,
            raw,
        }
    }

    /// [`session`] with `secure` editable.
    fn editable_session() -> Session {
        let session = session(true);
        let (folders, _) = LocalOnlyFolders::new(["secure"], Some(&session.raw))
            .unwrap()
            .with_editable(["secure"]);
        session
            .app
            .state::<GraphState>()
            .0
            .lock()
            .unwrap()
            .set_local_only(Some(folders));
        session
    }

    fn folds(session: &Session) -> bool {
        session.root.join(FOLDED).exists()
    }

    fn write_note(
        session: &Session,
        path: &str,
        contents: &str,
        check_contents: Option<bool>,
        expected: Option<&str>,
    ) -> AppResult<Option<u64>> {
        tauri::async_runtime::block_on(note_write(
            path.into(),
            contents.into(),
            1,
            check_contents,
            expected.map(str::to_string),
            session.app.state(),
        ))
    }

    fn create_note(session: &Session, path: &str, contents: &str) -> AppResult<NoteCreateOutcome> {
        tauri::async_runtime::block_on(note_create(
            path.into(),
            contents.into(),
            1,
            session.app.state(),
        ))
    }

    fn read(path: &Path) -> String {
        fs::read_to_string(path).unwrap()
    }

    /// Every file below `dir` with its bytes; links by their target.
    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut found = Vec::new();
        for entry in walkdir::WalkDir::new(dir).sort_by_file_name() {
            let entry = entry.unwrap();
            let bytes = if entry.path_is_symlink() {
                fs::read_link(entry.path())
                    .unwrap()
                    .into_os_string()
                    .into_encoded_bytes()
            } else if entry.file_type().is_file() {
                fs::read(entry.path()).unwrap()
            } else {
                Vec::new()
            };
            found.push((entry.path().to_path_buf(), bytes));
        }
        found
    }

    /// The names staged in the graph's `.reflect/trash/`, as
    /// `<slot>/<name>` (empty slots included as `<slot>/`).
    #[cfg(desktop)]
    fn trashed(session: &Session) -> Vec<String> {
        let trash = session.root.join(".reflect/trash");
        let Ok(slots) = fs::read_dir(&trash) else {
            return Vec::new();
        };
        let mut found = Vec::new();
        for slot in slots {
            let slot = slot.unwrap().file_name().to_string_lossy().into_owned();
            let names: Vec<String> = fs::read_dir(trash.join(&slot))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            if names.is_empty() {
                found.push(format!("{slot}/"));
            }
            found.extend(names.into_iter().map(|name| format!("{slot}/{name}")));
        }
        found
    }

    #[test]
    fn a_checked_write_to_an_editable_note_lands_in_the_raw_store() {
        let session = editable_session();
        let bank = session.raw.join("finance/secure/bank.md");
        let graph_before = snapshot(&session.root.join("notes"));

        let modified = write_note(
            &session,
            "finance/secure/bank.md",
            "# Bank\n\nedited",
            Some(true),
            Some("# Bank"),
        )
        .unwrap();
        assert_eq!(read(&bank), "# Bank\n\nedited");
        assert_eq!(modified, modified_ms(&fs::metadata(&bank).unwrap()));
        // A new note (and its folder) claims a free name.
        write_note(
            &session,
            "finance/secure/2026/plan.md",
            "# Plan",
            Some(true),
            None,
        )
        .unwrap();
        assert_eq!(
            read(&session.raw.join("finance/secure/2026/plan.md")),
            "# Plan"
        );
        // A real editable folder is written in place, in the graph.
        write_note(
            &session,
            "people/secure/visa.md",
            "# Visa\n\nrenewed",
            Some(true),
            Some("# Visa"),
        )
        .unwrap();
        assert_eq!(
            read(&session.root.join("people/secure/visa.md")),
            "# Visa\n\nrenewed"
        );
        // Nothing else in the graph changed, and nothing was left staged.
        assert_eq!(snapshot(&session.root.join("notes")), graph_before);
        assert_eq!(
            fs::read_dir(session.root.join(".reflect/tmp"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn editable_checked_writes_compare_the_revision_returned_by_note_read() {
        let session = editable_session();
        let path = "finance/secure/bank.md";
        let bank = session.raw.join(path);
        for (source, expected) in [
            ("# Bank\r\n\r\nBalance", "# Bank\n\nBalance"),
            (
                "---\r\nprivate: true\r\n---\r\nsecret",
                "---\nprivate: true\n---\nsecret",
            ),
            (
                "---\ntitle: x\rprivate: false\n---\nsecret",
                "---\ntitle: x\rprivate: false\n---\nsecret",
            ),
            (
                "---\ntitle: x\r---\rprivate: true\n---\nsecret",
                "---\ntitle: x\r---\rprivate: true\n---\nsecret",
            ),
        ] {
            fs::write(&bank, source).unwrap();
            let revision = tauri::async_runtime::block_on(note_read(
                path.into(),
                Some(1),
                session.app.state(),
            ))
            .unwrap();
            assert_eq!(revision, expected);
            write_note(&session, path, "# Edited", Some(true), Some(&revision)).unwrap();
            assert_eq!(read(&bank), "# Edited");
        }
    }

    #[test]
    fn a_normalized_local_only_revision_cannot_replace_new_disk_text() {
        let session = editable_session();
        let path = "finance/secure/bank.md";
        let bank = session.raw.join(path);
        fs::write(&bank, "# Bank\r\nBalance").unwrap();
        let revision =
            tauri::async_runtime::block_on(note_read(path.into(), Some(1), session.app.state()))
                .unwrap();
        fs::write(&bank, "# Bank\r\nNew balance").unwrap();
        let error = write_note(&session, path, "# Edited", Some(true), Some(&revision))
            .expect_err("a stale revision must be refused");
        assert!(format!("{error:?}").contains(CHANGED_ON_DISK));
        assert_eq!(read(&bank), "# Bank\r\nNew balance");

        let ambiguous = "---\ntitle: x\rprivate: false\n---\nsecret";
        fs::write(&bank, ambiguous).unwrap();
        let normalized = reflect_graph_paths::normalize_line_endings(ambiguous.into());
        let error = write_note(&session, path, "# Edited", Some(true), Some(&normalized))
            .expect_err("a privacy-changing normalization is not the read revision");
        assert!(format!("{error:?}").contains(CHANGED_ON_DISK));
        assert_eq!(read(&bank), ambiguous);
    }

    #[test]
    fn an_editable_note_is_written_only_over_the_revision_it_names() {
        let session = editable_session();
        let bank = session.raw.join("finance/secure/bank.md");
        let refused = |check: Option<bool>, expected: Option<&str>| {
            write_note(
                &session,
                "finance/secure/bank.md",
                "# Ours",
                check,
                expected,
            )
            .expect_err("refused")
        };
        // Unchecked, whatever it names.
        for check in [None, Some(false)] {
            assert!(matches!(
                refused(check, Some("# Bank")),
                AppError::Parse { .. }
            ));
        }
        // A missing revision over an existing file, and a stale one.
        for expected in [None, Some("# Stale")] {
            let message = format!("{:?}", refused(Some(true), expected));
            assert!(message.contains(CHANGED_ON_DISK), "{message}");
        }
        assert_eq!(read(&bank), "# Bank");
        // A revision for a note that is gone.
        let message = format!(
            "{:?}",
            write_note(
                &session,
                "finance/secure/gone.md",
                "# Ours",
                Some(true),
                Some("# Gone")
            )
            .unwrap_err()
        );
        assert!(message.contains(CHANGED_ON_DISK), "{message}");
        assert!(!session.raw.join("finance/secure/gone.md").exists());
        // An iCloud placeholder holds its note's name.
        fs::write(
            session.raw.join("finance/secure/.evicted.md.icloud"),
            "stub",
        )
        .unwrap();
        assert!(write_note(
            &session,
            "finance/secure/evicted.md",
            "# Ours",
            Some(true),
            None
        )
        .is_err());
        assert!(!session.raw.join("finance/secure/evicted.md").exists());
    }

    #[test]
    fn a_create_in_an_editable_folder_never_replaces_a_note() {
        let session = editable_session();
        let create = |path: &str| create_note(&session, path, "# New").unwrap();

        assert!(matches!(
            create("finance/secure/bank.md"),
            NoteCreateOutcome::Collision
        ));
        assert_eq!(read(&session.raw.join("finance/secure/bank.md")), "# Bank");
        assert!(matches!(
            create("finance/secure/new.md"),
            NoteCreateOutcome::Created { .. }
        ));
        assert_eq!(read(&session.raw.join("finance/secure/new.md")), "# New");
        assert!(create_note(&session, "finance/secure/new.txt", "x").is_err());
    }

    #[cfg(desktop)]
    #[test]
    fn a_delete_in_an_editable_folder_stages_the_note_before_the_system_trash() {
        let session = editable_session();
        let state = || session.app.state::<GraphState>();
        fs::write(session.raw.join("finance/secure/old.md"), "# Old").unwrap();

        // The system Trash refuses: the note stays in the graph's trash.
        let refusing = os_trash_seam::install(|_| Err(AppError::io("Trash refused")));
        let outcome = tauri::async_runtime::block_on(note_delete(
            "finance/secure/bank.md".into(),
            1,
            state(),
        ))
        .unwrap();
        assert_eq!(outcome.trashed, Trashed::Graph);
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            serde_json::json!({ "trashed": "graph" })
        );
        assert!(!session.raw.join("finance/secure/bank.md").exists());
        let staged = trashed(&session);
        assert_eq!(staged.len(), 1, "{staged:?}");
        let (slot, name) = staged[0].split_once('/').unwrap();
        assert_eq!((slot.len(), name), (32, "bank.md"));
        assert_eq!(
            read(&session.root.join(".reflect/trash").join(&staged[0])),
            "# Bank"
        );
        assert_eq!(
            os_trash_seam::calls(),
            [session.root.join(".reflect/trash").join(&staged[0])]
        );
        drop(refusing);

        // The system Trash takes it: the staged copy leaves the graph.
        let _accepting = os_trash_seam::install(|path| Ok(fs::remove_file(path)?));
        let outcome =
            tauri::async_runtime::block_on(note_delete("finance/secure/old.md".into(), 1, state()))
                .unwrap();
        assert_eq!(outcome.trashed, Trashed::System);
        assert!(!session.raw.join("finance/secure/old.md").exists());
        let called = os_trash_seam::calls();
        assert_eq!(called.len(), 1);
        assert!(called[0].starts_with(session.root.join(".reflect/trash")));
        assert!(called[0].ends_with("old.md"));
    }

    #[cfg(desktop)]
    #[test]
    fn a_delete_from_another_volume_stages_beside_the_note_and_drops_its_recovery() {
        let session = editable_session();
        let state = || session.app.state::<GraphState>();
        let delete =
            |path: &str| tauri::async_runtime::block_on(note_delete(path.into(), 1, state()));
        let keep = |path: &str| {
            tauri::async_runtime::block_on(recovery::note_recovery_write(
                path.into(),
                "unsaved".into(),
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
                None,
                1,
                state(),
            ))
            .unwrap();
        };
        let kept = |path: &str| {
            tauri::async_runtime::block_on(recovery::note_recovery_read(path.into(), 1, state()))
                .unwrap()
        };
        let folder = session.raw.join("finance/secure");
        let _elsewhere = beneath::PretendTrashElsewhere::engage();
        keep("finance/secure/bank.md");

        // Refused: the note goes back under its name, its text stays kept,
        // and nothing is left staged anywhere.
        let refusing = os_trash_seam::install(|_| Err(AppError::io("Trash refused")));
        assert!(delete("finance/secure/bank.md").is_err());
        let called = os_trash_seam::calls();
        assert_eq!(called.len(), 1);
        assert_eq!(called[0].parent().unwrap().parent().unwrap(), folder);
        assert_eq!(read(&folder.join("bank.md")), "# Bank");
        assert!(kept("finance/secure/bank.md").is_some());
        drop(refusing);

        let _accepting = os_trash_seam::install(|path| Ok(fs::remove_file(path)?));
        let outcome = delete("finance/secure/bank.md").unwrap();
        assert_eq!(outcome.trashed, Trashed::System);
        assert!(!folder.join("bank.md").exists());
        assert_eq!(kept("finance/secure/bank.md"), None);
        assert_eq!(trashed(&session), Vec::<String>::new());
        let hidden: Vec<_> = fs::read_dir(&folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .filter(|name| name.to_string_lossy().starts_with('.'))
            .collect();
        assert!(hidden.is_empty(), "{hidden:?}");
    }

    #[test]
    fn a_moved_editable_note_carries_its_kept_text() {
        let session = editable_session();
        let state = || session.app.state::<GraphState>();
        let (from, to) = ("finance/secure/bank.md", "finance/secure/2026/bank.md");
        tauri::async_runtime::block_on(recovery::note_recovery_write(
            from.into(),
            "unsaved".into(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            None,
            1,
            state(),
        ))
        .unwrap();
        move_note_file(
            &note_write_guard(),
            &session.root,
            from,
            to,
            Some(&editable_folders(&session)),
        )
        .unwrap();
        let read = |path: &str| {
            tauri::async_runtime::block_on(recovery::note_recovery_read(path.into(), 1, state()))
                .unwrap()
        };
        assert_eq!(read(from), None);
        let carried = read(to).expect("carried");
        assert_eq!(
            (carried.contents.as_str(), carried.source_revision),
            ("unsaved", None)
        );
    }

    #[cfg(desktop)]
    #[test]
    fn a_symlinked_or_dataless_note_is_never_deleted_or_moved() {
        let session = editable_session();
        let state = || session.app.state::<GraphState>();
        let _trash = os_trash_seam::install(|_| Ok(()));
        symlink(
            session.root.join("people/plan.md"),
            session.raw.join("finance/secure/link.md"),
        )
        .unwrap();
        assert!(tauri::async_runtime::block_on(note_delete(
            "finance/secure/link.md".into(),
            1,
            state()
        ))
        .is_err());
        assert!(fs::symlink_metadata(session.raw.join("finance/secure/link.md")).is_ok());

        let dataless = beneath::PretendDataless::engage();
        assert!(tauri::async_runtime::block_on(note_delete(
            "finance/secure/bank.md".into(),
            1,
            state()
        ))
        .is_err());
        assert!(move_note_file(
            &note_write_guard(),
            &session.root,
            "finance/secure/bank.md",
            "finance/secure/moved.md",
            Some(&editable_folders(&session)),
        )
        .is_err());
        drop(dataless);
        assert_eq!(read(&session.raw.join("finance/secure/bank.md")), "# Bank");
        assert!(os_trash_seam::calls().is_empty());
        assert_eq!(trashed(&session), Vec::<String>::new());
    }

    fn editable_folders(session: &Session) -> LocalOnlyFolders {
        LocalOnlyFolders::new(["secure"], Some(&session.raw))
            .unwrap()
            .with_editable(["secure"])
            .0
    }

    #[test]
    fn a_move_stays_inside_editable_folders() {
        let session = editable_session();
        let folders = editable_folders(&session);
        move_note_file(
            &note_write_guard(),
            &session.root,
            "finance/secure/bank.md",
            "finance/secure/2026/bank.md",
            Some(&folders),
        )
        .unwrap();
        assert_eq!(
            read(&session.raw.join("finance/secure/2026/bank.md")),
            "# Bank"
        );
        assert!(!session.raw.join("finance/secure/bank.md").exists());
        // Between two editable folders, a link and a real directory.
        move_note_file(
            &note_write_guard(),
            &session.root,
            "finance/secure/2026/bank.md",
            "people/secure/bank.md",
            Some(&folders),
        )
        .unwrap();
        assert_eq!(read(&session.root.join("people/secure/bank.md")), "# Bank");
        // An occupied destination refuses, both files intact.
        let occupied = move_note_file(
            &note_write_guard(),
            &session.root,
            "people/secure/bank.md",
            "people/secure/visa.md",
            Some(&folders),
        );
        assert!(occupied.is_err());
        assert_eq!(read(&session.root.join("people/secure/visa.md")), "# Visa");

        // Crossing the boundary either way refuses before anything moves.
        for (from, to) in [
            ("people/plan.md", "finance/secure/plan.md"),
            ("people/secure/bank.md", "people/bank.md"),
        ] {
            let message = format!(
                "{:?}",
                move_note_file(&note_write_guard(), &session.root, from, to, Some(&folders))
                    .unwrap_err()
            );
            assert!(
                message.contains("crosses a local-only boundary"),
                "{message}"
            );
        }
        assert!(session.root.join("people/plan.md").exists());
        assert!(session.root.join("people/secure/bank.md").exists());
        assert!(!session.raw.join("finance/secure/plan.md").exists());
        assert!(!session.root.join("people/bank.md").exists());
    }

    /// The default contract: without `editable`, a local-only folder takes
    /// no write, create, delete, move, or attachment.
    #[cfg(desktop)]
    #[test]
    fn a_read_only_folder_still_refuses_every_edit() {
        let session = session(true);
        let state = || session.app.state::<GraphState>();
        let _trash = os_trash_seam::install(|_| Ok(()));
        let raw_before = snapshot(&session.raw);
        let graph_before = snapshot(&session.root);
        let folders = LocalOnlyFolders::new(["secure"], Some(&session.raw)).unwrap();

        for (path, expected) in [
            ("finance/secure/bank.md", Some("# Bank")),
            ("finance/secure/new.md", None),
            ("people/secure/visa.md", Some("# Visa")),
        ] {
            assert!(
                write_note(&session, path, "# Ours", Some(true), expected).is_err(),
                "{path}"
            );
        }
        assert!(create_note(&session, "finance/secure/new.md", "x").is_err());
        assert!(tauri::async_runtime::block_on(note_delete(
            "finance/secure/bank.md".into(),
            1,
            state()
        ))
        .is_err());
        assert!(tauri::async_runtime::block_on(note_delete(
            "people/secure/visa.md".into(),
            1,
            state()
        ))
        .is_err());
        assert!(move_note_file(
            &note_write_guard(),
            &session.root,
            "finance/secure/bank.md",
            "finance/secure/moved.md",
            Some(&folders),
        )
        .is_err());
        let source = session.root.join("people/photo.png");
        assert!(assets::asset_import(
            source.to_string_lossy().into_owned(),
            "pic.png".into(),
            "finance/secure/bank.md".into(),
            1,
            state(),
        )
        .is_err());

        assert_eq!(snapshot(&session.raw), raw_before);
        assert_eq!(snapshot(&session.root), graph_before);
        assert!(os_trash_seam::calls().is_empty());
    }

    fn upload(session: &Session, bytes: &[u8], name: &str, note: &str) -> AppResult<String> {
        let id = assets::asset_upload_begin(1, session.app.state(), session.app.state()).unwrap();
        assets::append_chunk(&session.app.state::<assets::AssetUploads>(), &id, bytes).unwrap();
        tauri::async_runtime::block_on(assets::asset_upload_commit(
            id,
            name.into(),
            note.into(),
            1,
            session.app.state(),
            session.app.state(),
        ))
    }

    fn import(session: &Session, source: &Path, name: &str, note: &str) -> AppResult<String> {
        assets::asset_import(
            source.to_string_lossy().into_owned(),
            name.into(),
            note.into(),
            1,
            session.app.state(),
        )
    }

    fn staging_is_empty(session: &Session) -> bool {
        fs::read_dir(session.root.join(".reflect/tmp"))
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(true)
    }

    #[test]
    fn an_editable_notes_attachments_stay_in_its_folder() {
        let session = editable_session();
        let assets_before = snapshot(&session.root.join("assets"));
        let source = session.root.join("people/photo.png");

        assert_eq!(
            upload(&session, b"scan", "scan.png", "finance/secure/bank.md").unwrap(),
            "finance/secure/assets/scan.png"
        );
        assert_eq!(
            import(&session, &source, "scan.png", "finance/secure/sub/deep.md").unwrap(),
            "finance/secure/assets/scan-2.png"
        );
        assert_eq!(
            fs::read(session.raw.join("finance/secure/assets/scan.png")).unwrap(),
            b"scan"
        );
        assert_eq!(
            fs::read(session.raw.join("finance/secure/assets/scan-2.png")).unwrap(),
            b"png"
        );
        // A real editable folder keeps them in its own `assets/` too.
        assert_eq!(
            upload(&session, b"id", "id.png", "people/secure/visa.md").unwrap(),
            "people/secure/assets/id.png"
        );
        assert!(session.root.join("people/secure/assets/id.png").is_file());

        assert_eq!(snapshot(&session.root.join("assets")), assets_before);
        assert!(staging_is_empty(&session));

        // Control: an ordinary note's attachments go to `assets/` as before.
        assert_eq!(
            upload(&session, b"chart", "chart.png", "people/plan.md").unwrap(),
            "assets/chart.png"
        );
        assert_eq!(
            fs::read(session.root.join("assets/chart.png")).unwrap(),
            b"chart"
        );
    }

    #[test]
    fn attachments_refuse_hidden_names_and_a_planted_assets_link() {
        let editable = editable_session();
        let source = editable.root.join("people/photo.png");

        // A hidden name, and a path-shaped one.
        for name in [".scan.png", "sub/scan.png"] {
            assert!(upload(&editable, b"x", name, "finance/secure/bank.md").is_err());
            assert!(import(&editable, &source, name, "finance/secure/bank.md").is_err());
        }
        // `<folder>/assets` planted as a link into `notes/`.
        let notes_before = snapshot(&editable.root.join("notes"));
        symlink(
            editable.root.join("notes"),
            editable.raw.join("finance/secure/assets"),
        )
        .unwrap();
        assert!(upload(&editable, b"x", "scan.png", "finance/secure/bank.md").is_err());
        assert!(import(&editable, &source, "scan.png", "finance/secure/bank.md").is_err());
        assert_eq!(snapshot(&editable.root.join("notes")), notes_before);
        assert!(staging_is_empty(&editable));
    }

    #[test]
    fn a_note_in_a_read_only_folder_takes_no_attachment() {
        let read_only = session(true);
        let source = read_only.root.join("people/photo.png");
        let raw_before = snapshot(&read_only.raw);
        let assets_before = snapshot(&read_only.root.join("assets"));
        assert!(upload(&read_only, b"x", "scan.png", "finance/secure/bank.md").is_err());
        assert!(import(&read_only, &source, "scan.png", "people/secure/visa.md").is_err());
        assert_eq!(snapshot(&read_only.raw), raw_before);
        assert_eq!(snapshot(&read_only.root.join("assets")), assets_before);
        assert!(staging_is_empty(&read_only));
    }

    fn shareable(session: &Session, path: &str) -> ShareableNoteRead {
        tauri::async_runtime::block_on(note_read_shareable(
            path.to_string(),
            None,
            session.app.state(),
        ))
        .unwrap_or_else(|err| panic!("{path}: {err:?}"))
    }

    #[test]
    fn shareable_reads_refuse_local_only_notes_however_spelled() {
        let session = session(true);
        symlink(
            session.root.join("people/secure"),
            session.root.join("notes/alias"),
        )
        .unwrap();
        let mut refused = vec![
            "finance/secure/bank.md",
            "people/secure/visa.md",
            "people/SECURE/visa.md",
            "notes/alias/visa.md",
        ];
        if folds(&session) {
            refused.push(FOLDED);
        }
        for path in refused {
            assert!(
                matches!(shareable(&session, path), ShareableNoteRead::LocalOnly),
                "{path}"
            );
        }
        assert!(matches!(
            shareable(&session, "people/plan.md"),
            ShareableNoteRead::Content { content } if content == "# Plan"
        ));
        // The UI read of the same note is allowed: only sharing refuses.
        let read = tauri::async_runtime::block_on(note_read(
            "finance/secure/bank.md".to_string(),
            None,
            session.app.state(),
        ));
        assert_eq!(read.unwrap(), "# Bank");
    }

    #[test]
    fn without_the_configuration_a_real_folder_is_ordinary() {
        let session = session(false);
        assert!(matches!(
            shareable(&session, "people/secure/visa.md"),
            ShareableNoteRead::Content { .. }
        ));
    }

    #[test]
    fn local_reads_report_the_resolved_local_only_status() {
        let session = session(true);
        let local = |path: &str| match tauri::async_runtime::block_on(note_read_local(
            path.to_string(),
            None,
            session.app.state(),
        )) {
            Ok(LocalNoteRead::Content { local_only, .. }) => local_only,
            other => panic!("{path}: {other:?}"),
        };
        assert!(local("finance/secure/bank.md"));
        assert!(local("people/secure/visa.md"));
        assert!(!local("people/plan.md"));
        if folds(&session) {
            assert!(local(FOLDED));
        }
    }

    #[test]
    fn asset_reads_bound_off_device_refuse_local_only_files() {
        let configured = session(true);
        for path in ["finance/secure/statement.png", "people/secure/scan.png"] {
            assert!(asset_read(path.to_string(), 1, configured.app.state()).is_err());
            assert!(asset_read_binary(path.to_string(), 1, configured.app.state()).is_err());
        }
        assert!(asset_read("people/photo.png".to_string(), 1, configured.app.state()).is_ok());
        // Control: unconfigured, the real folder is ordinary, and the link is
        // still refused by the plain escape guard.
        let plain = session(false);
        assert!(asset_read("people/secure/scan.png".to_string(), 1, plain.app.state()).is_ok());
        assert!(asset_read(
            "finance/secure/statement.png".to_string(),
            1,
            plain.app.state()
        )
        .is_err());
    }

    #[test]
    fn writes_through_an_alias_or_folded_spelling_are_refused() {
        let session = session(true);
        let state = || session.app.state::<GraphState>();
        if folds(&session) {
            let created = "people/\u{17f}ecure/new.md".to_string();
            // Checked against the file's real bytes, so only the path refuses.
            let visa = Some("# Visa".to_string());
            assert!(tauri::async_runtime::block_on(note_write(
                FOLDED.to_string(),
                "x".into(),
                1,
                Some(true),
                visa,
                state()
            ))
            .is_err());
            assert!(
                tauri::async_runtime::block_on(note_create(created, "x".into(), 1, state()))
                    .is_err()
            );
            assert!(
                tauri::async_runtime::block_on(note_delete(FOLDED.to_string(), 1, state()))
                    .is_err()
            );
            let folders = LocalOnlyFolders::new(["secure"], None);
            assert!(move_note_file(
                &note_write_guard(),
                &session.root,
                "people/plan.md",
                "people/\u{17f}ecure/plan.md",
                folders.as_ref(),
            )
            .is_err());
            assert!(move_note_file(
                &note_write_guard(),
                &session.root,
                FOLDED,
                "people/visa.md",
                folders.as_ref()
            )
            .is_err());
        }
        assert_eq!(
            fs::read_to_string(session.root.join("people/secure/visa.md")).unwrap(),
            "# Visa"
        );
        assert!(session.root.join("people/plan.md").exists());
    }

    /// With the configuration unknown, nothing leaves the device: shareable
    /// note reads and asset reads refuse, even for an ordinary note; the
    /// control session with the configuration known serves them.
    #[test]
    fn sharing_pauses_while_the_configuration_is_unknown() {
        for unknown in [true, false] {
            let session = session(true);
            if unknown {
                session
                    .app
                    .state::<GraphState>()
                    .0
                    .lock()
                    .unwrap()
                    .set_local_only_unknown();
            }
            let note = tauri::async_runtime::block_on(note_read_shareable(
                "people/plan.md".to_string(),
                None,
                session.app.state(),
            ));
            let asset = asset_read("people/photo.png".to_string(), 1, session.app.state());
            let binary = asset_read_binary("people/photo.png".to_string(), 1, session.app.state());
            if unknown {
                for message in [
                    format!("{:?}", note.expect_err("note")),
                    format!("{:?}", asset.expect_err("asset")),
                    format!("{:?}", binary.err().expect("binary")),
                ] {
                    assert!(message.contains("Sharing is paused"), "{message}");
                }
            } else {
                assert!(matches!(note.unwrap(), ShareableNoteRead::Content { .. }));
                assert!(asset.is_ok() && binary.is_ok());
            }
        }
    }

    /// Listing an `audio-memos/` linked into a real local-only folder shows
    /// nothing from it (not even an empty recording, which would otherwise
    /// become a note naming it), and no listing reaches into a local-only
    /// folder below it; the control session without folders lists them all.
    #[test]
    fn listings_never_reach_into_a_local_only_folder() {
        for configured in [true, false] {
            let session = session(configured);
            let secure = session.root.join("people/secure");
            fs::write(secure.join("memo.m4a"), "").unwrap();
            symlink(&secure, session.root.join("audio-memos")).unwrap();
            let listed = |dir: &str| -> Vec<String> {
                let mut paths: Vec<String> = dir_list(dir.into(), 1, session.app.state())
                    .unwrap()
                    .into_iter()
                    .map(|file| file.path)
                    .collect();
                paths.sort();
                paths
            };
            let (memos, people) = (listed("audio-memos"), listed("people"));
            if configured {
                assert!(memos.is_empty(), "{memos:?}");
                assert_eq!(people, ["people/photo.png", "people/plan.md"]);
            } else {
                assert!(memos.contains(&"audio-memos/memo.m4a".to_string()));
                assert!(people.contains(&"people/secure/visa.md".to_string()));
            }
        }
    }

    /// `audio-memos/`, `assets/`, and the transcript cache aliased into a real
    /// local-only folder: each command refuses configured and works without.
    #[test]
    fn fixed_write_targets_aliased_into_a_local_only_folder_are_refused() {
        for configured in [true, false] {
            let session = session(configured);
            let secure = session.root.join("people/secure");
            fs::write(secure.join("memo.m4a"), "audio").unwrap();
            symlink(&secure, session.root.join("audio-memos")).unwrap();
            symlink(&secure, session.root.join(".reflect/transcripts")).unwrap();
            fs::remove_dir_all(session.root.join("assets")).unwrap();
            symlink(&secure, session.root.join("assets")).unwrap();
            let source = session.root.join("people/photo.png");
            let state = || session.app.state::<GraphState>();

            let deleted = audio_memo_delete("audio-memos/memo.m4a".into(), 1, state());
            let cached = transcript_cache_write("memo.json".into(), "{}".into(), 1, state());
            let imported = assets::asset_import(
                source.to_string_lossy().into_owned(),
                "pic.png".into(),
                "people/plan.md".into(),
                1,
                state(),
            );
            if configured {
                assert!(deleted.is_err() && cached.is_err() && imported.is_err());
                assert!(secure.join("memo.m4a").exists());
                assert!(!secure.join("memo.json").exists());
                assert!(!secure.join("pic.png").exists());
            } else {
                assert!(deleted.is_ok() && cached.is_ok() && imported.is_ok());
                assert!(!secure.join("memo.m4a").exists());
            }
        }
    }
}

#[cfg(test)]
mod note_read_shareable_tests {
    //! The shareable read serves visible Markdown only. Every path below
    //! exists on disk, so a refusal is the path policy, never a missing file.
    use super::*;
    use tauri::Manager;

    type MockApp = tauri::App<tauri::test::MockRuntime>;

    fn open_graph() -> (MockApp, tempfile::TempDir) {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(GraphState::default());
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        io::bootstrap(&root).unwrap();
        for (path, contents) in [
            (".git/config", "[remote \"origin\"]"),
            (".reflect/x.md", "# Runtime"),
            ("notes/a.txt", "plain text"),
            ("notes/a.md", "# A"),
            ("assets/a.png.reflect.md", "A chart."),
        ] {
            let path = root.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        {
            let state: State<GraphState> = app.state();
            let mut inner = state.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(root);
        }
        (app, dir)
    }

    fn read(app: &MockApp, path: &str) -> AppResult<ShareableNoteRead> {
        tauri::async_runtime::block_on(note_read_shareable(path.to_string(), None, app.state()))
    }

    #[test]
    fn refuses_hidden_and_non_markdown_paths() {
        let (app, _dir) = open_graph();
        for path in [".git/config", ".reflect/x.md", "notes/a.txt"] {
            let refused = read(&app, path);
            assert!(
                matches!(refused, Err(AppError::Traversal { .. })),
                "{path}: {refused:?}"
            );
        }
    }

    #[test]
    fn still_reads_notes_and_asset_sidecars() {
        let (app, _dir) = open_graph();
        for (path, expected) in [
            ("notes/a.md", "# A"),
            ("assets/a.png.reflect.md", "A chart."),
        ] {
            let served = read(&app, path);
            assert!(
                matches!(&served, Ok(ShareableNoteRead::Content { content }) if content == expected),
                "{path}: {served:?}"
            );
        }
    }
}
