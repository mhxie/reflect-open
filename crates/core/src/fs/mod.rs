//! Graph file-IO primitives (Plan 02).
//!
//! Markdown files are the durable source of truth; this module moves bytes and
//! paths, not meaning. All paths are **graph-relative** — the graph root lives
//! in Rust state and the frontend can never address files outside it
//! (path-traversal guard, [`resolve`]). Writes are atomic (temp file + rename,
//! [`io`]) and deletes go to the OS trash. Parsing/indexing live in later plans.

pub mod asset_protocol;
pub mod asset_request;
pub mod assets;
mod external_storage;
mod local_only;
pub mod preview_cache;
pub mod x_archive;
mod x_download;
pub mod x_media_protocol;
mod x_syndication;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use reflect_graph_io::import;
use reflect_graph_io::io::{self, atomic_write_bytes, bootstrap, initialize_runtime};
use reflect_graph_io::local_only_edit;
use reflect_graph_io::*;
use reflect_graph_paths::{eviction_placeholder, is_dataless};
use reflect_types::{AppError, AppResult, FileMeta};
use serde::Serialize;

use crate::{Core, Host};

/// Where [`Core::note_delete`] put the note.
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

impl Core {
    /// Command: create a new graph at `path` (scaffolds the layout) and open it.
    pub fn graph_create(&self, path: String) -> AppResult<GraphInfo> {
        let root = PathBuf::from(&path);
        fs::create_dir_all(&root)?;
        bootstrap(&root)?;
        sweep_preview_caches(&root);
        open_graph(&self.graph, &root)
    }

    /// Command: import a user-selected Reflect V1 export `.zip` into the open
    /// graph. V1's export is already the graph folder shape, so this extracts
    /// safe entries directly under the current root; existing files are never
    /// replaced (and never fail the import — identical files skip,
    /// conflicting notes rename, conflicting daily notes merge). Attachments
    /// the notes link to on Firebase Storage or Reflect's asset CDN are
    /// downloaded into `assets/` first and the links rewritten, so the
    /// imported graph doesn't depend on Reflect V1's infrastructure staying
    /// up. Progress is emitted as `import:progress` events, and
    /// [`Core::graph_import_cancel`] aborts the run before anything lands in
    /// the graph.
    pub async fn graph_import_reflect_v1_zip(
        &self,
        path: String,
        generation: u64,
    ) -> AppResult<import::ImportSummary> {
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        let cancel = &self.import_cancel;
        // Holds the one import slot until this command returns on any path — a
        // second import starting mid-run would clear a cancel meant for the
        // first and race its writes.
        let _running = cancel.begin()?;
        let prepared = import::prepare_zip_import(&root, Path::new(&path))?;
        if prepared.remote_asset_count() > 0 {
            emit_import_progress(self.host(), "downloading", 0, prepared.remote_asset_count());
        }
        let download_host = Arc::clone(&self.host);
        let user_agent = self.config().user_agent.clone();
        let downloads = prepared
            .download_assets(
                &user_agent,
                cancel.flag(),
                Arc::new(move |done, total| {
                    emit_import_progress(download_host.as_ref(), "downloading", done, total);
                }),
            )
            .await?;
        // The downloads can take a while; refuse to write into a graph the user
        // has switched away from (or an import the user cancelled) in the
        // meantime — nothing has been written yet.
        cancel.ensure_active()?;
        root_for_generation(&self.graph, generation)?;
        // Writing is fast and local; throttle the events to ~100 per import so a
        // large graph doesn't flood the webview.
        let mut last_emitted = 0usize;
        let summary = with_graph_lock(&root, || {
            cancel.ensure_active()?;
            root_for_generation(&self.graph, generation)?;
            import::finalize_import(
                &root,
                local_only.as_deref(),
                prepared,
                downloads,
                |done, total| {
                    let step = (total / 100).max(1);
                    if done == total || done >= last_emitted + step {
                        last_emitted = done;
                        emit_import_progress(self.host(), "writing", done, total);
                    }
                },
            )
        })?;
        invalidate_file_catalog(&self.graph, &root);
        Ok(summary)
    }

