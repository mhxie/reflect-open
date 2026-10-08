//! The wiki trust report: a JSON file an agent harness writes into the graph,
//! which Reflect reads and displays but never computes. The path is
//! the user's setting, graph-relative, and may sit in a hidden folder such as
//! `.harness/`; it never names Reflect's own `.reflect/` state or `.git/`.

use std::path::Path;

use serde::Serialize;
use tauri::State;

use super::resolve::resolve;
use super::{graph_for, io, GraphState};
use crate::error::{AppError, AppResult};

/// The largest report Reflect reads; a larger file is refused, not truncated.
const MAX_REPORT_BYTES: u64 = 16 * 1024 * 1024;

/// One read of the trust report.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrustReportRead {
    /// Identifies this version of the file: its modification time and size.
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

#[cfg(not(unix))]
fn read_bounded(root: &Path, rel: &str) -> AppResult<Vec<u8>> {
    use std::io::Read;
    // Without a no-follow walk, re-check where the path really lands: inside
    // the root and outside Reflect's and Git's state, links resolved.
    let canonical_root = root.canonicalize()?;
    let target = resolve(root, rel)?.canonicalize()?;
    let landed = target.strip_prefix(&canonical_root).map_err(|_| {
        AppError::traversal(format!("trust report resolves outside the graph: {rel:?}"))
    })?;
    let landed = landed.to_string_lossy().replace('\\', "/");
    ensure_report_path(&landed)?;
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
    // Size joins the time so a rewrite within the clock's resolution (or on a
    // coarse filesystem) still reads as a new version.
    let stamp = format!(
        "{}:{}",
        io::modified_ms(&meta).map_or_else(String::new, |ms| ms.to_string()),
        meta.len()
    );
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
        assert!(read.stamp.ends_with(":13"));
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
        assert!(read_report(dir.path(), ".harness/wiki-trust.json", None).is_err());
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
