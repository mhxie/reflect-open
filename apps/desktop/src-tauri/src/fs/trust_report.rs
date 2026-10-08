//! The wiki trust report: a JSON file an agent harness writes into the graph,
//! which Reflect reads and displays but never computes (Plan 30). The path is
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
    /// The file's modification time (epoch ms), when the platform has one.
    pub modified_ms: Option<u64>,
    /// The file's text; `None` when it is unchanged since the caller's
    /// `known_modified_ms`, so polling never re-sends an unchanged report.
    pub contents: Option<String>,
}

/// Lexical rules for the configured path, on top of [`resolve`]'s graph-root
/// guard: a `.json` file outside Reflect's runtime state and Git's.
fn ensure_report_path(rel: &str) -> AppResult<()> {
    if rel.contains('\\') {
        return Err(AppError::traversal(format!(
            "a trust report path uses forward slashes: {rel:?}"
        )));
    }
    let first = rel.split('/').next().unwrap_or_default();
    if first.eq_ignore_ascii_case(".reflect") || first.eq_ignore_ascii_case(".git") {
        return Err(AppError::traversal(format!(
            "a trust report cannot live in {first}/: {rel:?}"
        )));
    }
    if !rel.to_ascii_lowercase().ends_with(".json") {
        return Err(AppError::invalid(format!(
            "a trust report is a .json file: {rel:?}"
        )));
    }
    Ok(())
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
    let mut bytes = Vec::new();
    std::fs::File::open(resolve(root, rel)?)?
        .take(MAX_REPORT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_REPORT_BYTES {
        return Err(AppError::unsupported(format!(
            "trust report exceeds {MAX_REPORT_BYTES} bytes"
        )));
    }
    Ok(bytes)
}

/// Read the report at graph-relative `rel`: `None` when no file is there.
fn read_report(
    root: &Path,
    rel: &str,
    known_modified_ms: Option<u64>,
) -> AppResult<Option<TrustReportRead>> {
    ensure_report_path(rel)?;
    let abs = resolve(root, rel)?;
    let meta = match std::fs::symlink_metadata(&abs) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err.into()),
    };
    if !meta.is_file() {
        return Err(AppError::invalid(format!(
            "the trust report is not a regular file: {rel:?}"
        )));
    }
    let modified_ms = io::modified_ms(&meta);
    if modified_ms.is_some() && modified_ms == known_modified_ms {
        return Ok(Some(TrustReportRead {
            modified_ms,
            contents: None,
        }));
    }
    if meta.len() > MAX_REPORT_BYTES {
        return Err(AppError::unsupported(format!(
            "trust report exceeds {MAX_REPORT_BYTES} bytes"
        )));
    }
    let contents = String::from_utf8(read_bounded(root, rel)?)
        .map_err(|_| AppError::invalid(format!("the trust report is not UTF-8: {rel:?}")))?;
    Ok(Some(TrustReportRead {
        modified_ms,
        contents: Some(contents),
    }))
}

/// Read the open graph's wiki trust report at `path`, pinned to `generation`.
/// `known_modified_ms` is the modification time of the copy the caller holds;
/// a match returns no contents.
#[tauri::command]
pub async fn wiki_trust_report_read(
    path: String,
    known_modified_ms: Option<u64>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<Option<TrustReportRead>> {
    let (root, _) = graph_for(&state, Some(generation))?;
    crate::blocking::run_blocking(move || read_report(&root, &path, known_modified_ms)).await
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
        fs::write(dir.path().join(".harness/wiki-trust.json"), "{\"version\":1}").unwrap();
        let read = read_report(dir.path(), ".harness/wiki-trust.json", None)
            .unwrap()
            .unwrap();
        assert_eq!(read.contents.as_deref(), Some("{\"version\":1}"));
        assert!(read.modified_ms.is_some());
    }

    #[test]
    fn a_missing_report_is_none() {
        let dir = graph();
        assert_eq!(read_report(dir.path(), "_meta/wiki-trust.json", None).unwrap(), None);
    }

    #[test]
    fn an_unchanged_report_returns_no_contents() {
        let dir = graph();
        fs::write(dir.path().join("trust.json"), "{}").unwrap();
        let first = read_report(dir.path(), "trust.json", None).unwrap().unwrap();
        let again = read_report(dir.path(), "trust.json", first.modified_ms)
            .unwrap()
            .unwrap();
        assert_eq!(again.contents, None);
        assert_eq!(again.modified_ms, first.modified_ms);
    }

    #[test]
    fn refuses_paths_outside_the_report_rules() {
        let dir = graph();
        for rel in [
            "../outside.json",
            "/etc/trust.json",
            ".reflect/index.json",
            ".REFLECT/x.json",
            ".git/trust.json",
            "notes/trust.md",
            "a\\b.json",
        ] {
            assert!(read_report(dir.path(), rel, None).is_err(), "{rel} was accepted");
        }
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