    /// Command: cancel the running Reflect V1 import (a no-op when none is
    /// running). The import aborts before any graph write, so cancellation is
    /// always safe.
    pub fn graph_import_cancel(&self) {
        self.import_cancel.cancel();
    }

    /// Command: open an existing Markdown vault in place, adding only
    /// `.reflect/` runtime state. Reflect's authoring directories remain lazy
    /// for adopted vaults.
    pub fn graph_open(&self, path: String) -> AppResult<GraphInfo> {
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err(AppError::not_found(format!("not a directory: {path}")));
        }
        initialize_runtime(&root)?;
        sweep_preview_caches(&root);
        open_graph(&self.graph, &root)
    }

    /// Command: read a note's markdown by graph-relative path. `generation`,
    /// when given, pins the read to the issuing graph session (see
    /// [`root_for`]).
    ///
    /// Off the main thread on purpose: this read *does* materialize an evicted
    /// iCloud note (that is its contract — bulk passes use
    /// [`Core::note_read_local`]), and an on-demand download from a sync
    /// command would freeze the whole app for its duration, exactly like the
    /// old synchronous asset protocol.
    pub async fn note_read(&self, path: String, generation: Option<u64>) -> AppResult<String> {
        let (root, local_only) = graph_for(&self.graph, generation)?;
        let target = resolve_read(&root, &path, local_only.as_deref())?;
        self.spawn_blocking(move || Ok(io::read_note_no_follow(&target.base, &target.rest)?))
            .await
    }

    /// Command: read a note bound for somewhere beyond this machine (the AI
    /// tools, whose paths are model-supplied). Only a visible Markdown file is
    /// served ([`ensure_shareable_note_path`]). Rust decides local-only status,
    /// not the requested string: a folded spelling (`ſecure`, `SECURE`) or an
    /// in-graph alias of a local-only folder answers `LocalOnly` exactly like
    /// the canonical path. Otherwise identical to [`Core::note_read`].
    pub async fn note_read_shareable(
        &self,
        path: String,
        generation: Option<u64>,
    ) -> AppResult<ShareableNoteRead> {
        let (root, local_only) = graph_for_sharing(&self.graph, generation)?;
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
        self.spawn_blocking(move || {
            Ok(ShareableNoteRead::Content {
                content: io::read_note_no_follow(&target.base, &target.rest)?,
            })
        })
        .await
    }

    /// Command: read a note's markdown **only when its bytes are local**. Bulk
    /// background passes (the embedding backfill, asset-description
    /// gathering) must use this instead of [`Core::note_read`]: reading an
    /// evicted note makes `fileproviderd` materialize it on demand, and a
    /// whole-graph pass over an evicted iCloud graph becomes thousands of
    /// serial blocking downloads. Runs off the main thread — even a local read
    /// must not stall the UI under a busy provider. Dataless materialization
    /// is switched off for the whole check-and-read ([`io::NoMaterialize`],
    /// per TN3150), so an eviction racing the stat reports `Evicted` instead
    /// of blocking on a download; engaging the policy is best-effort, and on
    /// the rare refusal a narrow stat-then-read race remains (see the
    /// call-site comment).
    pub async fn note_read_local(
        &self,
        path: String,
        generation: Option<u64>,
        sharing: Option<bool>,
    ) -> AppResult<LocalNoteRead> {
        // `sharing` marks bytes about to leave this device (the cloud
        // note-summary engine): like `note_read_shareable`, the read then
        // refuses while sharing is paused.
        let (root, local_only) = if sharing.unwrap_or(false) {
            graph_for_sharing(&self.graph, generation)?
        } else {
            graph_for(&self.graph, generation)?
        };
        let target = resolve_read(&root, &path, local_only.as_deref())?;
        let abs = target.path();
        self.spawn_blocking(move || {
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
                Err(err) if err.kind() == std::io::ErrorKind::Deadlock => {
                    Ok(LocalNoteRead::Evicted)
                }
                Err(err) => Err(err.into()),
            }
        })
        .await
    }

    /// Command: atomically write a note's markdown by graph-relative path.
    /// `generation` pins the write to the graph it was issued for (see
    /// `root_for_generation`). The outcome's `modified_ms` is the file's
    /// on-disk mtime after the call (epoch ms, `None` when the platform can't
    /// provide one), so the caller's index echo stamps the row with the value
    /// a later `list_files` reports.
    ///
    /// `expected_contents` is compared with the note as [`Core::note_read`]
    /// returns it, with `\n` line endings. When it matches, `contents` is
    /// written as given; when the file moved past it, the outcome's `merged`
    /// holds the text the file holds now (see [`write_note_revision`]).
    pub fn note_write(
        &self,
        path: String,
        contents: String,
        generation: u64,
        check_contents: Option<bool>,
        expected_contents: Option<String>,
    ) -> AppResult<NoteWriteOutcome> {
        // Every write is checked: a writer that skipped the check could put
        // back text over bytes a sync pull or another device just wrote.
        if check_contents != Some(true) {
            return Err(AppError::parse(
                "a note write must name the contents it replaces",
            ));
        }
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        let outcome = write_note_revision(
            &root,
            &path,
            &contents,
            expected_contents.as_deref(),
            local_only.as_deref(),
            || root_for_generation(&self.graph, generation).map(drop),
        )?;
        invalidate_file_catalog(&self.graph, &root);
        Ok(outcome)
    }

    /// Command: [`Core::note_write`] for a change that is not an edit: the note
    /// keeps its modification time, so the All Notes recency order and
    /// "Updated" column don't move. The background AI summary pass writes its
    /// `aiSummary` frontmatter block through it; a whole graph of summaries
    /// must not read as a graph of fresh edits.
    ///
    /// The file must exist and still hold `expected_contents` exactly, or the
    /// write is refused as [`CHANGED_ON_DISK`] (the pass re-reads and retries).
    /// A note in a local-only folder is refused (`Unsupported`): its
    /// descriptor-based write path has no way to carry the time across.
    ///
    /// Returns the kept mtime (epoch ms) for the index echo.
    pub fn note_write_keep_modified(
        &self,
        path: String,
        contents: String,
        generation: u64,
        expected_contents: String,
    ) -> AppResult<Option<u64>> {
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        let modified_ms = write_note_keeping_modified(
            &root,
            &path,
            &contents,
            &expected_contents,
            local_only.as_deref(),
            || root_for_generation(&self.graph, generation).map(drop),
        )?;
        invalidate_file_catalog(&self.graph, &root);
        Ok(modified_ms)
    }

    /// Command: atomically create a note only when `path` is still free.
    /// Unlike [`Core::note_write`], this is a no-clobber claim: a concurrent
    /// sync checkout or creator wins as `Collision`, with its file left
    /// byte-for-byte intact.
    pub fn note_create(
        &self,
        path: String,
        contents: String,
        generation: u64,
    ) -> AppResult<NoteCreateOutcome> {
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        let outcome = create_note(&root, &path, &contents, local_only.as_deref(), || {
            root_for_generation(&self.graph, generation).map(drop)
        })?;
        if matches!(outcome, NoteCreateOutcome::Created { .. }) {
            invalidate_file_catalog(&self.graph, &root);
        }
        Ok(outcome)
    }

    /// Command: atomically write a binary asset (pasted/dropped image) by
    /// graph-relative path. Contents arrive base64-encoded — Tauri IPC args
    /// are JSON, and pasted images are small enough that the ~33% encoding
    /// overhead is irrelevant.
    pub fn asset_write(
        &self,
        path: String,
        contents_base64: String,
        generation: u64,
    ) -> AppResult<()> {
        use base64::Engine;
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(contents_base64.as_bytes())
            .map_err(|err| AppError::io(format!("invalid base64 asset payload: {err}")))?;
        with_graph_lock(&root, || {
            root_for_generation(&self.graph, generation)?;
            let target = resolve_write(&root, &path, local_only.as_deref())?;
            atomic_write_bytes(&root, &target, &bytes)
        })?;
        invalidate_file_catalog(&self.graph, &root);
        Ok(())
    }

    /// Command: delete one recording under `audio-memos/`: cancelling a
    /// recording session discards the segments it already landed.
    /// Deliberately scoped to the `audio-memos/` prefix so this command can
    /// never grow into a general file-delete IPC. Idempotent — a segment
    /// deleted twice (or never written) is fine.
    pub fn audio_memo_delete(&self, path: String, generation: u64) -> AppResult<()> {
        if !path.starts_with("audio-memos/") {
            return Err(AppError::traversal(format!(
                "not an audio memo path: {path}"
            )));
        }
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        with_graph_lock(&root, || {
            root_for_generation(&self.graph, generation)?;
            let abs = resolve_write(&root, &path, local_only.as_deref())?;
            // An iCloud-evicted segment exists only as its `.name.icloud` stub,
            // mirror `note_delete` so a cancelled session's evicted parts still
            // delete.
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
        })
    }

    /// Command: read one cached segment transcript; `notFound` when nothing is
    /// cached.
    pub fn transcript_cache_read(&self, name: String, generation: u64) -> AppResult<String> {
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        match fs::read_to_string(transcript_cache_file(&root, &name, local_only.as_deref())?) {
            Ok(contents) => Ok(contents),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                Err(AppError::not_found(format!("no cached transcript: {name}")))
            }
            Err(err) => Err(err.into()),
        }
    }

    /// Command: cache one segment's transcription result. A torn write is
    /// harmless — the reader treats undecodable JSON as "no cache" and
    /// re-transcribes.
    pub fn transcript_cache_write(
        &self,
        name: String,
        contents: String,
        generation: u64,
    ) -> AppResult<()> {
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        fs::write(
            transcript_cache_file(&root, &name, local_only.as_deref())?,
            contents,
        )?;
        Ok(())
    }

    /// Command: read a binary asset's bytes as a **raw IPC response** — no
    /// base64, no JSON. Long audio memos read back for transcription would
    /// otherwise cross the bridge ~1.33× inflated inside one giant JSON
    /// string. Pinned to `generation` for the same reason as
    /// [`Core::asset_read`].
    pub fn asset_read_binary(&self, path: String, generation: u64) -> AppResult<Vec<u8>> {
        // Refused for local-only files, like `asset_read`.
        let target = graph_for_sharing_attachments(&self.graph, Some(generation))?
            .resolve_shareable(&path)?;
        read_target(&target)
    }

    /// Command: read a binary asset's bytes, base64-encoded for the JSON IPC
    /// (e.g. audio memos read back for transcription). Pinned to `generation`,
    /// unlike `note_read`: the caller is a background pass that can span a
    /// graph switch, and an unpinned read would resolve against the *new*
    /// root — handing back (and possibly sending to a provider) another
    /// graph's file.
    pub fn asset_read(&self, path: String, generation: u64) -> AppResult<String> {
        use base64::Engine;
        ensure_readable_attachment_path(&path)?;
        // Every caller ships the bytes off-device (transcription, asset
        // description, capture enrichment), so a local-only file is refused
        // however its path is spelled.
        let target = graph_for_sharing_attachments(&self.graph, Some(generation))?
            .resolve_shareable(&path)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(read_target(&target)?))
    }

    /// Command: open a graph asset in the OS default application. The
    /// frontend supplies the graph-relative `assets/...` path from markdown;
    /// Rust resolves it inside the generation-pinned graph so the JS opener
    /// never gets broad filesystem access.
    pub fn asset_open(&self, path: String, generation: u64) -> AppResult<()> {
        // A page (`.html`) opens here too, in the browser, and nowhere in
        // Reflect.
        ensure_openable_path(&path)?;
        let abs = graph_for_attachments(&self.graph, Some(generation))?
            .resolve(&path)?
            .path();
        if !abs.is_file() {
            return Err(AppError::not_found(format!("asset not found: {path}")));
        }
        open_asset_path(self.host(), &abs)
    }

    /// Command: reveal a graph file in the OS file manager. Deliberately laxer
    /// than [`Core::asset_open`]: revealing never executes anything, so
    /// lexical path safety plus existence is the whole requirement. This is
    /// the frontend's fallback when `asset_open` refuses a file type.
    pub fn asset_reveal(&self, path: String, generation: u64) -> AppResult<()> {
        ensure_revealable_path(&path)?;
        let abs = graph_for_attachments(&self.graph, Some(generation))?
            .resolve(&path)?
            .path();
        if !abs.is_file() {
            return Err(AppError::not_found(format!("asset not found: {path}")));
        }
        reveal_asset_path(self.host(), &abs)
    }

    /// Command: list every file (any extension) under a graph-relative
    /// directory, e.g. `audio-memos`. Which directory means what is the
    /// TypeScript layer's policy; a missing directory lists as empty. Pinned
    /// to `generation` for the same reason as `asset_read` — the listing seeds
    /// a background pass that must never mix graphs.
    pub fn dir_list(&self, dir: String, generation: u64) -> AppResult<Vec<FileMeta>> {
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        resolve(&root, &dir)?; // traversal guard; the walk itself skips symlinks
        let mut out = Vec::new();
        io::collect_files(&root, &dir, None, &mut out)?;
        // Files in a local-only folder are left out, including every file of a
        // directory linked into one: the passes this listing seeds
        // (transcription, asset descriptions) must never see them.
        if let Some(folders) = local_only.as_deref() {
            out.retain(|file| !entry_is_local_only(&root, &file.path, folders));
        }
        Ok(out)
    }

    /// Command: does a graph-relative path currently exist as a file? The
    /// collision picker (Plan 17) probes disk as well as the index — the index
    /// lags the watcher by a debounce, and an unindexed file must never be
    /// clobbered by a new note.
    pub fn note_exists(&self, path: String) -> AppResult<bool> {
        let (root, local_only) = graph_for(&self.graph, None)?;
        // Occupied, not merely readable: an iCloud-evicted note is only a stub on
        // disk, but creating a new note at its path would collide the moment the
        // real file re-downloads (Plan 21).
        Ok(io::file_occupied(
            &resolve_read(&root, &path, local_only.as_deref())?.path(),
        ))
    }

    /// Command: send a note to the OS trash (recoverable), not a hard delete
    /// (pinned to `generation`). Mobile has no OS trash: the file moves into
    /// the graph-local `.reflect/trash/` instead (Plan 19), the same
    /// recoverability promise, and `.reflect/` is already excluded from sync
    /// and indexing.
    ///
    /// A note in an editable local-only folder is first staged through
    /// directory descriptors in a fresh random directory
    /// (`.reflect/trash/<random>/`, or a hidden one beside the note when its
    /// folder is on another volume), so the path-based OS-trash call can only
    /// ever reach the file staged there. When the OS trash refuses it, a note
    /// staged in `.reflect/trash/` stays there and the outcome says so
    /// ([`Trashed::Graph`]); one staged beside goes back under its name and
    /// the delete fails. A trashed local-only note's kept unsaved text goes
    /// with it.
    pub fn note_delete(&self, path: String, generation: u64) -> AppResult<NoteDeleteOutcome> {
        let (root, local_only) = graph_for(&self.graph, Some(generation))?;
        let trashed = with_graph_lock(&root, || {
            root_for_generation(&self.graph, generation)?;
            delete_note_locked(&root, &path, local_only.as_deref(), |target| match target {
                DeleteTarget::Graph(abs) => trash_graph_file(&root, &abs),
                DeleteTarget::LocalOnly(entry) => trash_local_only(&entry, &path),
            })
        })?;
        invalidate_file_catalog(&self.graph, &root);
        Ok(NoteDeleteOutcome { trashed })
    }

    /// Command: move the open graph's **entire directory** to the OS trash
    /// (recoverable) and drop it from recents. The session is invalidated
    /// (root cleared, generation bumped) **before** the filesystem is touched:
    /// a pinned write re-checks its generation under the graph lock, so one
    /// queued behind this delete fails instead of recreating directories under
    /// the trashed path. If the trash move itself then fails, the session
    /// stays invalidated and the frontend re-opens the intact directory to
    /// restore a writable session. Pinned to `generation` — a delete enqueued
    /// before a graph switch must never trash the newly opened graph.
    /// Desktop-only: mobile's fixed roots have no OS trash and no delete UI.
    pub fn graph_delete(&self, generation: u64) -> AppResult<()> {
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            let root = root_for_generation(&self.graph, generation)?;
            // Take the graph lock first, then check the generation and invalidate
            // under one session lock hold. Pinned writes re-check the generation
            // under the graph lock, so one that waited here fails afterwards.
            with_graph_lock(&root, || {
                invalidate_for_delete(&self.graph, generation)?;
                os_trash_delete(&root)
            })?;
            // Recents is a convenience cache (same stance as `activate`): the
            // directory is already in the trash, so a failure to persist must not
            // report the delete as failed. A stale entry fails loudly on open.
            if let Err(err) = crate::recents::forget(&root.to_string_lossy()) {
                tracing::warn!(?err, "failed to forget deleted graph");
            }
            Ok(())
        }
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let _ = generation;
            Err(AppError::io(
                "deleting a graph is not supported on this platform",
            ))
        }
    }

    /// Command: list eligible Markdown notes anywhere in the vault.
    /// `generation`, when given, pins the listing to the issuing graph session
    /// (see [`root_for`]).
    ///
    /// Async because a cold catalog is a full-tree walk; the cached case pays
    /// one thread hop, which is noise next to the IPC round-trip itself.
    pub async fn list_files(self: &Arc<Self>, generation: Option<u64>) -> AppResult<Vec<FileMeta>> {
        self.catalog_off_main(generation, |catalog| catalog.notes)
            .await
    }

    /// Command: list supported local attachments from the same cached catalog
    /// as [`Core::list_files`], and off the main thread for the same reason:
    /// the editor asks for it as soon as a note opens, possibly before any
    /// walk has run.
    pub async fn list_attachments(
        self: &Arc<Self>,
        generation: Option<u64>,
    ) -> AppResult<Vec<FileMeta>> {
        self.catalog_off_main(generation, |catalog| catalog.attachments)
            .await
    }

    /// Read one listing out of the cached catalog on the blocking pool.
    async fn catalog_off_main<F>(
        self: &Arc<Self>,
        generation: Option<u64>,
        listing: F,
    ) -> AppResult<Vec<FileMeta>>
    where
        F: FnOnce(io::FileCatalog) -> Vec<FileMeta> + Send + 'static,
    {
        // Pin the graph session before the hop, like `note_read` and `db_query`:
        // an unpinned call resolved inside the closure could list a root swapped
        // in after the invoke (the rebuild path calls this without a
        // generation). A pinned call the switch superseded fails the
        // `file_catalog` generation check instead of listing the wrong graph.
        let generation = match generation {
            Some(generation) => generation,
            None => current_graph_info(&self.graph)?.generation,
        };
        let core = Arc::clone(self);
        self.spawn_blocking(move || Ok(listing(file_catalog(&core.graph, Some(generation))?)))
            .await
    }

    /// Command: counts of the cached catalog's notes, attachments, and skipped
    /// entries.
    pub fn vault_scan_stats(&self, generation: Option<u64>) -> AppResult<VaultScanStats> {
        let catalog = file_catalog(&self.graph, generation)?;
        Ok(VaultScanStats {
            notes: catalog.notes.len() as u32,
            attachments: catalog.attachments.len() as u32,
            skipped: catalog.skipped,
        })
    }
}

