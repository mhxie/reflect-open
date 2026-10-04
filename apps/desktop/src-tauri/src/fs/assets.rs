//! Asset intake: streamed uploads and file-to-file imports into `assets/`.
//!
//! Two ways bytes become a graph asset, both landing through one collision
//! policy ([`persist_unique`]) so a name is decided exactly once, race-free,
//! by the filesystem:
//!
//! - **Streamed upload** (`asset_upload_begin` / `_append` / `_commit` /
//!   `_abort`): the paste/drop path. The webview holds a `File` with no OS
//!   path, so bytes cross the IPC — as **raw request bodies** (no base64, no
//!   JSON), in chunks, into a temp file under `.reflect/tmp/` (excluded from
//!   indexing and sync, so the watcher never sees a half-written upload).
//!   Commit renames into `assets/`.
//! - **Import** (`asset_import`): the file-picker path. The source has a real
//!   OS path, so Rust copies file-to-file and the bytes never enter webview
//!   memory at all.
//!
//! Both take the path of the note the attachment is for, and Rust picks the
//! destination from it ([`attachment_destination`]): an ordinary note's
//! attachments go to the synced `assets/`, and a note in an editable
//! local-only folder keeps its attachments in that folder's own `assets/`,
//! landed through directory descriptors with the same `-2`, `-3`, … policy.
//! A note in a read-only local-only folder takes none.
//!
//! Both are generation-pinned like every mutating command: a graph switch
//! mid-upload strands the temp file in the *old* graph's `.reflect/tmp/` and
//! the commit is rejected loudly.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request};
use tauri::State;

use reflect_graph_paths::LocalOnlyFolders;

use crate::error::{AppError, AppResult};

use super::local_only_edit;
use super::resolve::{resolve_note_edit, resolve_write, EditTarget, LocalOnlyEntry, TargetKind};
use super::{graph_for, root_for_generation, GraphState};

/// Header carrying the upload id on `asset_upload_append` calls — raw-body
/// requests have no JSON args, so the id travels out-of-band.
const UPLOAD_ID_HEADER: &str = "x-upload-id";
/// Collision probes before giving up, mirroring `probeNotePath`'s cap.
const MAX_NAME_PROBES: u32 = 1000;

struct Upload {
    generation: u64,
    file: tempfile::NamedTempFile,
}

/// Tauri-managed registry of in-flight streamed uploads, keyed by upload id.
#[derive(Default)]
pub struct AssetUploads(Mutex<HashMap<String, Upload>>);

fn lock_uploads(
    uploads: &AssetUploads,
) -> AppResult<std::sync::MutexGuard<'_, HashMap<String, Upload>>> {
    uploads.0.lock().map_err(|err| {
        tracing::error!(?err, "asset upload state lock poisoned by an earlier panic");
        AppError::io("asset upload state lock poisoned")
    })
}

/// Reject an asset filename that is empty, path-shaped, or a dot name. The
/// TypeScript layer sanitizes names for readability; this is the trust
/// boundary that keeps whatever arrives a single flat segment under `assets/`.
fn ensure_asset_name(name: &str) -> AppResult<()> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name == "."
        || name == ".."
    {
        return Err(AppError::traversal(format!(
            "asset name must be a plain filename: {name:?}"
        )));
    }
    Ok(())
}

/// Split `name` into (stem, `.ext`) for suffix probing; the extension stays
/// attached through collisions (`report.pdf` → `report-2.pdf`).
fn split_name(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        // A leading dot is a hidden file, not an extension.
        Some(idx) if idx > 0 => name.split_at(idx),
        _ => (name, ""),
    }
}

/// The names an intake of `desired` tries, in order: `desired`, then
/// `stem-2.ext`, `stem-3.ext`, … up to [`MAX_NAME_PROBES`] names.
fn candidate_names(desired: &str) -> impl Iterator<Item = String> + '_ {
    let (stem, ext) = split_name(desired);
    (1..=MAX_NAME_PROBES).map(move |attempt| {
        if attempt == 1 {
            desired.to_string()
        } else {
            format!("{stem}-{attempt}{ext}")
        }
    })
}

fn no_free_name(desired: &str) -> AppError {
    AppError::io(format!(
        "no free asset name after {MAX_NAME_PROBES} probes for {desired}"
    ))
}

