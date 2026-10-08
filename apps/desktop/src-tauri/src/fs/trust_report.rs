//! The wiki trust report: a JSON file an agent harness writes into the graph,
//! which Reflect reads and displays but never computes. The path is
//! the user's setting, graph-relative, and may sit in a hidden folder such as
//! `.harness/`; it never names Reflect's own `.reflect/` state or `.git/`.

use std::path::Path;

use serde::Serialize;
use tauri::State;

use super::resolve::resolve;
use super::{graph_for, GraphState};
use crate::error::{AppError, AppResult};

/// The largest report Reflect reads; a larger file is refused, not truncated.
const MAX_REPORT_BYTES: u64 = 16 * 1024 * 1024;

/// One read of the trust report.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustReportRead {
    /// Identifies this version of the file (see [`version_stamp`]).
    pub stamp: String,
    /// The file's text; `None` when the stamp equals the caller's
    /// `known_stamp`, so polling never re-sends an unchanged report.
    pub contents: Option<String>,
}

/// The shared path rules ([`reflect_graph_paths::is_wiki_trust_report_path`])
/// on top of [`resolve`]'s graph-root guard.
fn ensure_report_path(rel: &str) -> AppResult<()> {
    if reflect_graph_paths::is_wiki_trust_report_path(rel) {
        Ok(())
    } else {
        Err(AppError::traversal(format!(
            "not a trust report path (a .json file in the graph, outside .reflect/ and .git/): {rel:?}"
        )))
    }
}

#[cfg(unix)]
fn read_bounded(root: &Path, rel: &str) -> AppResult<Vec<u8>> {
    // The no-follow walk below the canonical root: a symlink swapped in after
    // `resolve` checked the path cannot redirect the read, and an evicted
    // iCloud copy is reported offline instead of downloaded.
    super::device::read_bounded_source(&root.canonicalize()?, Path::new(rel), MAX_REPORT_BYTES)
}

/// `target`, canonical, must still be a report path inside the graph.
fn ensure_landed(root: &Path, target: &Path, rel: &str) -> AppResult<()> {
    let landed = target.strip_prefix(root.canonicalize()?).map_err(|_| {
        AppError::traversal(format!("trust report resolves outside the graph: {rel:?}"))
    })?;
    ensure_report_path(&landed.to_string_lossy().replace('\\', "/"))
}