fn emit_import_progress(host: &dyn Host, stage: &'static str, done: usize, total: usize) {
    if let Ok(payload) = serde_json::to_value(import::ImportProgress { stage, done, total }) {
        host.emit("import:progress", payload);
    }
}

/// Activate `root` and record it in recents. Recents is a convenience cache:
/// a failure to persist it must not fail the open (which would leave Rust
/// treating the graph as open while the command returns an error, out of sync
/// with the UI). Best-effort, log and move on.
fn open_graph(state: &GraphState, root: &Path) -> AppResult<GraphInfo> {
    let info = activate(state, root, load_config(root))?;
    if let Err(err) = crate::recents::record(root, &info.name) {
        tracing::warn!(?err, "failed to record recent graph");
    }
    Ok(info)
}

/// The configuration a graph open loads from the settings store (and the
/// index's record of the folders), before the state lock is taken: it is
/// file IO. It covers the graph's local-only folders, backup size limit,
/// accepted history roots, and external storage.
fn load_config(root: &Path) -> GraphConfig {
    let loaded = local_only::load_for_root(root);
    for warning in &loaded.warnings {
        tracing::warn!(root = %root.display(), "local-only folders: {warning}");
    }
    let backup = crate::git::load_backup_settings(root);
    let raw_root = loaded
        .folders
        .as_deref()
        .and_then(|folders| folders.raw_root());
    let external = external_storage::load_for_root(root, raw_root);
    let mut backup_warnings = backup.warnings;
    backup_warnings.extend(external.warnings);
    for warning in &backup_warnings {
        tracing::warn!(root = %root.display(), "backup settings: {warning}");
    }
    GraphConfig {
        local_only: loaded.folders,
        local_only_warnings: loaded.warnings,
        local_only_unknown: loaded.unknown,
        local_only_grow_record: !loaded.record,
        backup_max_file_bytes: Some(backup.max_file_bytes),
        accepted_history_roots: backup.accepted_roots,
        backup_warnings,
        external: external.store.map(std::sync::Arc::new),
        external_links: external.links.map(std::sync::Arc::new),
    }
}

