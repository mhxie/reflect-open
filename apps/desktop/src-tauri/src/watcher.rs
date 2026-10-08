//! Filesystem watcher for the open graph (Plan 04b).
//!
//! A debounced `notify` watcher over the graph root. It's the **sole** trigger
//! for incremental re-indexing: an edit (ours or external) writes the markdown
//! file, the watcher fires, and the frontend re-indexes that file. The index
//! lives under `.reflect/`, which is filtered out here, so index writes can't
//! loop back. The watcher reports eligible markdown notes and supported
//! attachments anywhere in the vault (the shared `reflect-graph-paths`
//! policy), plus anything under `audio-memos/` (recordings feed the sync
//! debounce and the transcription reconciler, not the index) and capture
//! envelopes under `.reflect/inbox/`. Non-note consumers filter by path. The
//! frontend resolves create-vs-delete and re-indexes (content-hash gated).
//!
//! Directory-level changes are deliberately **not** diffed here: no platform
//! enumerates the descendants of a renamed or removed folder, so the watcher
//! only reports "something structural changed" (`index:reconcile`) and the
//! frontend answers with its ordinary full reconcile pass — re-list, hash
//! gate, prune. One coarse signal instead of a shadow manifest.
//!
//! A graph's local-only folders live outside its root (symlinks into a raw
//! store), where a watch on the root never sees them. Their targets get
//! best-effort watches of their own, discovered off the main thread after
//! the graph watch is installed; events under a target are translated back
//! to the link's graph path before the ordinary filtering. A missing or
//! dangling target only loses its own watch. An event on a link itself (or
//! on a target's root) triggers a reconcile plus a re-discovery, and so does
//! any structural change (a renamed folder can carry a link with it).
//! Re-discoveries run one at a time per watch, the last one always after
//! the last request, and they hold only their own watch's lock, never the
//! one `watch_start` and `watch_stop` take: watching a target walks it.
//! Evicted (dataless) raw-store files are skipped like any other — a raw
//! store must be kept available offline.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};
use std::time::Duration;

use file_id::{get_file_id, FileId};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer_opt, DebounceEventResult, Debouncer, FileIdCache};
use reflect_graph_paths::{
    classify, evicted_logical_path, eviction_placeholder, has_pruned_component, is_pruned_dir_name,
    to_slash_lossy, wire_path, GraphPathKind, LocalOnlyFolders, LocalOnlyLink,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use walkdir::WalkDir;

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

/// The Tauri event name carrying batched {@link FileChange}s to the frontend.
const CHANGE_EVENT: &str = "index:changed";

/// The coarse dirty signal: a visible directory was created, renamed, or
/// removed (or the platform demanded a rescan), and its descendants were
/// never enumerated per file. Carries no payload — the frontend answers with
/// one full reconcile pass.
pub(crate) const RECONCILE_EVENT: &str = "index:reconcile";

/// Holds the active watch; dropping it stops the background watch thread.
#[derive(Default)]
pub struct WatcherState(Mutex<Option<ActiveWatch>>);

/// One installed watch over a graph.
struct ActiveWatch {
    /// The debouncer with its link-target watches, behind a lock of its own:
    /// a link refresh watching a large target never holds [`WatcherState`].
    watch: Arc<Mutex<LinkedWatch>>,
    /// Identifies this watch, so a link refresh begun for it can never touch
    /// a successor installed for another graph (or a restart).
    session: u64,
    root: PathBuf,
    local_only: Option<Arc<LocalOnlyFolders>>,
    /// Cleared once this watch is replaced or stopped: a debouncer an
    /// in-flight refresh still holds must emit nothing more.
    live: Arc<AtomicBool>,
}

impl Drop for ActiveWatch {
    fn drop(&mut self) {
        self.live.store(false, Ordering::SeqCst);
    }
}

/// The debouncer plus the local-only link targets it also watches.
struct LinkedWatch {
    debouncer: Debouncer<RecommendedWatcher, PrunedFileIdMap>,
    /// The links whose targets are watched, shared with the event handler,
    /// which translates raw-store paths back to graph paths through them.
    links: Arc<RwLock<Vec<LocalOnlyLink>>>,
    /// The watched targets, shared with the file-ID cache so it prunes below
    /// each exactly as below the graph root.
    extra_roots: Arc<RwLock<Vec<PathBuf>>>,
}

/// Session ids for [`ActiveWatch::session`].
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

/// One running link refresh per watch, and always one more after the last
/// request: concurrent refreshes could otherwise finish out of order and
/// leave an older discovery's links in place.
#[derive(Default)]
struct RefreshGate {
    running: AtomicBool,
    requested: AtomicBool,
}

impl LinkedWatch {
    /// Watch exactly the targets of `discovered`: unwatch the ones gone,
    /// watch the new ones. Best-effort per target — a failure is logged and
    /// leaves that target unwatched, never the graph watch.
    fn apply_links(&mut self, discovered: Vec<LocalOnlyLink>) {
        let current: BTreeSet<PathBuf> = read_lock(&self.links)
            .iter()
            .map(|link| link.target.clone())
            .collect();
        let wanted: BTreeSet<PathBuf> = discovered.iter().map(|link| link.target.clone()).collect();
        for target in current.difference(&wanted) {
            if let Err(err) = self.debouncer.unwatch(target) {
                tracing::debug!(?err, "could not unwatch a local-only target");
            }
            write_lock(&self.extra_roots).retain(|root| root != target);
        }
        let mut failed = BTreeSet::new();
        for target in wanted.difference(&current) {
            // Registered before the watch so the cache walk it triggers is
            // already pruned below the target.
            write_lock(&self.extra_roots).push(target.clone());
            if let Err(err) = self.debouncer.watch(target, RecursiveMode::Recursive) {
                tracing::warn!(?err, "could not watch a local-only folder's target");
                write_lock(&self.extra_roots).retain(|root| root != target);
                failed.insert(target.clone());
            }
        }
        *write_lock(&self.links) = discovered
            .into_iter()
            .filter(|link| !failed.contains(&link.target))
            .collect();
    }
}

fn read_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(PoisonError::into_inner)
}

