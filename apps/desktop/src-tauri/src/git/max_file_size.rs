//! The open graph's backup size guard: files at or above it are withheld
//! from Git backup commits (`commit::commit_all`) and reported.
//!
//! The limit defaults to [`DEFAULT_MAX_FILE_BYTES`] and can be lowered per
//! graph in the user settings document under [`SETTINGS_KEY`], keyed by
//! graph root, as a whole number of MiB from 1 to [`MAX_MIB`]:
//!
//! ```json
//! "backupMaxFileMiB": { "/Users/me/Notes": 32 }
//! ```
//!
//! Like the local-only folders, it is loaded at every graph open into
//! `GraphState`, a value Reflect cannot use falls back to the default with a
//! warning the app shows at open, and Rust owns the key: `settings_save`
//! keeps the copy on disk, so an edit made while the app runs survives the
//! app's next save and applies at the next open.

use std::path::Path;

use crate::settings::SettingsDoc;

/// The settings-document key holding every graph's backup size limit.
pub(crate) const SETTINGS_KEY: &str = "backupMaxFileMiB";

/// GitHub rejects files over 100 MB, failing the whole push; stop just under.
pub(crate) const MAX_MIB: u64 = 95;

const BYTES_PER_MIB: u64 = 1024 * 1024;

/// The limit when the settings configure none (or none Reflect can use).
pub(crate) const DEFAULT_MAX_FILE_BYTES: u64 = MAX_MIB * BYTES_PER_MIB;

/// One graph's limit as loaded at open.
#[derive(Debug, PartialEq)]
pub(crate) struct LoadedLimit {
    pub(crate) max_file_bytes: u64,
    /// Problems the user must see, in display order.
    pub(crate) warnings: Vec<String>,
}

impl Default for LoadedLimit {
    fn default() -> Self {
        Self {
            max_file_bytes: DEFAULT_MAX_FILE_BYTES,
            warnings: Vec::new(),
        }
    }
}

/// Load the limit for the graph at `root`. An unreadable settings file keeps
/// the default without a warning of its own: the local-only configuration
/// already reports it, and pauses sync until it is fixed.
pub(crate) fn load_for_root(root: &Path) -> LoadedLimit {
    match crate::settings::load_document() {
        Ok(doc) => from_settings(&doc, root),
        Err(err) => {
            tracing::warn!(?err, "could not read settings for the backup size limit");
            LoadedLimit::default()
        }
    }
}

/// The limit for `root` in a settings document. A key that names a folder
/// that does not exist (a moved vault, a typo) is reported, since it would
/// otherwise leave this graph on the default without a word.
fn from_settings(doc: &SettingsDoc, root: &Path) -> LoadedLimit {
    let Some(value) = doc.get(SETTINGS_KEY) else {
        return LoadedLimit::default();
    };
    let Some(entries) = value.as_object() else {
        return LoadedLimit {
            warnings: vec![format!(
                "\"{SETTINGS_KEY}\" in the settings file must map graph folders to a size in \
                 MiB, so it is ignored and backups withhold files of {MAX_MIB} MiB or more."
            )],
            ..LoadedLimit::default()
        };
    };
    let matched = crate::fs::settings_key_for_root(entries, root);
    let mut warnings: Vec<String> = entries
        .keys()
        .filter(|key| Some(*key) != matched && !Path::new(key).is_dir())
        .map(|key| {
            format!(
                "A backup size limit is configured for {key}, which does not exist (was the \
                 graph moved or renamed?). Check the path."
            )
        })
        .collect();
    let Some(value) = matched.and_then(|key| entries.get(key)) else {
        return LoadedLimit {
            warnings,
            ..LoadedLimit::default()
        };
    };
    match value.as_u64().filter(|mib| (1..=MAX_MIB).contains(mib)) {
        Some(mib) => LoadedLimit {
            max_file_bytes: mib * BYTES_PER_MIB,
            warnings,
        },
        None => {
            warnings.push(format!(
                "The backup size limit for this graph must be a whole number of MiB from 1 to \
                 {MAX_MIB}; {value} is not, so backups withhold files of {MAX_MIB} MiB or more."
            ));
            LoadedLimit {
                warnings,
                ..LoadedLimit::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn load(settings: Value, root: &Path) -> LoadedLimit {
        match settings {
            Value::Object(doc) => from_settings(&doc, root),
            _ => panic!("settings document must be an object"),
        }
    }

    #[test]
    fn an_unconfigured_graph_keeps_the_default_without_a_warning() {
        let loaded = load(json!({}), Path::new("/vaults/notes"));
        assert_eq!(loaded, LoadedLimit::default());
        assert_eq!(loaded.max_file_bytes, 95 * 1024 * 1024);
    }

    #[test]
    fn an_entry_sets_the_limit_in_mib() {
        let settings = json!({ SETTINGS_KEY: { "/vaults/notes": 32 } });
        let loaded = load(settings, Path::new("/vaults/notes"));
        assert_eq!(loaded.max_file_bytes, 32 * 1024 * 1024);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        let ceiling = json!({ SETTINGS_KEY: { "/vaults/notes": 95 } });
        let loaded = load(ceiling, Path::new("/vaults/notes"));
        assert_eq!(loaded.max_file_bytes, DEFAULT_MAX_FILE_BYTES);
    }

    #[test]
    fn a_value_out_of_range_or_not_whole_falls_back_and_says_so() {
        for value in [
            json!(0),
            json!(-5),
            json!(96),
            json!(32.5),
            json!("32"),
            json!(null),
        ] {
            let settings = json!({ SETTINGS_KEY: { "/vaults/notes": value.clone() } });
            let loaded = load(settings, Path::new("/vaults/notes"));
            assert_eq!(loaded.max_file_bytes, DEFAULT_MAX_FILE_BYTES, "{value}");
            assert_eq!(loaded.warnings.len(), 1, "{value}: {:?}", loaded.warnings);
            assert!(
                loaded.warnings[0].contains(&format!("{value} is not")),
                "{:?}",
                loaded.warnings
            );
        }
    }

    #[test]
    fn a_malformed_key_is_reported_and_ignored() {
        let loaded = load(json!({ SETTINGS_KEY: 32 }), Path::new("/vaults/notes"));
        assert_eq!(loaded.max_file_bytes, DEFAULT_MAX_FILE_BYTES);
        assert!(loaded.warnings[0].contains("must map graph folders"));
    }

    #[test]
    fn a_key_naming_a_folder_that_does_not_exist_is_reported() {
        let settings = json!({ SETTINGS_KEY: { "/vaults/notse": 32 } });
        let loaded = load(settings, Path::new("/vaults/notes"));
        assert_eq!(loaded.max_file_bytes, DEFAULT_MAX_FILE_BYTES);
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("/vaults/notse"));
        // Another existing graph's entry is no concern of this one.
        let other = tempfile::tempdir().unwrap();
        let key = other.path().to_string_lossy().into_owned();
        let loaded = load(
            json!({ SETTINGS_KEY: { key: 8 } }),
            Path::new("/vaults/notes"),
        );
        assert_eq!(loaded, LoadedLimit::default());
    }

    #[test]
    fn a_non_canonical_key_matches_the_same_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let spelled = format!("{}/./", root.display());
        let loaded = load(json!({ SETTINGS_KEY: { spelled: 8 } }), &root);
        assert_eq!(loaded.max_file_bytes, 8 * 1024 * 1024);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    }
}