/// Drop the PDF page and image thumbnail caches under `.reflect/` past their
/// caps, like the upload staging the runtime initialization sweeps: derived
/// data a crash may have left half-written.
fn sweep_preview_caches(root: &Path) {
    preview_cache::sweep_page_cache(root);
    preview_cache::sweep_thumbnail_cache(root);
}

/// The whole file a read target names. An external file whose bytes are not
/// on this device fails instead of downloading (`ReadTarget::open`).
fn read_target(target: &ReadTarget) -> AppResult<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    target.open()?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

/// Trash an ordinary graph file: into the system Trash on desktop, into the
/// graph's own `.reflect/trash/` on mobile.
fn trash_graph_file(root: &Path, target: &Path) -> AppResult<Trashed> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = root;
        os_trash_delete(target)?;
        Ok(Trashed::System)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        move_to_graph_trash(root, target)?;
        Ok(Trashed::Graph)
    }
}

/// Trash the editable local-only note `entry` (requested as `path`): stage
/// it, hand it to the OS trash, and drop its kept unsaved text once it is
/// gone from its folder. The caller holds the graph lock.
fn trash_local_only(entry: &LocalOnlyEntry, path: &str) -> AppResult<Trashed> {
    let stage = local_only_edit::trash_note(entry)?;
    let trashed = hand_to_os_trash(stage)?;
    local_only_edit::forget_recovery(&entry.graph_root, path);
    Ok(trashed)
}