/// Where the report's folder really lands, links and the filesystem's own
/// name folding resolved (a case-insensitive volume reads `.Reflect` or
/// `.reﬂect` as `.reflect`). Checked before anything touches the file, so it
/// also guards iCloud download requests; `false` when the folder is absent.
fn folder_lands(root: &Path, abs: &Path, rel: &str) -> AppResult<bool> {
    let (Some(folder), Some(name)) = (abs.parent(), abs.file_name()) else {
        return Err(AppError::traversal(format!(
            "not a trust report path: {rel:?}"
        )));
    };
    match folder.canonicalize() {
        Ok(folder) => ensure_landed(root, &folder.join(name), rel).map(|()| true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

#[cfg(not(unix))]
fn read_bounded(root: &Path, rel: &str) -> AppResult<Vec<u8>> {
    use std::io::Read;
    // Without a no-follow walk, check the file itself where it really lands.
    let target = resolve(root, rel)?.canonicalize()?;
    ensure_landed(root, &target, rel)?;
    let mut bytes = Vec::new();
    std::fs::File::open(&target)?
        .take(MAX_REPORT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REPORT_BYTES {
        return Err(AppError::unsupported(format!(
            "trust report exceeds {MAX_REPORT_BYTES} bytes"
        )));
    }
    Ok(bytes)
}

/// Identifies one version of the report: modification time in nanoseconds,
/// size, and (on Unix) the inode, so an atomic replace reads as new even
/// within the clock's resolution or on a coarse-timestamp filesystem.
fn version_stamp(meta: &std::fs::Metadata) -> String {
    let nanos = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |since| since.as_nanos());
    #[cfg(unix)]
    let inode = std::os::unix::fs::MetadataExt::ino(meta);
    #[cfg(not(unix))]
    let inode = 0_u64;
    format!("{nanos}:{}:{inode}", meta.len())
}

/// A report whose bytes are not on this device yet; the next poll reads it.
fn downloading() -> AppError {
    AppError::io("the trust report is still downloading from iCloud")
}

/// Read the report at graph-relative `rel`: `None` when no file is there.
fn read_report(
    root: &Path,
    rel: &str,
    known_stamp: Option<&str>,
) -> AppResult<Option<TrustReportRead>> {
    ensure_report_path(rel)?;
    let abs = resolve(root, rel)?;
    if !folder_lands(root, &abs, rel)? {
        return Ok(None);
    }
    let meta = match std::fs::symlink_metadata(&abs) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            // Older iCloud keeps an evicted file as a `.name.icloud` stub
            // beside the absent path; nothing downloads a report on its own.
            if reflect_graph_paths::eviction_placeholder(&abs).is_some_and(|stub| stub.exists()) {
                crate::icloud::storage::request_download(&abs);
                return Err(downloading());
            }
            return Ok(None);
        }
        Err(err) => return Err(err.into()),
    };
    if !meta.is_file() {
        return Err(AppError::invalid(format!(
            "the trust report is not a regular file: {rel:?}"
        )));
    }
    let stamp = version_stamp(&meta);
    if known_stamp == Some(stamp.as_str()) {
        return Ok(Some(TrustReportRead {
            stamp,
            contents: None,
        }));
    }
    if meta.len() > MAX_REPORT_BYTES {
        return Err(AppError::unsupported(format!(
            "trust report exceeds {MAX_REPORT_BYTES} bytes"
        )));
    }
    // A version another device wrote may still be an iCloud placeholder:
    // nothing downloads it on its own, so ask, and the next poll reads it.
    if reflect_graph_paths::is_dataless(&meta) {
        crate::icloud::storage::request_download(&abs);
        return Err(downloading());
    }
    let contents = String::from_utf8(read_bounded(root, rel)?)
        .map_err(|_| AppError::invalid(format!("the trust report is not UTF-8: {rel:?}")))?;
    Ok(Some(TrustReportRead {
        stamp,
        contents: Some(contents),
    }))
}

/// Read the open graph's wiki trust report at `path`, pinned to `generation`.
/// `known_stamp` is the stamp of the copy the caller holds; a match returns
/// no contents.
#[tauri::command]
pub async fn wiki_trust_report_read(
    path: String,
    known_stamp: Option<String>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<Option<TrustReportRead>> {
    let (root, _) = graph_for(&state, Some(generation))?;
    crate::blocking::run_blocking(move || read_report(&root, &path, known_stamp.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn graph() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn reads_a_report_in_a_hidden_folder() {
        let dir = graph();
        fs::create_dir_all(dir.path().join(".harness")).unwrap();
        fs::write(
            dir.path().join(".harness/wiki-trust.json"),
            "{\"version\":1}",
        )
        .unwrap();
        let read = read_report(dir.path(), ".harness/wiki-trust.json", None)
            .unwrap()
            .unwrap();
        assert_eq!(read.contents.as_deref(), Some("{\"version\":1}"));
        assert!(read.stamp.contains(":13:"));
    }

    #[test]
    fn a_missing_report_is_none() {
        let dir = graph();
        assert_eq!(
            read_report(dir.path(), "_meta/wiki-trust.json", None).unwrap(),
            None
        );
    }

    #[test]
    fn an_unchanged_report_returns_no_contents() {
        let dir = graph();
        fs::write(dir.path().join("trust.json"), "{}").unwrap();
        let first = read_report(dir.path(), "trust.json", None)
            .unwrap()
            .unwrap();
        let again = read_report(dir.path(), "trust.json", Some(&first.stamp))
            .unwrap()
            .unwrap();
        assert_eq!(again.contents, None);
        assert_eq!(again.stamp, first.stamp);
    }

    #[test]
    fn a_same_time_rewrite_of_another_size_is_new() {
        let dir = graph();
        fs::write(dir.path().join("trust.json"), "{}").unwrap();
        let first = read_report(dir.path(), "trust.json", None)
            .unwrap()
            .unwrap();
        let time = fs::metadata(dir.path().join("trust.json"))
            .unwrap()
            .modified()
            .unwrap();
        fs::write(dir.path().join("trust.json"), "{\"a\":1}").unwrap();
        fs::File::options()
            .write(true)
            .open(dir.path().join("trust.json"))
            .unwrap()
            .set_modified(time)
            .unwrap();
        let again = read_report(dir.path(), "trust.json", Some(&first.stamp))
            .unwrap()
            .unwrap();
        assert_eq!(again.contents.as_deref(), Some("{\"a\":1}"));
    }

    #[cfg(unix)]
    #[test]
    fn an_atomic_replace_of_the_same_size_and_time_is_new() {
        let dir = graph();
        fs::write(dir.path().join("trust.json"), "{\"a\":1}").unwrap();
        let first = read_report(dir.path(), "trust.json", None)
            .unwrap()
            .unwrap();
        let time = fs::metadata(dir.path().join("trust.json"))
            .unwrap()
            .modified()
            .unwrap();
        fs::write(dir.path().join("trust.tmp"), "{\"a\":2}").unwrap();
        fs::File::options()
            .write(true)
            .open(dir.path().join("trust.tmp"))
            .unwrap()
            .set_modified(time)
            .unwrap();
        fs::rename(dir.path().join("trust.tmp"), dir.path().join("trust.json")).unwrap();
        let again = read_report(dir.path(), "trust.json", Some(&first.stamp))
            .unwrap()
            .unwrap();
        assert_eq!(again.contents.as_deref(), Some("{\"a\":2}"));
    }

    // A case-insensitive volume (the macOS default) folds `ﬂ` to `fl`.
    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_a_name_the_volume_folds_into_reflect_state() {
        let dir = graph();
        fs::create_dir_all(dir.path().join(".reflect")).unwrap();
        fs::write(dir.path().join(".reflect/trust.json"), "{}").unwrap();
        let ligature = ".re\u{FB02}ect/trust.json";
        assert!(reflect_graph_paths::is_wiki_trust_report_path(ligature));
        assert!(read_report(dir.path(), ligature, None).is_err());
    }

    #[test]
    fn refuses_a_directory_at_the_path() {
        let dir = graph();
        fs::create_dir_all(dir.path().join("trust.json")).unwrap();
        assert!(read_report(dir.path(), "trust.json", None).is_err());
    }

    #[test]
    fn refuses_invalid_utf8() {
        let dir = graph();
        fs::write(dir.path().join("trust.json"), [0xff, 0xfe]).unwrap();
        assert!(read_report(dir.path(), "trust.json", None).is_err());
    }

    #[test]
    fn refuses_a_report_over_the_size_limit() {
        let dir = graph();
        let file = fs::File::create(dir.path().join("trust.json")).unwrap();
        file.set_len(MAX_REPORT_BYTES + 1).unwrap();
        assert!(read_report(dir.path(), "trust.json", None).is_err());
    }

    #[test]
    fn an_icloud_stub_is_downloading_not_missing() {
        let dir = graph();
        fs::create_dir_all(dir.path().join(".harness")).unwrap();
        fs::write(dir.path().join(".harness/.wiki-trust.json.icloud"), "").unwrap();
        let err = read_report(dir.path(), ".harness/wiki-trust.json", None).unwrap_err();
        assert!(format!("{err:?}").contains("downloading"), "{err:?}");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_out_of_the_graph() {
        let dir = graph();
        let outside = graph();
        fs::write(outside.path().join("secret.json"), "{}").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.json"),
            dir.path().join("trust.json"),
        )
        .unwrap();
        assert!(read_report(dir.path(), "trust.json", None).is_err());
    }
}
