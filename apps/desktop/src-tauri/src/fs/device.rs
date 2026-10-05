//! Generation-pinned reads and rebuildable OCR cache for on-device models.

use serde::Serialize;
#[cfg(not(unix))]
use std::io::Read;
use tauri::State;

use super::{ensure_shareable_note_path, graph_for, io, resolve_read, GraphState};
use crate::error::{AppError, AppResult};

#[cfg(unix)]
fn read_bounded_source(
    base: &std::path::Path,
    rest: &std::path::Path,
    max_bytes: u64,
) -> AppResult<Vec<u8>> {
    use super::beneath::{open_dir_beneath, read_bounded_beneath, BeneathError};
    let parent = rest
        .parent()
        .ok_or_else(|| AppError::traversal("missing source directory"))?;
    let name = rest
        .file_name()
        .ok_or_else(|| AppError::traversal("missing source filename"))?;
    let directory = open_dir_beneath(base, parent, false)?;
    match read_bounded_beneath(&directory, name, max_bytes) {
        Ok(read) => Ok(read.bytes),
        Err(BeneathError::Io(error)) if error.kind() == std::io::ErrorKind::Unsupported => Err(
            AppError::unsupported(format!("source exceeds {} bytes", max_bytes)),
        ),
        Err(error) => Err(error.into()),
    }
}

/// Read a bounded model-facing source without following links after resolution.
pub(super) fn read_source_for_device(target: &super::resolve::ReadTarget) -> AppResult<Vec<u8>> {
    #[cfg(unix)]
    {
        read_bounded_source(&target.base, &target.rest, 20 * 1024 * 1024)
    }
    #[cfg(not(unix))]
    {
        let _ = target;
        Err(AppError::unsupported(
            "On-device source reads require macOS or Linux.",
        ))
    }
}

/// Whether this platform has the no-follow directory writes required for local OCR.
#[tauri::command]
pub async fn asset_ocr_supported(generation: u64, state: State<'_, GraphState>) -> AppResult<bool> {
    graph_for(&state, Some(generation))?;
    Ok(cfg!(unix))
}

/// A model-facing Markdown read, with local-only status decided by Rust.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceNoteRead {
    pub content: String,
    pub local_only: bool,
}

/// Read visible Markdown for a verified on-device model, allowing approved local-only sources.
#[tauri::command]
pub async fn note_read_for_device(
    path: String,
    generation: Option<u64>,
    state: State<'_, GraphState>,
) -> AppResult<DeviceNoteRead> {
    ensure_shareable_note_path(&path)?;
    let (root, local_only) = graph_for(&state, generation)?;
    let target = resolve_read(&root, &path, local_only.as_deref())?;
    crate::blocking::run_blocking(move || {
        let contents = String::from_utf8(read_source_for_device(&target)?)
            .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
        Ok(DeviceNoteRead {
            content: io::normalize_note_text(contents),
            local_only: target.local_only,
        })
    })
    .await
}

/// Read a supported image or PDF for on-device OCR without following unapproved links.
#[tauri::command]
pub async fn asset_read_for_device(
    path: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<tauri::ipc::Response> {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if !reflect_graph_paths::is_safe_visible(&path)
        || !matches!(
            extension.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "pdf"
        )
    {
        return Err(AppError::traversal("not a supported OCR attachment"));
    }
    let (root, local_only) = graph_for(&state, Some(generation))?;
    let target = resolve_read(&root, &path, local_only.as_deref())?;
    crate::blocking::run_blocking(move || {
        Ok(tauri::ipc::Response::new(read_source_for_device(&target)?))
    })
    .await
}

fn cache_relative_path(key: &str) -> AppResult<String> {
    if key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::traversal(
            "OCR cache key must be a SHA-256 digest",
        ));
    }
    Ok(format!(".reflect/asset-ocr/{key}.json"))
}

/// List only OCR cache digest keys, for startup and wake-time source validation.
#[tauri::command]
pub async fn asset_ocr_cache_keys(
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<Vec<String>> {
    let (root, _) = graph_for(&state, Some(generation))?;
    crate::blocking::run_blocking(move || cache_keys(&root)).await
}

#[cfg(unix)]
fn cache_keys(root: &std::path::Path) -> AppResult<Vec<String>> {
    use super::beneath::{names_beneath, open_dir_beneath, BeneathError};
    let directory = match open_dir_beneath(root, std::path::Path::new(".reflect/asset-ocr"), false)
    {
        Ok(directory) => directory,
        Err(BeneathError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Vec::new())
        }
        Err(error) => return Err(error.into()),
    };
    Ok(names_beneath(&directory)?
        .into_iter()
        .filter_map(|(name, _)| {
            let key = name.to_str()?.strip_suffix(".json")?;
            cache_relative_path(key).ok().map(|_| key.to_string())
        })
        .collect())
}

#[cfg(not(unix))]
fn cache_keys(_root: &std::path::Path) -> AppResult<Vec<String>> {
    Ok(Vec::new())
}