/// Hand a staged local-only note to the OS trash. When the OS trash refuses
/// (or there is none), a note staged in `.reflect/trash/` stays there
/// ([`Trashed::Graph`]); one staged beside its folder moves back under its
/// name, and the refusal is the delete's error.
fn hand_to_os_trash(stage: local_only_edit::TrashStage) -> AppResult<Trashed> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let refusal = match os_trash_delete(&stage.path()) {
        Ok(()) => {
            stage.trashed();
            return Ok(Trashed::System);
        }
        Err(err) => err,
    };
    #[cfg(any(target_os = "android", target_os = "ios"))]
    let refusal = AppError::io("there is no system Trash on this platform");
    if !stage.refused()? {
        return Err(refusal);
    }
    tracing::warn!(
        err = ?refusal,
        "the system Trash refused a local-only note; it stays in the graph's .reflect/trash"
    );
    Ok(Trashed::Graph)
}

#[cfg(target_os = "ios")]
fn open_asset_path(host: &dyn Host, path: &Path) -> AppResult<()> {
    let url = asset_file_url(path)?;
    host.open_url(url.as_str())
}

/// The desktop host's opener takes a plain path as its URL argument.
#[cfg(not(target_os = "ios"))]
fn open_asset_path(host: &dyn Host, path: &Path) -> AppResult<()> {
    host.open_url(&path.to_string_lossy())
}