/// Persist `temp` under `assets_dir` as `desired`, probing `-2`, `-3`, …
/// suffixes until a name is free. `persist_noclobber` is the collision check
/// *and* the claim (`O_EXCL` semantics), so two concurrent intakes of the
/// same name can never clobber each other. Returns the winning filename.
fn persist_unique(
    mut temp: tempfile::NamedTempFile,
    assets_dir: &Path,
    desired: &str,
) -> AppResult<String> {
    temp.as_file().sync_all()?;
    for candidate in candidate_names(desired) {
        match temp.persist_noclobber(assets_dir.join(&candidate)) {
            Ok(_) => return Ok(candidate),
            Err(err) if err.error.kind() == std::io::ErrorKind::AlreadyExists => {
                temp = err.file;
            }
            Err(err) => return Err(AppError::io(err.to_string())),
        }
    }
    Err(no_free_name(desired))
}

/// [`persist_unique`] for a note in an editable local-only folder: lands the
/// staged `temp` in the folder's own `assets/` through directory descriptors
/// (no link followed, no entry replaced, the same suffix policy) and returns
/// its graph-relative path. `temp` drops afterwards and removes whatever is
/// left in staging (the original, when the bytes landed as a copy on
/// another volume).
fn persist_unique_beneath(
    temp: tempfile::NamedTempFile,
    note: &LocalOnlyEntry,
    desired: &str,
) -> AppResult<String> {
    temp.as_file().sync_all()?;
    let staged = temp
        .path()
        .file_name()
        .ok_or_else(|| AppError::io("a staged upload has no file name"))?;
    local_only_edit::land_attachment(note, staged, candidate_names(desired))?
        .ok_or_else(|| no_free_name(desired))
}

