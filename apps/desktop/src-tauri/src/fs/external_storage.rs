//! The external storage folder a graph loads at open
//! ([`reflect_graph_paths::ExternalStore`]): attachments Git backup doesn't
//! carry live there at their graph paths, and Reflect reads them as if they
//! sat in the graph.
//!
//! It lives under a key of its own, keyed by graph root:
//!
//! ```json
//! "externalStorage": { "/Users/me/Notes": { "root": "/Volumes/Archive/Notes files" } }
//! ```
//!
//! The folder must carry a `.reflect-external-storage` marker file. Like the
//! backup settings, the key is loaded at every graph open into `GraphState`,
//! a value Reflect cannot use is reported with a warning the app shows at
//! open, and Rust owns it: `settings_save` keeps the copy on disk. Desktop
//! only; a phone ignores it.
//!
//! Each open also records the folder's spellings (as configured, and
//! canonical when it resolves) in `.reflect/external-storage.json`, so Git
//! keeps skipping links into it while it is unmounted, after it moves, or
//! once it is no longer configured.

use std::path::{Path, PathBuf};

use reflect_graph_paths::{EXTERNAL_STORAGE_SETTINGS_KEY, ExternalLinks, ExternalStore};
use serde::{Deserialize, Serialize};

use crate::settings::{GraphSection, SettingsDoc, graph_section};

/// The record of the folder's spellings, under the graph's `.reflect/`.
const RECORD_FILE: &str = "external-storage.json";

/// One graph's external storage as loaded at open.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct LoadedExternal {
    pub(crate) store: Option<ExternalStore>,
    /// Every spelling the folder has had, the recorded ones included.
    pub(crate) links: Option<ExternalLinks>,
    /// Problems the user must see, in display order.
    pub(crate) warnings: Vec<String>,
}

/// Load the external storage for the graph at `root`, kept apart from its
/// local-only `raw_root`. An unreadable settings file loads no folder
/// without a warning of its own (the local-only configuration already
/// reports it); the recorded spellings still load.
pub(crate) fn load_for_root(root: &Path, raw_root: Option<&Path>) -> LoadedExternal {
    if cfg!(mobile) {
        return LoadedExternal::default();
    }
    let mut loaded = match crate::settings::load_document() {
        Ok(doc) => from_settings(&doc, root, raw_root, dirs::home_dir().as_deref()),
        Err(err) => {
            tracing::warn!(?err, "could not read settings for the external storage");
            LoadedExternal::default()
        }
    };
    loaded.links = remember_spellings(root, loaded.store.as_ref());
    loaded
}

/// The spellings this graph's record holds plus the configured folder's
/// own ([`ExternalStore::link_spellings`]). Only a folder that can serve the
/// graph is recorded: one missing at this open counts for this open alone,
/// and one that exists but can't serve the graph (a parent of it, say)
/// never counts. A record that can't be read is left as it is.
fn remember_spellings(root: &Path, store: Option<&ExternalStore>) -> Option<ExternalLinks> {
    #[derive(Default, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Record {
        #[serde(default)]
        link_roots: Vec<PathBuf>,
    }
    let path = root
        .join(reflect_graph_io::io::REFLECT_DIR)
        .join(RECORD_FILE);
    let (mut record, writable) = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<Record>(&bytes) {
            Ok(record) => (record, true),
            Err(err) => {
                tracing::warn!(?err, "the external storage record is unreadable");
                (Record::default(), false)
            }
        },
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => (Record::default(), true),
        Err(err) => {
            tracing::warn!(?err, "could not read the external storage record");
            (Record::default(), false)
        }
    };
    let recorded = record.link_roots.len();
    let spellings = store
        .map(|store| store.link_spellings(root))
        .unwrap_or_default();
    if store.is_some_and(|store| store.problem(root).is_none()) {
        for spelling in &spellings {
            if !record.link_roots.contains(spelling) {
                record.link_roots.push(spelling.clone());
            }
        }
    }
    if writable && record.link_roots.len() > recorded {
        let written = serde_json::to_vec_pretty(&record)
            .map_err(|err| crate::error::AppError::io(err.to_string()))
            .and_then(|bytes| reflect_graph_io::io::atomic_write_bytes(root, &path, &bytes));
        if let Err(err) = written {
            tracing::warn!(?err, "could not record the external storage folder");
        }
    }
    ExternalLinks::new(record.link_roots.into_iter().chain(spellings))
}