#[cfg(target_os = "ios")]
fn reveal_asset_path(_host: &dyn Host, _path: &Path) -> AppResult<()> {
    Err(AppError::io("revealing files is not supported on iOS"))
}

#[cfg(not(target_os = "ios"))]
fn reveal_asset_path(host: &dyn Host, path: &Path) -> AppResult<()> {
    host.reveal_path(path)
}

#[cfg(any(target_os = "ios", test))]
fn asset_file_url(path: &Path) -> AppResult<reqwest::Url> {
    reqwest::Url::from_file_path(path).map_err(|()| {
        AppError::io(format!(
            "failed to convert asset path to file URL: {}",
            path.display()
        ))
    })
}

/// Send a file to the OS trash. On macOS, use `NSFileManager.trashItemAtURL`
/// (`DeleteMethod::NsFileManager`) instead of the `trash` crate default, which
/// drives Finder over AppleScript and fails with `-10010` ("Handler can't
/// handle objects of this class") when the graph lives on a cloud-synced or
/// network volume. The NsFileManager path needs no Automation permission, makes
/// no sound, and still lands the file in the system Trash for recovery.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
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
#[cfg(all(test, not(any(target_os = "android", target_os = "ios"))))]
pub(crate) mod os_trash_seam {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    use reflect_types::{AppError, AppResult};

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

#[cfg(test)]
mod asset_url_tests {
    use super::asset_file_url;