fn write_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(PoisonError::into_inner)
}

/// The debouncer's file-ID cache, pruned to the trees that can carry tracked
/// files.
///
/// The platform-recommended `FileIdMap` stats **every path under the graph
/// root** — including `.git/objects/**` (which local history grows on every
/// edit session) and `.reflect/` — at every `watch_start` and again on every
/// FSEvents rescan: a multi-second launch burn on mature graphs. But the
/// cache cannot simply be dropped (`NoCache`): FSEvents carries no rename
/// cookies, so file IDs are the only thing stitching an external
/// `old.md → new.md` into one event. Unstitched, the From/To halves sit in
/// independent debounce queues and can flush in different batches — and the
/// frontend's move healing pairs remove+upsert **within one batch** only, so
/// a split rename degrades to delete+create: open sessions and routes miss
/// the move and derived state is rebuilt instead of carried.
///
/// So: same cache contract, pruned walk. Below the watch root, hidden names
/// (`.git`, `.reflect`, `.DS_Store` — the same blackout `collect_changes`
/// applies to events) and the shared prune list (`node_modules` and friends)
/// never enter the cache, at install time or from later create events.
/// Rename stitching only matters for paths the watcher tracks, and those are
/// exactly the paths the pruned walk retains — visible temp names included,
/// so an external editor's atomic `note.md.tmp → note.md` save still
/// stitches. Components *above* the root don't count: a graph legitimately
/// lives under a hidden directory like `~/.config`.
#[derive(Debug)]
pub struct PrunedFileIdMap {
    root: PathBuf,
    /// Further watched trees (local-only link targets), screened the same
    /// way below their own roots.
    extra_roots: Arc<RwLock<Vec<PathBuf>>>,
    paths: HashMap<PathBuf, FileId>,
}

impl PrunedFileIdMap {
    #[cfg(test)]
    fn new(root: PathBuf) -> Self {
        Self::with_extra_roots(root, Arc::default())
    }

    fn with_extra_roots(root: PathBuf, extra_roots: Arc<RwLock<Vec<PathBuf>>>) -> Self {
        Self {
            root,
            extra_roots,
            paths: HashMap::new(),
        }
    }
}

/// Whether `path` may enter the cache: every component below `root` must be
/// visible and off the prune list. Paths outside the root pass — the cache
/// has no opinion on other watch targets.
fn cache_keeps(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return true;
    };
    rel.components().all(|component| {
        let name = component.as_os_str().to_string_lossy();
        !name.starts_with('.') && !is_pruned_dir_name(&name)
    })
}

impl FileIdCache for PrunedFileIdMap {
    fn cached_file_id(&self, path: &Path) -> Option<impl AsRef<FileId>> {
        self.paths.get(path)
    }

    fn add_path(&mut self, path: &Path, recursive_mode: RecursiveMode) {
        let depth = if recursive_mode == RecursiveMode::Recursive {
            usize::MAX
        } else {
            1
        };
        let mut roots = vec![self.root.clone()];
        roots.extend(read_lock(&self.extra_roots).iter().cloned());
        let walk = WalkDir::new(path)
            .follow_links(false)
            .max_depth(depth)
            .into_iter()
            // `filter_entry` prunes whole subtrees: the walk never descends
            // into an excluded directory, which is the entire point.
            .filter_entry(move |entry| roots.iter().all(|root| cache_keeps(root, entry.path())));
        for entry in walk {
            let Ok(entry) = entry else { continue };
            let path = entry.into_path();
            let Ok(file_id) = get_file_id(&path) else {
                continue;
            };
            self.paths.insert(path, file_id);
        }
    }

    fn remove_path(&mut self, path: &Path) {
        self.paths.retain(|cached, _| !cached.starts_with(path));
    }
}

/// A debounced change to a tracked file, sent to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    /// `"upsert"` (created/modified) or `"remove"` (deleted).
    pub kind: String,
    /// Last-modified time in epoch milliseconds, set for upserts. The frontend
    /// stamps `notes.mtime` from this — without it, watcher-indexed rows would
    /// carry no real timestamp (and reconcile would never repair them, since it
    /// is content-hash gated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
}

/// What one debounced batch amounts to: precise per-file changes, and/or the
/// coarse signal that a full reconcile is needed.
#[derive(Debug, Default, PartialEq)]
struct BatchEffects {
    changes: Vec<FileChange>,
    reconcile: bool,
}

/// Graph-relative wire path if `path` is tracked: an eligible markdown note
/// or supported attachment anywhere visible (the shared classification), an
/// audio-memo recording (anything under `audio-memos/`), or a spooled capture
/// envelope (`.json` under `.reflect/inbox/` — the one carve-out from the
/// `.reflect/` blackout; the envelope is the spool's commit point and
/// triggers the capture drain), else `None`. Pure — the filtering rule,
/// unit-tested.
fn tracked_relpath(path: &Path, root: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel_str = to_slash_lossy(rel);
    if rel_str.starts_with(".reflect/inbox/") && rel_str.ends_with(".json") {
        return Some(rel_str);
    }
    // An iCloud eviction placeholder tracks as the file it stands in for —
    // eviction/re-download events must never read as a stub appearing or the
    // note being deleted (Plan 21).
    let logical = evicted_logical_path(rel);
    let rel = logical.as_deref().unwrap_or(rel);
    let wire = wire_path(rel)?;
    // The walk's lexical exclusions apply to live events too: a write under
    // `node_modules/` must not reach the index through the watcher when the
    // listing will never contain it.
    if has_pruned_component(&wire) {
        return None;
    }
    let kind = classify(&wire);
    let tracked = kind == Some(GraphPathKind::Note)
        || kind == Some(GraphPathKind::Attachment)
        || wire.starts_with("audio-memos/");
    tracked.then_some(wire)
}