/// The external storage for `root` in a settings document, kept from
/// containing `home`. A folder that can't serve the graph right now
/// (unmounted, unmarked, overlapping it) is kept with a warning: every read
/// re-checks it.
fn from_settings(
    doc: &SettingsDoc,
    root: &Path,
    raw_root: Option<&Path>,
    home: Option<&Path>,
) -> LoadedExternal {
    let key = EXTERNAL_STORAGE_SETTINGS_KEY;
    let (entry, others) = match graph_section(doc, key, root) {
        GraphSection::Absent => return LoadedExternal::default(),
        GraphSection::Malformed => {
            return LoadedExternal {
                warnings: vec![format!(
                    "\"{key}\" in the settings file must map graph folders to an entry with a \
                     \"root\" folder, so it is ignored."
                )],
                ..LoadedExternal::default()
            };
        }
        GraphSection::Present { entry, others } => (entry, others),
    };
    let mut warnings: Vec<String> = others
        .into_iter()
        .filter(|key| !Path::new(key).is_dir())
        .map(|key| {
            format!(
                "External storage is configured for {key}, which does not exist (was the graph \
                 moved or renamed?). Check the path."
            )
        })
        .collect();
    let Some(entry) = entry else {
        return LoadedExternal {
            warnings,
            ..LoadedExternal::default()
        };
    };
    let Some(folder) = entry.get("root").and_then(|value| value.as_str()) else {
        warnings.push(
            "The external storage entry for this graph needs a \"root\" folder, so it is \
             ignored."
                .to_string(),
        );
        return LoadedExternal {
            warnings,
            ..LoadedExternal::default()
        };
    };
    let Some(store) = ExternalStore::new(Path::new(folder), raw_root, home) else {
        warnings.push(format!(
            "The external storage folder must be an absolute path; {folder} is not, so it is \
             ignored."
        ));
        return LoadedExternal {
            warnings,
            ..LoadedExternal::default()
        };
    };
    if let Some(problem) = store.problem(root) {
        warnings.push(format!(
            "The external storage folder {folder} can't be used: {problem}. Files kept there \
             don't show in this graph until it can."
        ));
    }
    LoadedExternal {
        store: Some(store),
        links: None,
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn doc(value: serde_json::Value) -> SettingsDoc {
        let mut doc = SettingsDoc::new();
        doc.insert(EXTERNAL_STORAGE_SETTINGS_KEY.to_string(), value);
        doc
    }

    #[test]
    fn a_marked_folder_loads_without_warnings() {
        let dir = tempfile::tempdir().unwrap();
        let (graph, external) = (dir.path().join("graph"), dir.path().join("ext"));
        std::fs::create_dir_all(&graph).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join(reflect_graph_paths::MARKER_FILE_NAME), "").unwrap();
        let settings =
            doc(json!({ graph.to_str().unwrap(): { "root": external.to_str().unwrap() } }));

        let loaded = from_settings(&settings, &graph, None, None);
        assert_eq!(loaded.warnings, Vec::<String>::new());
        assert_eq!(loaded.store.unwrap().root(), external);
    }

    #[test]
    fn an_unusable_folder_is_kept_with_a_warning() {
        let dir = tempfile::tempdir().unwrap();
        let graph = dir.path().join("graph");
        std::fs::create_dir_all(&graph).unwrap();
        let missing = dir.path().join("unmounted");
        let settings =
            doc(json!({ graph.to_str().unwrap(): { "root": missing.to_str().unwrap() } }));

        let loaded = from_settings(&settings, &graph, None, None);
        assert!(loaded.store.is_some());
        assert_eq!(loaded.warnings.len(), 1);
        assert!(
            loaded.warnings[0].contains("does not exist"),
            "{:?}",
            loaded.warnings
        );
    }

    #[test]
    fn malformed_entries_are_ignored_with_a_warning() {
        let dir = tempfile::tempdir().unwrap();
        let graph = dir.path().join("graph");
        std::fs::create_dir_all(&graph).unwrap();
        let key = graph.to_str().unwrap();

        for value in [
            json!(["not", "an", "object"]),
            json!({ key: { "folder": "/elsewhere" } }),
            json!({ key: { "root": "relative/files" } }),
        ] {
            let loaded = from_settings(&doc(value.clone()), &graph, None, None);
            assert_eq!(loaded.store, None, "{value}");
            assert_eq!(loaded.warnings.len(), 1, "{value}");
        }
        let absent = from_settings(&SettingsDoc::new(), &graph, None, None);
        assert_eq!(absent, LoadedExternal::default());
    }

    #[test]
    fn every_spelling_is_remembered_for_later_opens() {
        let dir = tempfile::tempdir().unwrap();
        let graph = dir.path().join("graph");
        std::fs::create_dir_all(graph.join(".reflect")).unwrap();
        let external = dir.path().join("ext");
        std::fs::create_dir_all(&external).unwrap();
        std::fs::write(external.join(reflect_graph_paths::MARKER_FILE_NAME), "").unwrap();
        let alias = dir.path().join("alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external, &alias).unwrap();
        #[cfg(not(unix))]
        let alias = external.clone();
        let store = ExternalStore::new(&alias, None, None).unwrap();

        let links = remember_spellings(&graph, Some(&store)).unwrap();
        let canonical = external.canonicalize().unwrap();
        let notes = graph.join("notes");
        assert!(links.points_into(&canonical.join("a.pdf"), &notes, &graph));
        assert!(links.points_into(&alias.join("a.pdf"), &notes, &graph));

        // A later open with the folder unmounted, or no longer configured.
        std::fs::remove_dir_all(&external).unwrap();
        let later = remember_spellings(&graph, None).unwrap();
        assert!(later.points_into(&canonical.join("a.pdf"), &notes, &graph));
        assert!(later.points_into(&alias.join("a.pdf"), &notes, &graph));
    }

    #[test]
    fn a_folder_that_cannot_serve_the_graph_is_never_recorded() {
        let dir = tempfile::tempdir().unwrap();
        let graph = dir.path().join("graph");
        std::fs::create_dir_all(graph.join(".reflect")).unwrap();
        std::fs::write(dir.path().join(reflect_graph_paths::MARKER_FILE_NAME), "").unwrap();
        let around = ExternalStore::new(dir.path(), None, None).unwrap();
        assert!(around.problem(&graph).is_some());

        assert_eq!(remember_spellings(&graph, Some(&around)), None);
        assert!(!graph.join(".reflect").join(RECORD_FILE).exists());
    }

    #[test]
    fn an_unreadable_record_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let graph = dir.path().join("graph");
        std::fs::create_dir_all(graph.join(".reflect")).unwrap();
        let record = graph.join(".reflect").join(RECORD_FILE);
        std::fs::write(&record, b"{ not json").unwrap();
        let external = dir.path().join("ext");
        let store = ExternalStore::new(&external, None, None).unwrap();

        let links = remember_spellings(&graph, Some(&store)).unwrap();
        assert!(links.points_into(&external.join("a.pdf"), &graph.join("notes"), &graph));
        assert_eq!(std::fs::read(&record).unwrap(), b"{ not json");
        assert_eq!(remember_spellings(&graph, None), None);
    }
}