    #[test]
    fn asset_file_url_percent_encodes_local_paths() {
        let path = std::env::temp_dir().join("Reflect Cat Photo.png");
        let url = asset_file_url(&path).unwrap();

        assert_eq!(url.scheme(), "file");
        assert!(url.as_str().contains("Reflect%20Cat%20Photo.png"));
    }
}

#[cfg(test)]
mod graph_delete_race_tests {
    use crate::test_support::core;
    use reflect_graph_io::{graph_lock_holders, invalidate_for_delete, with_graph_lock};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    /// The command-level half of the race: `note_write` must re-check its
    /// generation under the graph lock, so a write that waited behind a graph
    /// delete fails instead of recreating directories under the trashed root.
    #[test]
    fn a_note_write_queued_behind_graph_delete_fails_its_generation_check() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("graph");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let core = core();
        let graph = &core.graph;
        {
            let mut inner = graph.0.lock().unwrap();
            inner.generation = 1;
            inner.root = Some(root.clone());
        }

        std::thread::scope(|scope| {
            let (locked_tx, locked_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel::<()>();
            let root = &root;
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
            let core = &core;
            let writer = scope.spawn(move || {
                core.note_write(
                    "notes/late.md".to_string(),
                    "# Late\n".to_string(),
                    1,
                    Some(true),
                    None,
                )
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            while graph_lock_holders(root) < 2 {
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

#[cfg(test)]
mod tests;