/// Read a completed OCR cache entry from this graph's private runtime directory.
#[tauri::command]
pub async fn asset_ocr_cache_read(
    key: String,
    generation: Option<u64>,
    state: State<'_, GraphState>,
) -> AppResult<String> {
    let relative = cache_relative_path(&key)?;
    let (root, _) = graph_for(&state, generation)?;
    crate::blocking::run_blocking(move || {
        #[cfg(unix)]
        {
            let bytes = read_bounded_source(&root, std::path::Path::new(&relative), 1024 * 1024)?;
            Ok(String::from_utf8(bytes)
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?)
        }
        #[cfg(not(unix))]
        {
            let file = io::open_no_follow(&root, std::path::Path::new(&relative))?;
            let mut contents = String::new();
            file.take(1024 * 1024 + 1).read_to_string(&mut contents)?;
            if contents.len() > 1024 * 1024 {
                return Err(AppError::unsupported("OCR cache exceeds 1 MiB"));
            }
            Ok(contents)
        }
    })
    .await
}

/// Atomically replace a completed OCR result; never writes into source folders.
#[tauri::command]
pub async fn asset_ocr_cache_write(
    key: String,
    contents: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<()> {
    let relative = cache_relative_path(&key)?;
    if contents.len() > 1024 * 1024 {
        return Err(AppError::unsupported("OCR cache exceeds 1 MiB"));
    }
    let (root, _) = graph_for(&state, Some(generation))?;
    crate::blocking::run_blocking(move || write_cache(&root, &relative, &contents)).await
}

#[cfg(unix)]
fn write_cache(root: &std::path::Path, relative: &str, contents: &str) -> AppResult<()> {
    use super::beneath::{open_dir_beneath, write_current_beneath, Persisted};
    let root_dir = open_dir_beneath(root, std::path::Path::new(""), false)?;
    let cache_dir = open_dir_beneath(root, std::path::Path::new(".reflect/asset-ocr"), true)?;
    let name = std::path::Path::new(relative)
        .file_name()
        .ok_or_else(|| AppError::traversal("invalid OCR cache path"))?;
    match write_current_beneath(&root_dir, &cache_dir, name, contents.as_bytes())? {
        Persisted::Created(_) | Persisted::Replaced(_) => Ok(()),
        Persisted::Collision | Persisted::ChangedOnDisk => Err(AppError::invalid(
            "OCR cache changed during the write; retry.",
        )),
    }
}

#[cfg(not(unix))]
fn write_cache(_root: &std::path::Path, _relative: &str, _contents: &str) -> AppResult<()> {
    Err(AppError::unsupported(
        "Local OCR requires no-follow runtime writes, currently available on macOS and Linux.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tauri::Manager;

    type MockApp = tauri::App<tauri::test::MockRuntime>;

    fn open_graph() -> (MockApp, tempfile::TempDir) {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(GraphState::default());
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        io::bootstrap(&root).unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(
            root.join("notes/private.md"),
            "---\nprivate: true\n---\nSecret",
        )
        .unwrap();
        let state: State<GraphState> = app.state();
        let mut inner = state.0.lock().unwrap();
        inner.generation = 7;
        inner.root = Some(root);
        drop(inner);
        (app, directory)
    }

    #[cfg(unix)]
    #[test]
    fn serves_private_markdown_only_in_the_pinned_graph() {
        let (app, _directory) = open_graph();
        let read = tauri::async_runtime::block_on(note_read_for_device(
            "notes/private.md".into(),
            Some(7),
            app.state(),
        ))
        .unwrap();
        assert!(read.content.contains("Secret"));
        assert!(!read.local_only);
        assert!(tauri::async_runtime::block_on(note_read_for_device(
            "notes/private.md".into(),
            Some(6),
            app.state(),
        ))
        .is_err());
        for path in [
            ".git/config.md",
            ".reflect/hidden.md",
            "notes/private.txt",
            "../escape.md",
        ] {
            assert!(tauri::async_runtime::block_on(note_read_for_device(
                path.into(),
                Some(7),
                app.state(),
            ))
            .is_err());
        }
    }

    #[cfg(unix)]
    #[test]
    fn preserves_approved_local_only_provenance_and_refuses_other_links() {
        use std::os::unix::fs::symlink;
        let (app, directory) = open_graph();
        let raw = tempfile::tempdir().unwrap();
        let raw_root = raw.path().canonicalize().unwrap();
        fs::create_dir_all(raw_root.join("secure")).unwrap();
        fs::write(raw_root.join("secure/scan.md"), "Local secret").unwrap();
        symlink(raw_root.join("secure"), directory.path().join("secure")).unwrap();
        symlink(
            raw_root.join("secure/scan.md"),
            directory.path().join("notes/link.md"),
        )
        .unwrap();
        let state: State<GraphState> = app.state();
        state.0.lock().unwrap().local_only = Some(std::sync::Arc::new(
            reflect_graph_paths::LocalOnlyFolders::new(["secure"], Some(&raw_root)).unwrap(),
        ));
        let read = tauri::async_runtime::block_on(note_read_for_device(
            "secure/scan.md".into(),
            Some(7),
            app.state(),
        ))
        .unwrap();
        assert!(read.local_only);
        assert_eq!(read.content, "Local secret");
        assert!(tauri::async_runtime::block_on(note_read_for_device(
            "notes/link.md".into(),
            Some(7),
            app.state(),
        ))
        .is_err());
    }

    #[test]
    #[cfg(unix)]
    fn confines_atomic_cache_writes_to_digest_keys_and_the_current_graph() {
        let (app, directory) = open_graph();
        let key = "a".repeat(64);
        for contents in ["first", "second"] {
            tauri::async_runtime::block_on(asset_ocr_cache_write(
                key.clone(),
                contents.into(),
                7,
                app.state(),
            ))
            .unwrap();
        }
        assert_eq!(
            tauri::async_runtime::block_on(
                asset_ocr_cache_read(key.clone(), Some(7), app.state(),)
            )
            .unwrap(),
            "second"
        );
        assert_eq!(
            tauri::async_runtime::block_on(asset_ocr_cache_keys(7, app.state())).unwrap(),
            vec![key.clone()]
        );
        assert!(directory
            .path()
            .join(format!(".reflect/asset-ocr/{key}.json"))
            .is_file());
        for (bad_key, generation) in [("../notes/private.md".to_string(), 7), (key.clone(), 6)] {
            assert!(tauri::async_runtime::block_on(asset_ocr_cache_write(
                bad_key,
                "bad".into(),
                generation,
                app.state(),
            ))
            .is_err());
        }
        assert!(tauri::async_runtime::block_on(asset_ocr_cache_write(
            key,
            "x".repeat(1024 * 1024 + 1),
            7,
            app.state(),
        ))
        .is_err());
        assert!(
            fs::read_to_string(directory.path().join("notes/private.md"))
                .unwrap()
                .contains("Secret")
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_cache_directory_links() {
        use std::os::unix::fs::symlink;
        let (app, directory) = open_graph();
        let elsewhere = tempfile::tempdir().unwrap();
        symlink(
            elsewhere.path(),
            directory.path().join(".reflect/asset-ocr"),
        )
        .unwrap();
        assert!(tauri::async_runtime::block_on(asset_ocr_cache_write(
            "a".repeat(64),
            "secret".into(),
            7,
            app.state(),
        ))
        .is_err());
        assert!(fs::read_dir(elsewhere.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn never_publishes_ocr_through_an_in_graph_directory_link() {
        use std::os::unix::fs::symlink;
        let (app, directory) = open_graph();
        fs::create_dir_all(directory.path().join("assets")).unwrap();
        symlink("../assets", directory.path().join(".reflect/asset-ocr")).unwrap();
        assert!(tauri::async_runtime::block_on(asset_ocr_cache_write(
            "a".repeat(64),
            "Private OCR".into(),
            7,
            app.state(),
        ))
        .is_err());
        assert!(fs::read_dir(directory.path().join("assets"))
            .unwrap()
            .next()
            .is_none());
        assert!(tauri::async_runtime::block_on(asset_ocr_cache_keys(7, app.state())).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_planted_after_source_resolution_and_bounds_binary_reads() {
        use std::os::unix::fs::symlink;
        let (_app, directory) = open_graph();
        let root = directory.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("assets")).unwrap();
        let source = root.join("assets/scan.png");
        fs::write(&source, b"image").unwrap();
        let target = resolve_read(&root, "assets/scan.png", None).unwrap();
        assert_eq!(read_source_for_device(&target).unwrap(), b"image");

        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("scan.png"), b"Private image").unwrap();
        fs::remove_file(&source).unwrap();
        symlink(outside.path().join("scan.png"), &source).unwrap();
        assert!(read_source_for_device(&target).is_err());
        fs::remove_file(&source).unwrap();
        fs::write(&source, b"image").unwrap();
        fs::rename(root.join("assets"), root.join("original-assets")).unwrap();
        symlink(outside.path(), root.join("assets")).unwrap();
        assert!(read_source_for_device(&target).is_err());
        fs::remove_file(root.join("assets")).unwrap();
        fs::rename(root.join("original-assets"), root.join("assets")).unwrap();

        fs::File::create(&source)
            .unwrap()
            .set_len(20 * 1024 * 1024 + 1)
            .unwrap();
        assert!(matches!(
            read_source_for_device(&target),
            Err(AppError::Unsupported { .. })
        ));
    }

    #[cfg(not(unix))]
    #[test]
    fn refuses_unsupported_runtime_writes_without_creating_a_cache() {
        let (app, directory) = open_graph();
        assert!(!tauri::async_runtime::block_on(asset_ocr_supported(7, app.state())).unwrap());
        assert!(tauri::async_runtime::block_on(asset_ocr_cache_write(
            "a".repeat(64),
            "Private OCR".into(),
            7,
            app.state(),
        ))
        .is_err());
        assert!(!directory.path().join(".reflect/asset-ocr").exists());
        assert!(matches!(
            tauri::async_runtime::block_on(note_read_for_device(
                "notes/private.md".into(),
                Some(7),
                app.state()
            )),
            Err(AppError::Unsupported { .. })
        ));
    }
}