/// Reduce a debounced batch of paths to unique tracked changes (last kind
/// wins) plus the coarse reconcile signal. Create/modify vs delete is decided
/// by whether the file currently stats; the same stat supplies the upsert's
/// `modified_ms`. A file that is gone but has an eviction placeholder in its
/// place was offloaded by iCloud, not deleted: no event — the index keeps its
/// last-known content until re-download.
///
/// An **untracked but visible** path flips `reconcile` when it is (or was) a
/// directory: a folder created, renamed, or removed can hold tracked
/// descendants the platform never enumerates. Hidden paths (`.reflect/`
/// index churn, `.git/`) can never flip it — that is what keeps the
/// reconcile pass's own index writes from looping back in here.
fn collect_changes(paths: &[PathBuf], root: &Path) -> BatchEffects {
    let mut seen: std::collections::BTreeMap<String, FileChange> =
        std::collections::BTreeMap::new();
    let mut reconcile = false;
    for path in paths {
        if let Some(rel) = tracked_relpath(path, root) {
            // Stat the *logical* path — for placeholder events it differs
            // from the event path, and it is what consumers read.
            let logical = root.join(&rel);
            let change = match std::fs::symlink_metadata(&logical) {
                // Discovery never lists symlinks; a tracked name replaced by
                // one must leave the index rather than be read through.
                Ok(meta) if meta.file_type().is_symlink() => FileChange {
                    path: rel.clone(),
                    kind: "remove".to_string(),
                    modified_ms: None,
                },
                // A directory took a tracked file's name: membership changed
                // in a way only a re-listing resolves.
                Ok(meta) if meta.is_dir() => {
                    reconcile = true;
                    continue;
                }
                // A dataless file (modern macOS eviction) stats fine but its
                // bytes are remote: emitting an upsert would send the live
                // pass into a blocking on-demand download. Same rule as the
                // stub form below — evicted, not deleted, no event; the
                // re-download (or a targeted request) emits the real upsert.
                Ok(meta) if crate::fs::is_dataless(&meta) => continue,
                Ok(meta) => FileChange {
                    path: rel.clone(),
                    kind: "upsert".to_string(),
                    modified_ms: crate::fs::modified_ms(&meta),
                },
                Err(_) => {
                    // `symlink_metadata` on the stub so a symlinked `.icloud`
                    // decoy cannot suppress a real removal.
                    let evicted = eviction_placeholder(&logical).is_some_and(|stub| {
                        std::fs::symlink_metadata(&stub)
                            .is_ok_and(|meta| meta.file_type().is_file())
                    });
                    if evicted {
                        continue; // evicted, not deleted
                    }
                    FileChange {
                        path: rel.clone(),
                        kind: "remove".to_string(),
                        modified_ms: None,
                    }
                }
            };
            seen.insert(rel, change);
        } else if let Ok(rel) = path.strip_prefix(root) {
            let visible = wire_path(rel).is_some_and(|wire| !has_pruned_component(&wire));
            if !visible {
                continue; // hidden, pruned, or unrepresentable — the blackout
            }
            match std::fs::symlink_metadata(path) {
                Ok(meta) if meta.is_dir() => reconcile = true,
                // Gone, and not a tracked file's removal: this may have been
                // a directory rename-away — only a re-listing can tell.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => reconcile = true,
                _ => {}
            }
        }
    }
    BatchEffects {
        changes: seen.into_values().collect(),
        reconcile,
    }
}

/// Event paths routed for [`collect_changes`]: graph paths as they are,
/// raw-store paths translated back under the link reaching them, plus
/// whether a local-only link itself — or a link target's root — changed.
#[derive(Debug, Default, PartialEq)]
struct RoutedPaths {
    paths: Vec<PathBuf>,
    links_changed: bool,
}

fn route_event_paths(
    paths: &[PathBuf],
    root: &Path,
    links: &[LocalOnlyLink],
    local_only: Option<&LocalOnlyFolders>,
) -> RoutedPaths {
    let mut routed = RoutedPaths::default();
    for path in paths {
        if path.starts_with(root) {
            routed.links_changed |= local_only.is_some_and(|folders| is_link_event(path, folders));
            routed.paths.push(path.clone());
            continue;
        }
        for link in links {
            let Ok(rest) = path.strip_prefix(&link.target) else {
                continue;
            };
            if rest.as_os_str().is_empty() {
                // The target itself appeared, vanished, or moved.
                routed.links_changed = true;
            } else {
                routed.paths.push(root.join(&link.path).join(rest));
            }
        }
    }
    routed
}

/// Whether a graph event concerns a local-only link entry: the path carries
/// a configured folder name and is now a symlink, or is gone.
fn is_link_event(path: &Path, folders: &LocalOnlyFolders) -> bool {
    let named = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| folders.is_folder_name(name));
    named
        && match std::fs::symlink_metadata(path) {
            Ok(meta) => meta.file_type().is_symlink(),
            Err(err) => err.kind() == std::io::ErrorKind::NotFound,
        }
}

/// Ask for a re-discovery of the graph's local-only links, re-pointing the
/// target watches, off the calling thread: discovery is a graph walk. At
/// most one runs per watch; a request while one runs queues exactly one more
/// (so the last refresh always starts after the last request).
fn request_link_refresh(app: AppHandle, session: u64, gate: Arc<RefreshGate>) {
    run_coalesced(gate, move || refresh_link_watches_once(&app, session));
}

