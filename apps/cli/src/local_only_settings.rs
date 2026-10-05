//! The desktop app's local-only folder configuration, read straight from its
//! settings document. The CLI normally takes the folder names from the
//! index's record (`index::local_only_folders`); with no index at all there
//! is no record, and a *real* directory configured as local-only would
//! otherwise be read like any other. This is that fallback.
//!
//! The document lives at `<config dir>/reflect-open/settings.json` (the
//! desktop's `settings::store_path`) under `"localOnlyFolders"`, keyed by
//! graph root (`fs::local_only` in the desktop). Only the deny side matters
//! here: every listed name is kept, valid or not. Anything that cannot be
//! read or understood refuses (exit 3) — which notes are local-only is then
//! unknown.

use std::fs;
use std::path::{Path, PathBuf};

use reflect_graph_paths::LocalOnlyFolders;
use serde_json::Value;

use crate::error::CliError;

/// The settings-document key holding every graph's local-only configuration
/// (the desktop's `fs::local_only::SETTINGS_KEY`).
const SETTINGS_KEY: &str = "localOnlyFolders";

/// The desktop's settings document, or `None` when this platform has no
/// config directory.
fn settings_path() -> Option<PathBuf> {
    dirs::config_dir().map(|base| base.join("reflect-open").join("settings.json"))
}

/// The local-only folders the desktop's settings configure for the graph at
/// `root`: `None` when there is no settings file or no entry for this graph.
/// An unreadable or malformed document or entry refuses (exit 3).
pub fn configured_local_only_folders(root: &Path) -> Result<Option<LocalOnlyFolders>, CliError> {
    match settings_path() {
        Some(path) => folders_in_settings(&path, root),
        None => Ok(None),
    }
}

fn unknown(detail: impl std::fmt::Display) -> CliError {
    CliError::Private(format!(
        "this graph has no index and Reflect's settings can't be read ({detail}), so which \
         notes are local-only is unknown and no note is shown: open this graph in Reflect first"
    ))
}

/// [`configured_local_only_folders`] for the document at `path`.
pub(crate) fn folders_in_settings(
    path: &Path,
    root: &Path,
) -> Result<Option<LocalOnlyFolders>, CliError> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(unknown(err)),
    };
    let document: Value = serde_json::from_str(&raw).map_err(unknown)?;
    let Some(entries) = document.get(SETTINGS_KEY) else {
        return Ok(None);
    };
    let Some(entries) = entries.as_object() else {
        return Err(unknown(format!("\"{SETTINGS_KEY}\" is not an object")));
    };
    let Some(entry) = entries
        .iter()
        .find(|(key, _)| same_folder(Path::new(key), root))
        .map(|(_, entry)| entry)
    else {
        return Ok(None);
    };
    let names = entry
        .get("folders")
        .and_then(Value::as_array)
        .ok_or_else(|| unknown("this graph's entry has no \"folders\" list"))?
        .iter()
        .map(|name| {
            name.as_str()
                .map(str::to_string)
                .ok_or_else(|| unknown("a folder name is not a string"))
        })
        .collect::<Result<Vec<String>, CliError>>()?;
    Ok(LocalOnlyFolders::recorded(names, None))
}

/// Whether two paths name the same folder: spelled alike, or canonically
/// equal (the desktop keys the entry by the root it opened).
fn same_folder(key: &Path, root: &Path) -> bool {
    key == root
        || match (key.canonicalize(), root.canonicalize()) {
            (Ok(key), Ok(root)) => key == root,
            _ => false,
        }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(dir: &Path, contents: &str) -> PathBuf {
        let path = dir.join("settings.json");
        fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn the_graphs_own_entry_configures_its_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("graph");
        fs::create_dir_all(&root).unwrap();
        let key = root.to_string_lossy().into_owned();
        let path = settings(
            dir.path(),
            &serde_json::json!({
                SETTINGS_KEY: {
                    key: { "folders": ["secure", "daily"] },
                    "/elsewhere": { "folders": ["kids"] }
                }
            })
            .to_string(),
        );
        let folders = folders_in_settings(&path, &root).unwrap().expect("folders");
        assert_eq!(folders.names(), ["secure", "daily"]);
        assert!(folders.contains("people/secure/visa.md"));
        assert!(!folders.contains("people/kids/x.md"));
    }

    #[test]
    fn no_file_no_key_or_no_entry_configures_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(folders_in_settings(&dir.path().join("missing.json"), root)
            .unwrap()
            .is_none());
        let path = settings(dir.path(), r#"{ "theme": "dark" }"#);
        assert!(folders_in_settings(&path, root).unwrap().is_none());
        let path = settings(
            dir.path(),
            r#"{ "localOnlyFolders": { "/elsewhere": { "folders": ["secure"] } } }"#,
        );
        assert!(folders_in_settings(&path, root).unwrap().is_none());
    }

    #[test]
    fn an_unreadable_document_or_entry_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let key = serde_json::to_string(&root.to_string_lossy()).unwrap();
        for contents in [
            "{ not json".to_string(),
            r#"{ "localOnlyFolders": [] }"#.to_string(),
            format!(r#"{{ "localOnlyFolders": {{ {key}: {{ "folders": "secure" }} }} }}"#),
            format!(r#"{{ "localOnlyFolders": {{ {key}: {{ "folders": [7] }} }} }}"#),
        ] {
            let path = settings(dir.path(), &contents);
            assert!(
                matches!(folders_in_settings(&path, root), Err(CliError::Private(_))),
                "{contents}"
            );
        }
    }
}