/// The staging directory for in-flight uploads (and the V1 import's asset
/// downloads): inside the graph (so the commit rename stays on one
/// filesystem) but under `.reflect/` (so the watcher, indexer, and sync never
/// see a partial file).
pub(super) fn staging_dir(root: &Path) -> AppResult<std::path::PathBuf> {
    let dir = root.join(".reflect").join("tmp");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Where an intake lands.
enum Destination {
    /// The graph's synced `assets/` directory.
    Graph(std::path::PathBuf),
    /// The note's editable local-only folder, whose own `assets/` takes it.
    LocalOnly(LocalOnlyEntry),
}

/// Where an attachment named `name` for the note at `note_path` lands,
/// generation-guarded. The note decides: an ordinary note's attachments go
/// to the graph's `assets/`; a note in an editable local-only folder keeps
/// them in that folder's `assets/` (never the synced one); a note in a
/// read-only local-only folder, or one the filesystem resolves into a
/// local-only folder by another spelling, takes none. Path-shaped names are
/// refused, and so are hidden names inside a local-only folder.
fn attachment_destination(
    state: &State<GraphState>,
    generation: u64,
    note_path: &str,
    name: &str,
) -> AppResult<Destination> {
    ensure_asset_name(name)?;
    let (root, local_only) = graph_for(state, Some(generation))?;
    match resolve_note_edit(
        &root,
        note_path,
        local_only.as_deref(),
        TargetKind::Attachment,
    )? {
        EditTarget::Graph(_) => Ok(Destination::Graph(graph_assets_dir(
            &root,
            local_only.as_deref(),
            name,
        )?)),
        EditTarget::LocalOnly(note) => {
            if name.starts_with('.') {
                return Err(AppError::traversal(format!(
                    "hidden names are never written into a local-only folder: {name}"
                )));
            }
            Ok(Destination::LocalOnly(note))
        }
    }
}

/// The graph's `assets/` directory for `name`, traversal-guarded.
fn graph_assets_dir(
    root: &Path,
    local_only: Option<&LocalOnlyFolders>,
    name: &str,
) -> AppResult<std::path::PathBuf> {
    // Resolve the target through the shared guard even though `name` is
    // already vetted — defense in depth: it canonicalizes symlink games, and
    // an `assets/` aliased into a local-only folder refuses the write.
    resolve_write(root, &format!("assets/{name}"), local_only)?;
    let dir = root.join("assets");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Land the staged `temp` at `destination` as `desired` (or its first free
/// `-2`, `-3`, … variant) and return the graph-relative path.
fn land(
    temp: tempfile::NamedTempFile,
    destination: Destination,
    desired: &str,
) -> AppResult<String> {
    match destination {
        Destination::Graph(dir) => Ok(format!("assets/{}", persist_unique(temp, &dir, desired)?)),
        Destination::LocalOnly(note) => persist_unique_beneath(temp, &note, desired),
    }
}

/// Start a streamed asset upload: creates a temp file in the graph's staging
/// dir and returns the upload id for `asset_upload_append`/`_commit`.
#[tauri::command]
pub fn asset_upload_begin(
    generation: u64,
    state: State<GraphState>,
    uploads: State<AssetUploads>,
) -> AppResult<String> {
    // Process-local sequence: ids only need to be unique within this app run
    // (the registry dies with the process), so a counter beats a uuid dep.
    static NEXT_UPLOAD_ID: AtomicU64 = AtomicU64::new(1);
    let root = root_for_generation(&state, generation)?;
    let file = tempfile::NamedTempFile::new_in(staging_dir(&root)?)?;
    let id = format!("upload-{}", NEXT_UPLOAD_ID.fetch_add(1, Ordering::Relaxed));
    lock_uploads(&uploads)?.insert(id.clone(), Upload { generation, file });
    Ok(id)
}

/// Append one chunk to an in-flight upload. The chunk is the **raw request
/// body** (`InvokeBody::Raw`) — never JSON — and the upload id arrives in the
/// `x-upload-id` header, since a raw-body invoke carries no args.
#[tauri::command]
pub fn asset_upload_append(request: Request<'_>, uploads: State<AssetUploads>) -> AppResult<()> {
    let id = request
        .headers()
        .get(UPLOAD_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| AppError::io(format!("missing {UPLOAD_ID_HEADER} header")))?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(AppError::io(
            "asset_upload_append expects a raw binary body, got JSON",
        ));
    };
    append_chunk(&uploads, id, bytes)
}

/// Append `bytes` to the in-flight upload `id` ([`asset_upload_append`]'s
/// body, which command-tier tests call directly).
pub(crate) fn append_chunk(uploads: &AssetUploads, id: &str, bytes: &[u8]) -> AppResult<()> {
    let mut uploads = lock_uploads(uploads)?;
    let upload = uploads
        .get_mut(id)
        .ok_or_else(|| AppError::not_found(format!("unknown upload: {id}")))?;
    upload.file.as_file_mut().write_all(bytes)?;
    Ok(())
}

/// Finish a streamed upload for the note at `note_path`: fsync, then move
/// the staged file to the note's attachment folder
/// ([`attachment_destination`]) under `desired_name` (or the first free
/// `-2`-suffixed variant). Returns the final graph-relative path:
/// `assets/…`, or `<folder>/assets/…` for a note in an editable local-only
/// folder.
#[tauri::command]
pub fn asset_upload_commit(
    id: String,
    desired_name: String,
    note_path: String,
    generation: u64,
    state: State<GraphState>,
    uploads: State<AssetUploads>,
) -> AppResult<String> {
    let upload = lock_uploads(&uploads)?
        .remove(&id)
        .ok_or_else(|| AppError::not_found(format!("unknown upload: {id}")))?;
    if upload.generation != generation {
        return Err(AppError::io(
            "upload was started for a different graph session; dropping it",
        ));
    }
    // Pin the root before persisting: after the file lands, a failed root
    // lookup would otherwise skip invalidation and strand a stale catalog.
    let root = root_for_generation(&state, generation)?;
    let destination = attachment_destination(&state, generation, &note_path, &desired_name)?;
    let path = land(upload.file, destination, &desired_name)?;
    super::invalidate_file_catalog(&state, &root);
    Ok(path)
}

/// Persist a staged upload at an exact target path, creating parent
/// directories. No-clobber: the temp file only ever *claims* a free path, so
/// a concurrent writer's file is never overwritten. Like [`persist_unique`],
/// fsyncs before the rename — durability is the persist helpers' job, never
/// their callers'.
fn persist_exact(temp: tempfile::NamedTempFile, target: &Path) -> AppResult<()> {
    // An iCloud-evicted file occupies its path through its `.icloud` stub
    // alone — `persist_noclobber` would happily claim the logical name and
    // collide with the re-download (Plan 21).
    if super::file_occupied(target) {
        return Err(AppError::io(format!(
            "target already exists: {}",
            target.display()
        )));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    temp.as_file().sync_all()?;
    temp.persist_noclobber(target)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

/// Finish a streamed upload at an **exact graph-relative path** — the audio
/// memo intake, where `audio-memos/<base>.<ext>` *is* the memo's identity
/// (its transcription note and daily-note backlink share the basename), so
/// the `assets/` collision renaming of [`asset_upload_commit`] would corrupt
/// it. Memo basenames carry millisecond precision; an existing file at
/// `path` is a bug and fails loudly rather than being clobbered.
#[tauri::command]
pub fn asset_upload_commit_path(
    id: String,
    path: String,
    generation: u64,
    state: State<GraphState>,
    uploads: State<AssetUploads>,
) -> AppResult<()> {
    let upload = lock_uploads(&uploads)?
        .remove(&id)
        .ok_or_else(|| AppError::not_found(format!("unknown upload: {id}")))?;
    if upload.generation != generation {
        return Err(AppError::io(
            "upload was started for a different graph session; dropping it",
        ));
    }
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let target = resolve_write(&root, &path, local_only.as_deref())?;
    persist_exact(upload.file, &target)?;
    super::invalidate_file_catalog(&state, &root);
    Ok(())
}

/// Discard an in-flight upload; dropping the temp file deletes it. Idempotent
/// — aborting an unknown id (already committed, or lost to a restart) is fine.
#[tauri::command]
pub fn asset_upload_abort(id: String, uploads: State<AssetUploads>) -> AppResult<()> {
    lock_uploads(&uploads)?.remove(&id);
    Ok(())
}

/// Copy a file the OS gave us a real path for (file picker) to the
/// attachment folder of the note at `note_path` ([`attachment_destination`])
/// under `desired_name`, with the same collision policy as uploads. The bytes
/// never cross the IPC. Returns the final graph-relative path, as
/// [`asset_upload_commit`] does.
#[tauri::command]
pub fn asset_import(
    source_path: String,
    desired_name: String,
    note_path: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<String> {
    let source = Path::new(&source_path);
    if !source.is_file() {
        return Err(AppError::not_found(format!(
            "import source is not a file: {source_path}"
        )));
    }
    let root = root_for_generation(&state, generation)?;
    // Decided before any byte is copied: a note that takes no attachments
    // gets nothing staged.
    let destination = attachment_destination(&state, generation, &note_path, &desired_name)?;
    let mut temp = tempfile::NamedTempFile::new_in(staging_dir(&root)?)?;
    std::io::copy(&mut fs::File::open(source)?, temp.as_file_mut())?;
    let path = land(temp, destination, &desired_name)?;
    super::invalidate_file_catalog(&state, &root);
    Ok(path)
}

/// Copy `source` into the graph at `target`, staging the bytes under
/// `.reflect/tmp/` so the watcher never sees a partial file.
///
/// Idempotent by construction, in both directions: a segment's path encodes
/// its session and position, so an existing target *is* that same segment,
/// and a source that is already gone means an earlier ingest moved it (or a
/// cancelled session swept it away while this capture sat in the queue).
/// Neither is a failure worth parking the capture queue behind.
fn import_exact(source: &Path, staging: &Path, target: &Path) -> AppResult<()> {
    if super::file_occupied(target) {
        return Ok(());
    }
    if !source.is_file() {
        tracing::warn!(?source, "audio memo import source is gone");
        return Ok(());
    }
    let mut temp = tempfile::NamedTempFile::new_in(staging)?;
    std::io::copy(&mut fs::File::open(source)?, temp.as_file_mut())?;
    persist_exact(temp, target)
}

/// Copy a recording the OS gave us a real path for (the iOS recorder's
/// staging directory) into `audio-memos/` at an exact path. The bytes never
/// enter webview memory, which is what makes meeting-length segments
/// affordable on a phone. The destination is fenced to `audio-memos/` like
/// `audio_memo_delete`, and the path *is* the memo's identity, so the
/// `assets/` collision renaming of [`asset_import`] would corrupt it.
#[tauri::command]
pub fn audio_memo_import(
    source_path: String,
    path: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    if !path.starts_with("audio-memos/") {
        return Err(AppError::traversal(format!(
            "not an audio memo path: {path}"
        )));
    }
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let target = resolve_write(&root, &path, local_only.as_deref())?;
    import_exact(Path::new(&source_path), &staging_dir(&root)?, &target)?;
    super::invalidate_file_catalog(&state, &root);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::io::bootstrap;
    use tempfile::tempdir;

    fn temp_in(dir: &Path, contents: &[u8]) -> tempfile::NamedTempFile {
        let mut file = tempfile::NamedTempFile::new_in(dir).unwrap();
        file.write_all(contents).unwrap();
        file
    }

    #[test]
    fn asset_names_must_be_plain_filenames() {
        assert!(ensure_asset_name("report.pdf").is_ok());
        assert!(ensure_asset_name(".hidden").is_ok());
        assert!(ensure_asset_name("").is_err());
        assert!(ensure_asset_name("a/b.pdf").is_err());
        assert!(ensure_asset_name("a\\b.pdf").is_err());
        assert!(ensure_asset_name(".").is_err());
        assert!(ensure_asset_name("..").is_err());
    }

    #[test]
    fn split_keeps_extension_and_treats_leading_dot_as_stem() {
        assert_eq!(split_name("report.pdf"), ("report", ".pdf"));
        assert_eq!(split_name("archive.tar.gz"), ("archive.tar", ".gz"));
        assert_eq!(split_name("README"), ("README", ""));
        assert_eq!(split_name(".gitignore"), (".gitignore", ""));
    }

    #[test]
    fn persist_takes_the_desired_name_when_free() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let assets = graph.path().join("assets");
        let temp = temp_in(graph.path(), b"pdf bytes");
        let name = persist_unique(temp, &assets, "report.pdf").unwrap();
        assert_eq!(name, "report.pdf");
        assert_eq!(fs::read(assets.join("report.pdf")).unwrap(), b"pdf bytes");
    }

    #[test]
    fn persist_probes_numbered_suffixes_on_collision() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let assets = graph.path().join("assets");
        fs::write(assets.join("report.pdf"), b"first").unwrap();
        fs::write(assets.join("report-2.pdf"), b"second").unwrap();
        let temp = temp_in(graph.path(), b"third");
        let name = persist_unique(temp, &assets, "report.pdf").unwrap();
        assert_eq!(name, "report-3.pdf");
        // Nothing existing was touched.
        assert_eq!(fs::read(assets.join("report.pdf")).unwrap(), b"first");
        assert_eq!(fs::read(assets.join("report-2.pdf")).unwrap(), b"second");
    }

    #[test]
    fn persist_suffixes_extensionless_names() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let assets = graph.path().join("assets");
        fs::write(assets.join("README"), b"first").unwrap();
        let temp = temp_in(graph.path(), b"second");
        assert_eq!(persist_unique(temp, &assets, "README").unwrap(), "README-2");
    }

    #[test]
    fn persist_exact_creates_parents_and_writes_the_target() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let temp = temp_in(graph.path(), b"opus bytes");
        let target = graph
            .path()
            .join("audio-memos/audio-memo-2026-07-19-090000-000.m4a");
        persist_exact(temp, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"opus bytes");
    }

    #[test]
    fn persist_exact_never_clobbers_an_existing_file() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let target = graph.path().join("audio-memos/memo.m4a");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"first").unwrap();
        let temp = temp_in(graph.path(), b"second");
        assert!(persist_exact(temp, &target).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"first");
    }

    #[test]
    fn import_copies_the_source_to_the_exact_target() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let source = temp_in(graph.path(), b"segment bytes");
        let target = graph.path().join("audio-memos/memo.part-001.m4a");
        import_exact(source.path(), &staging_dir(graph.path()).unwrap(), &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"segment bytes");
    }

    #[test]
    fn import_skips_a_source_that_is_already_gone() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let target = graph.path().join("audio-memos/memo.part-001.m4a");
        import_exact(
            &graph.path().join("staging/vanished.m4a"),
            &staging_dir(graph.path()).unwrap(),
            &target,
        )
        .unwrap();
        assert!(!target.exists());
    }

    #[test]
    fn import_leaves_an_existing_target_alone() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let target = graph.path().join("audio-memos/memo.part-001.m4a");
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(&target, b"already landed").unwrap();
        let source = temp_in(graph.path(), b"second copy");
        import_exact(source.path(), &staging_dir(graph.path()).unwrap(), &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"already landed");
    }

    #[test]
    fn staging_dir_lives_under_reflect() {
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        let dir = staging_dir(graph.path()).unwrap();
        assert!(dir.starts_with(graph.path().join(".reflect")));
        assert!(dir.is_dir());
    }
}