/// Run `work` on a background thread unless a run is already going, in
/// which case that run goes once more after its current pass.
fn run_coalesced(gate: Arc<RefreshGate>, work: impl Fn() + Send + 'static) {
    gate.requested.store(true, Ordering::SeqCst);
    if gate.running.swap(true, Ordering::SeqCst) {
        return; // the running thread sees the request and goes again
    }
    std::thread::spawn(move || loop {
        while gate.requested.swap(false, Ordering::SeqCst) {
            work();
        }
        gate.running.store(false, Ordering::SeqCst);
        // A request landing between the last check and the store above saw
        // the gate still running: take the gate back for it, unless another
        // thread already has.
        if !gate.requested.load(Ordering::SeqCst) || gate.running.swap(true, Ordering::SeqCst) {
            break;
        }
    });
}

/// Whether a batch calls for a link re-discovery: a link itself changed, or
/// (when links are followed) a folder that may carry one was created,
/// renamed, or removed — no event names the link inside a renamed folder.
fn needs_link_refresh(routed: &RoutedPaths, reconcile: bool, follows_links: bool) -> bool {
    routed.links_changed || (follows_links && reconcile)
}

/// One re-discovery. The watcher lock is held only to look the watch up;
/// discovery and the target watches (whose cache walk can be long over a
/// large raw store) run under the watch's own lock alone. A no-op once the
/// watch it was requested for is gone.
fn refresh_link_watches_once<R: tauri::Runtime>(app: &AppHandle<R>, session: u64) {
    let watcher = app.state::<WatcherState>();
    let Some((root, folders, watch)) = (match watcher.0.lock() {
        Ok(guard) => guard
            .as_ref()
            .filter(|active| active.session == session)
            .and_then(|active| {
                Some((
                    active.root.clone(),
                    active.local_only.clone()?,
                    Arc::clone(&active.watch),
                ))
            }),
        Err(_) => None,
    }) else {
        return;
    };
    let discovered = reflect_graph_paths::local_only_links(&root, &folders);
    let Ok(mut linked) = watch.lock() else {
        return;
    };
    linked.apply_links(discovered);
}

fn lock_watcher<'a>(
    watcher: &'a State<WatcherState>,
) -> AppResult<std::sync::MutexGuard<'a, Option<ActiveWatch>>> {
    watcher.0.lock().map_err(|err| {
        tracing::error!(?err, "watcher state lock poisoned by an earlier panic");
        AppError::io("watcher state lock poisoned")
    })
}

/// Start (or restart) watching the active graph; emits `index:changed`
/// batches and `index:reconcile` signals.
///
/// The graph lock is held from reading the root until the new debouncer is
/// installed, so a concurrent `graph_open` can't swap the root mid-install and
/// leave a watcher bound to the previous graph emitting events attributed to
/// the new one. Lock order is graph → watcher; nothing locks the reverse way,
/// so this can't deadlock.
#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    graph: State<GraphState>,
    watcher: State<WatcherState>,
) -> AppResult<()> {
    let graph_guard = graph.0.lock().map_err(|err| {
        tracing::error!(?err, "graph state lock poisoned by an earlier panic");
        AppError::io("graph state lock poisoned")
    })?;
    let root = graph_guard.root.clone().ok_or_else(AppError::no_graph)?;
    let local_only = graph_guard.local_only();

    // Drop any previous watcher first: if installing the new one fails we're then
    // left with no watcher, rather than the previous graph's still driving
    // index:changed against the now-current graph.
    *lock_watcher(&watcher)? = None;

    let started = std::time::Instant::now();
    let session = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
    let links: Arc<RwLock<Vec<LocalOnlyLink>>> = Arc::default();
    let extra_roots: Arc<RwLock<Vec<PathBuf>>> = Arc::default();
    let refresh: Arc<RefreshGate> = Arc::default();
    let live = Arc::new(AtomicBool::new(true));
    // Links are followed only with a raw-store root to follow them into.
    let follows_links = local_only
        .as_ref()
        .is_some_and(|folders| folders.raw_root().is_some());
    let handler_root = root.clone();
    let handler_links = Arc::clone(&links);
    let handler_local_only = local_only.clone();
    let handler_app = app.clone();
    let handler_refresh = Arc::clone(&refresh);
    let handler_live = Arc::clone(&live);
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, PrunedFileIdMap>(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            if !handler_live.load(Ordering::SeqCst) {
                return; // replaced or stopped; kept alive only by a refresh
            }
            let Ok(events) = result else {
                return; // watch errors are transient; the next batch recovers
            };
            let rescan_demanded = events.iter().any(|event| event.need_rescan());
            let paths: Vec<PathBuf> = events
                .iter()
                .flat_map(|event| event.paths.clone())
                .collect();
            let routed = route_event_paths(
                &paths,
                &handler_root,
                &read_lock(&handler_links),
                handler_local_only.as_deref(),
            );
            let mut effects = collect_changes(&routed.paths, &handler_root);
            effects.reconcile |= rescan_demanded || routed.links_changed;
            if effects.reconcile || !effects.changes.is_empty() {
                // Drop the cached catalog before telling the frontend: its
                // follow-up `list_files` must re-walk, not replay the cache.
                crate::fs::invalidate_file_catalog(
                    &handler_app.state::<GraphState>(),
                    &handler_root,
                );
            }
            if !effects.changes.is_empty() {
                let _ = handler_app.emit(CHANGE_EVENT, &effects.changes);
            }
            if effects.reconcile {
                let _ = handler_app.emit(RECONCILE_EVENT, ());
            }
            if needs_link_refresh(&routed, effects.reconcile, follows_links) {
                request_link_refresh(handler_app.clone(), session, Arc::clone(&handler_refresh));
            }
        },
        PrunedFileIdMap::with_extra_roots(root.clone(), Arc::clone(&extra_roots)),
        notify::Config::default(),
    )
    .map_err(|err| AppError::io(err.to_string()))?;

    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|err| AppError::io(err.to_string()))?;

    // Dropping any previous debouncer here stops its thread.
    *lock_watcher(&watcher)? = Some(ActiveWatch {
        watch: Arc::new(Mutex::new(LinkedWatch {
            debouncer,
            links,
            extra_roots,
        })),
        session,
        root,
        local_only,
        live,
    });
    drop(graph_guard);
    if follows_links {
        // Off the main thread: discovery walks the graph.
        request_link_refresh(app, session, refresh);
    }
    tracing::info!(
        elapsed_ms = started.elapsed().as_millis() as u64,
        "watch_start installed"
    );
    Ok(())
}

/// Stop watching (drops the debouncer).
#[tauri::command]
pub fn watch_stop(watcher: State<WatcherState>) -> AppResult<()> {
    *lock_watcher(&watcher)? = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_eligible_markdown_anywhere_and_recordings() {
        let root = Path::new("/g");
        assert_eq!(
            tracked_relpath(Path::new("/g/notes/a.md"), root).as_deref(),
            Some("notes/a.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/daily/2026-06-09.md"), root).as_deref(),
            Some("daily/2026-06-09.md")
        );
        // Templates are tracked like notes; only lowercase `.md` files count.
        assert_eq!(
            tracked_relpath(Path::new("/g/templates/journal.md"), root).as_deref(),
            Some("templates/journal.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/templates/journal.markdown"), root),
            None
        );
        // Adopted vaults keep markdown anywhere visible: root and nested
        // paths are tracked, hidden trees and uppercase `.MD` are not.
        assert_eq!(
            tracked_relpath(Path::new("/g/README.md"), root).as_deref(),
            Some("README.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/Projects/deep/plan.md"), root).as_deref(),
            Some("Projects/deep/plan.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/.obsidian/note.md"), root),
            None
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/Projects/upper.MD"), root),
            None
        );
        // Recordings are tracked whole-directory: they feed the sync debounce
        // and the transcription reconciler.
        assert_eq!(
            tracked_relpath(
                Path::new("/g/audio-memos/audio-memo-2026-06-09-090000-000.m4a"),
                root
            )
            .as_deref(),
            Some("audio-memos/audio-memo-2026-06-09-090000-000.m4a")
        );
        // Capture envelopes are tracked: `.json` under `.reflect/inbox/` is
        // the spool's commit point and triggers the drain. Sibling screenshots
        // and host tmp files are not.
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/inbox/7c9e6679.json"), root).as_deref(),
            Some(".reflect/inbox/7c9e6679.json")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/inbox/7c9e6679.jpg"), root),
            None
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/inbox/.tmp-x8f2"), root),
            None
        );
        // Quarantined spools must not re-trigger the drain.
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/inbox-rejected/bad.json"), root),
            None
        );
        // Not tracked: the index, unsupported extensions, dotfiles, outside
        // root, or the audio-memos directory entry itself.
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/index.sqlite"), root),
            None
        );
        assert_eq!(tracked_relpath(Path::new("/g/notes/x.xyz"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/audio-memos"), root), None);
        assert_eq!(tracked_relpath(Path::new("/other/notes/a.md"), root), None);
    }

    #[test]
    fn tracks_supported_attachments_but_never_description_files() {
        let root = Path::new("/g");
        for rel in [
            "assets/diagram.png",
            "assets/data.txt",
            "Media/PHOTO.JPEG",
            "Docs/ref.pdf",
        ] {
            let path = format!("/g/{rel}");
            assert_eq!(
                tracked_relpath(Path::new(&path), root).as_deref(),
                Some(rel)
            );
        }
        // The description file lives under assets/ too — tracking it would
        // loop a write back into the controller, so it must never be tracked
        // (`assets/` is a reserved tree: its markdown is metadata, not notes).
        assert_eq!(
            tracked_relpath(Path::new("/g/assets/diagram.png.reflect.md"), root),
            None
        );
        assert_eq!(tracked_relpath(Path::new("/g/assets/data.xyz"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/assets/notes.md"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/assets/noext"), root), None);
    }

    #[test]
    fn collect_changes_dedupes_and_marks_missing_as_remove() {
        let root = Path::new("/g");
        // These paths don't exist on disk → "remove"; deduped by path. A
        // missing *tracked* file is a precise removal, never a reconcile.
        let effects = collect_changes(
            &[
                PathBuf::from("/g/notes/a.md"),
                PathBuf::from("/g/notes/a.md"),
                PathBuf::from("/g/.reflect/index.sqlite"),
            ],
            root,
        );
        assert_eq!(
            effects.changes,
            vec![FileChange {
                path: "notes/a.md".to_string(),
                kind: "remove".to_string(),
                modified_ms: None,
            }]
        );
        assert!(!effects.reconcile);
    }

    #[test]
    fn collect_changes_stamps_upserts_with_the_file_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let note = root.join("notes/a.md");
        std::fs::write(&note, "# a").unwrap();

        let effects = collect_changes(&[note], root);
        assert_eq!(effects.changes.len(), 1);
        assert_eq!(effects.changes[0].path, "notes/a.md");
        assert_eq!(effects.changes[0].kind, "upsert");
        // A real timestamp, not epoch zero — All Notes sorts and labels by it.
        assert!(effects.changes[0].modified_ms.is_some_and(|ms| ms > 0));
        assert!(!effects.reconcile);
    }

    #[test]
    fn directory_events_demand_a_reconcile_not_a_diff() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Projects/deep")).unwrap();

        // A visible directory that exists (created or renamed in)…
        let created = collect_changes(&[root.join("Projects")], root);
        assert!(created.reconcile);
        assert!(created.changes.is_empty());

        // …and a visible path that is gone (renamed away or removed): the
        // platform never enumerates the descendants either way.
        let removed = collect_changes(&[root.join("Archive")], root);
        assert!(removed.reconcile);
    }

    #[test]
    fn pruned_dependency_trees_are_invisible_to_live_events() {
        // `npm install` inside an adopted vault: thousands of markdown files
        // land under `node_modules/`, none of which the listing will ever
        // contain. The watcher must neither upsert them nor reconcile for
        // them — the same lexical rule the walk prunes by.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/README.md"), "# dep").unwrap();

        assert_eq!(
            tracked_relpath(&root.join("node_modules/pkg/README.md"), root),
            None
        );
        let effects = collect_changes(
            &[
                root.join("node_modules/pkg/README.md"),
                root.join("node_modules/pkg"),
            ],
            root,
        );
        assert_eq!(effects, BatchEffects::default());
    }

    #[test]
    fn hidden_churn_never_triggers_a_reconcile() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".reflect")).unwrap();
        // Index writes and checkpoints under `.reflect/` — exactly what the
        // reconcile pass itself produces. Feeding them back as reconcile
        // demands would loop forever.
        let effects = collect_changes(
            &[
                root.join(".reflect/index.sqlite"),
                root.join(".reflect/index.sqlite-wal"),
                root.join(".git/objects/pack"),
            ],
            root,
        );
        assert_eq!(effects, BatchEffects::default());
    }

    #[cfg(unix)]
    #[test]
    fn a_note_replaced_by_a_symlink_reads_as_removal() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(outside.path().join("secret.md"), "# outside").unwrap();
        symlink(outside.path().join("secret.md"), root.join("notes/a.md")).unwrap();

        let effects = collect_changes(&[root.join("notes/a.md")], root);
        assert_eq!(effects.changes.len(), 1);
        assert_eq!(effects.changes[0].kind, "remove");
    }

    #[test]
    fn placeholder_events_track_as_their_logical_note() {
        let root = Path::new("/g");
        assert_eq!(
            tracked_relpath(Path::new("/g/notes/.a.md.icloud"), root).as_deref(),
            Some("notes/a.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/audio-memos/.memo.m4a.icloud"), root).as_deref(),
            Some("audio-memos/memo.m4a")
        );
        // The logical file must still pass the tracking rules.
        assert_eq!(
            tracked_relpath(Path::new("/g/notes/.a.xyz.icloud"), root),
            None
        );
    }

    #[test]
    fn eviction_emits_nothing_when_the_placeholder_is_present() {
        // iCloud offloaded the note: the file is gone but its `.icloud` stub
        // remains. That must not read as a deletion — the index keeps the
        // note's last-known content until re-download.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/.a.md.icloud"), b"stub").unwrap();

        // The debounced batch carries both the vanished note and the stub.
        let effects = collect_changes(
            &[root.join("notes/a.md"), root.join("notes/.a.md.icloud")],
            root,
        );
        assert_eq!(effects, BatchEffects::default());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_stub_cannot_suppress_a_removal() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(outside.path().join("decoy"), b"stub").unwrap();
        symlink(
            outside.path().join("decoy"),
            root.join("notes/.a.md.icloud"),
        )
        .unwrap();

        let effects = collect_changes(&[root.join("notes/a.md")], root);
        assert_eq!(effects.changes.len(), 1);
        assert_eq!(effects.changes[0].kind, "remove");
    }

    #[test]
    fn redownload_events_upsert_the_logical_note() {
        // Mid-download both the stub and the real file can exist; whichever
        // path the event carries, the change is an upsert of the note.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/a.md"), "# a").unwrap();
        std::fs::write(root.join("notes/.a.md.icloud"), b"stub").unwrap();

        let effects = collect_changes(&[root.join("notes/.a.md.icloud")], root);
        assert_eq!(effects.changes.len(), 1);
        assert_eq!(effects.changes[0].path, "notes/a.md");
        assert_eq!(effects.changes[0].kind, "upsert");
    }

    #[test]
    fn cache_walk_skips_hidden_and_pruned_trees() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::create_dir_all(root.join(".git/objects/aa")).unwrap();
        std::fs::create_dir_all(root.join(".reflect")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("notes/a.md"), "note").unwrap();
        // Visible temp names must stay cached: an external editor's atomic
        // save renames `note.md.tmp -> note.md`, and stitching that pair is
        // the reason this cache exists at all.
        std::fs::write(root.join("notes/b.md.tmp"), "tmp").unwrap();
        std::fs::write(root.join(".git/objects/aa/bb"), "obj").unwrap();
        std::fs::write(root.join(".reflect/index.sqlite"), "db").unwrap();
        std::fs::write(root.join("node_modules/pkg/x.js"), "js").unwrap();

        let mut cache = PrunedFileIdMap::new(root.to_path_buf());
        cache.add_path(root, RecursiveMode::Recursive);

        assert!(cache.paths.contains_key(&root.join("notes/a.md")));
        assert!(cache.paths.contains_key(&root.join("notes/b.md.tmp")));
        assert!(
            !cache
                .paths
                .keys()
                .any(|path| path.starts_with(root.join(".git"))
                    || path.starts_with(root.join(".reflect"))
                    || path.starts_with(root.join("node_modules"))),
            "hidden and pruned trees must never enter the cache"
        );
    }

    #[test]
    fn cache_event_adds_respect_the_same_prune() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join(".git/objects/loose"), "obj").unwrap();
        std::fs::write(root.join("notes/new.md"), "note").unwrap();

        let mut cache = PrunedFileIdMap::new(root.to_path_buf());
        // Per-event adds arrive as single paths, not walks: `.git` churn from
        // the local-history commits must not grow the cache over a session.
        cache.add_path(&root.join(".git/objects/loose"), RecursiveMode::Recursive);
        assert!(cache.paths.is_empty());
        cache.add_path(&root.join("notes/new.md"), RecursiveMode::Recursive);
        assert!(cache.paths.contains_key(&root.join("notes/new.md")));
    }

    #[test]
    fn cache_has_no_opinion_above_its_root() {
        // A graph legitimately lives under a hidden directory (~/.config):
        // only components *below* the watch root are screened.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(".config/graph");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/a.md"), "note").unwrap();

        let mut cache = PrunedFileIdMap::new(root.clone());
        cache.add_path(&root, RecursiveMode::Recursive);
        assert!(cache.paths.contains_key(&root.join("notes/a.md")));
    }

    /// A graph whose `finance/secure` links into a raw store, both
    /// canonicalized (macOS `/var` → `/private/var`), plus the link record
    /// the watcher's discovery would produce.
    #[cfg(unix)]
    fn linked_graph() -> (tempfile::TempDir, PathBuf, PathBuf, LocalOnlyLink) {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let (root, raw) = (base.join("graph"), base.join("raw"));
        std::fs::create_dir_all(root.join("finance")).unwrap();
        std::fs::create_dir_all(raw.join("finance/secure")).unwrap();
        std::os::unix::fs::symlink(raw.join("finance/secure"), root.join("finance/secure"))
            .unwrap();
        let link = LocalOnlyLink {
            path: "finance/secure".to_string(),
            target: raw.join("finance/secure"),
        };
        (dir, root, raw, link)
    }

    #[cfg(unix)]
    #[test]
    fn raw_store_events_translate_back_under_their_link() {
        let (_dir, root, raw, link) = linked_graph();
        std::fs::write(raw.join("finance/secure/bank.md"), "# Bank").unwrap();
        let routed = route_event_paths(
            &[
                raw.join("finance/secure/bank.md"),
                root.join("notes/a.md"),
                raw.join("elsewhere/x.md"),
            ],
            &root,
            std::slice::from_ref(&link),
            None,
        );
        assert_eq!(
            routed,
            RoutedPaths {
                paths: vec![root.join("finance/secure/bank.md"), root.join("notes/a.md")],
                links_changed: false,
            }
        );

        // The translated path stats through the link like any graph note.
        let effects = collect_changes(&routed.paths[..1], &root);
        assert_eq!(effects.changes.len(), 1);
        assert_eq!(effects.changes[0].path, "finance/secure/bank.md");
        assert_eq!(effects.changes[0].kind, "upsert");
        assert!(effects.changes[0].modified_ms.is_some_and(|ms| ms > 0));
    }

    #[cfg(unix)]
    #[test]
    fn link_and_target_root_events_demand_a_reconcile() {
        let (_dir, root, raw, link) = linked_graph();
        let folders = LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap();
        // The link itself appeared (or was retargeted).
        let routed = route_event_paths(&[root.join("finance/secure")], &root, &[], Some(&folders));
        assert!(routed.links_changed);
        // A link removed: gone, with a configured name.
        let routed = route_event_paths(&[root.join("people/secure")], &root, &[], Some(&folders));
        assert!(routed.links_changed);
        // The target's own root vanished or moved.
        let routed = route_event_paths(
            std::slice::from_ref(&link.target),
            &root,
            std::slice::from_ref(&link),
            Some(&folders),
        );
        assert!(routed.links_changed);
        assert!(routed.paths.is_empty());
        // Without a configuration nothing is a link event.
        let routed = route_event_paths(&[root.join("finance/secure")], &root, &[], None);
        assert!(!routed.links_changed);
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_target_only_loses_its_own_watch() {
        let (_dir, root, raw, link) = linked_graph();
        let (events, received) = std::sync::mpsc::channel();
        let extra_roots: Arc<RwLock<Vec<PathBuf>>> = Arc::default();
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, PrunedFileIdMap>(
            Duration::from_millis(50),
            None,
            move |result: DebounceEventResult| {
                for event in result.unwrap_or_default() {
                    for path in event.paths.clone() {
                        let _ = events.send(path);
                    }
                }
            },
            PrunedFileIdMap::with_extra_roots(root.clone(), Arc::clone(&extra_roots)),
            notify::Config::default(),
        )
        .unwrap();
        debouncer.watch(&root, RecursiveMode::Recursive).unwrap();
        let mut active = LinkedWatch {
            debouncer,
            links: Arc::default(),
            extra_roots,
        };
        let dangling = LocalOnlyLink {
            path: "people/secure".to_string(),
            target: raw.join("missing"),
        };

        active.apply_links(vec![link.clone(), dangling]);

        assert_eq!(*read_lock(&active.links), vec![link.clone()]);
        assert_eq!(*read_lock(&active.extra_roots), vec![link.target.clone()]);
        // The live target reports its own changes.
        std::fs::write(link.target.join("bank.md"), "# Bank").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        let seen = loop {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            match received.recv_timeout(left) {
                Ok(path) if path.starts_with(&link.target) => break true,
                Ok(_) => continue,
                Err(_) => break false,
            }
        };
        assert!(seen, "no event from the watched raw-store target");

        // Re-pointing to nothing unwatches it.
        active.apply_links(Vec::new());
        assert!(read_lock(&active.links).is_empty());
        assert!(read_lock(&active.extra_roots).is_empty());
    }

    #[test]
    fn coalesced_refreshes_never_overlap_and_the_last_runs_after_the_last_request() {
        use std::sync::atomic::AtomicUsize;
        let gate: Arc<RefreshGate> = Arc::default();
        let (active, peak, runs) = (
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
            Arc::new(AtomicUsize::new(0)),
        );
        let requested_at = Arc::new(Mutex::new(Vec::<std::time::Instant>::new()));
        let started_at = Arc::new(Mutex::new(Vec::<std::time::Instant>::new()));
        let work = {
            let (active, peak, runs, started_at) = (
                Arc::clone(&active),
                Arc::clone(&peak),
                Arc::clone(&runs),
                Arc::clone(&started_at),
            );
            move || {
                started_at.lock().unwrap().push(std::time::Instant::now());
                let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(5));
                active.fetch_sub(1, Ordering::SeqCst);
                runs.fetch_add(1, Ordering::SeqCst);
            }
        };
        let work = Arc::new(work);
        let requesters: Vec<_> = (0..8)
            .map(|_| {
                let (gate, work, requested_at) = (
                    Arc::clone(&gate),
                    Arc::clone(&work),
                    Arc::clone(&requested_at),
                );
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        requested_at.lock().unwrap().push(std::time::Instant::now());
                        let work = Arc::clone(&work);
                        run_coalesced(Arc::clone(&gate), move || work());
                        std::thread::sleep(Duration::from_millis(1));
                    }
                })
            })
            .collect();
        for requester in requesters {
            requester.join().unwrap();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while gate.running.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1, "refreshes overlapped");
        let runs = runs.load(Ordering::SeqCst);
        assert!((1..80).contains(&runs), "{runs} runs for 80 requests");
        let last_request = *requested_at.lock().unwrap().iter().max().unwrap();
        let last_start = *started_at.lock().unwrap().iter().max().unwrap();
        assert!(
            last_start >= last_request,
            "no refresh after the last request"
        );
    }

    #[test]
    fn structural_changes_refresh_links_only_when_links_are_followed() {
        let quiet = RoutedPaths::default();
        // A renamed folder carrying a link: no event names the link itself.
        assert!(needs_link_refresh(&quiet, true, true));
        // Control: without a raw-store root nothing is followed to refresh.
        assert!(!needs_link_refresh(&quiet, true, false));
        assert!(!needs_link_refresh(&quiet, false, true));
        let link_event = RoutedPaths {
            paths: Vec::new(),
            links_changed: true,
        };
        assert!(needs_link_refresh(&link_event, false, false));
    }

    /// A refresh looks the watch up under [`WatcherState`] and lets go of it
    /// before discovery and the target watches: `watch_start` and
    /// `watch_stop` must never wait behind a large raw store's walk.
    #[cfg(unix)]
    #[test]
    fn a_refresh_never_holds_the_watcher_lock_while_it_works() {
        let (_dir, root, raw, link) = linked_graph();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        app.manage(WatcherState::default());
        let extra_roots: Arc<RwLock<Vec<PathBuf>>> = Arc::default();
        let debouncer = new_debouncer_opt::<_, RecommendedWatcher, PrunedFileIdMap>(
            Duration::from_millis(50),
            None,
            |_: DebounceEventResult| {},
            PrunedFileIdMap::with_extra_roots(root.clone(), Arc::clone(&extra_roots)),
            notify::Config::default(),
        )
        .unwrap();
        let watch = Arc::new(Mutex::new(LinkedWatch {
            debouncer,
            links: Arc::default(),
            extra_roots,
        }));
        let folders = LocalOnlyFolders::new(["secure"], Some(&raw)).unwrap();
        *app.state::<WatcherState>().0.lock().unwrap() = Some(ActiveWatch {
            watch: Arc::clone(&watch),
            session: 7,
            root: root.clone(),
            local_only: Some(Arc::new(folders)),
            live: Arc::new(AtomicBool::new(true)),
        });

        // Hold the watch's own lock, as a long target walk would.
        let held = watch.lock().unwrap();
        let handle = app.handle().clone();
        let refresh = std::thread::spawn(move || refresh_link_watches_once(&handle, 7));
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            app.state::<WatcherState>().0.try_lock().is_ok(),
            "the refresh held the watcher lock while waiting to apply"
        );
        drop(held);
        refresh.join().unwrap();
        assert_eq!(*read_lock(&watch.lock().unwrap().links), vec![link]);
    }

    #[test]
    fn cache_walk_prunes_below_extra_roots_too() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("graph");
        let target = dir.path().join("raw/secure");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::create_dir_all(target.join(".cache")).unwrap();
        std::fs::write(target.join("bank.md"), "bank").unwrap();
        std::fs::write(target.join(".cache/blob"), "blob").unwrap();

        let extra = Arc::new(RwLock::new(vec![target.clone()]));
        let mut cache = PrunedFileIdMap::with_extra_roots(root, extra);
        cache.add_path(&target, RecursiveMode::Recursive);
        assert!(cache.paths.contains_key(&target.join("bank.md")));
        assert!(!cache
            .paths
            .keys()
            .any(|path| path.starts_with(target.join(".cache"))));
    }

    #[test]
    fn cache_remove_path_evicts_the_whole_subtree() {
        // A stale entry after a directory rename/remove would keep matching
        // the old path's file ID and mis-stitch a later event.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes/sub")).unwrap();
        std::fs::write(root.join("notes/a.md"), "a").unwrap();
        std::fs::write(root.join("notes/sub/b.md"), "b").unwrap();
        std::fs::write(root.join("top.md"), "top").unwrap();

        let mut cache = PrunedFileIdMap::new(root.to_path_buf());
        cache.add_path(root, RecursiveMode::Recursive);
        assert!(cache.paths.contains_key(&root.join("notes/sub/b.md")));

        cache.remove_path(&root.join("notes"));
        assert!(
            !cache
                .paths
                .keys()
                .any(|path| path.starts_with(root.join("notes"))),
            "the removed subtree must be fully evicted"
        );
        assert!(cache.paths.contains_key(&root.join("top.md")));
    }
}
