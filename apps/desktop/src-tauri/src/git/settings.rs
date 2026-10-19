//! The backup settings a graph loads at open: its size limit and the
//! history roots it accepts. [`reflect_git`] enforces both; this module
//! reads them out of the user settings document.
//!
//! Both live under a key of their own, keyed by graph root:
//!
//! ```json
//! "backupMaxFileMiB": { "/Users/me/Notes": 32 },
//! "acceptedHistoryRoots": { "/Users/me/Notes": ["<40-character commit id>"] }
//! ```
//!
//! The size limit is a whole number of MiB from 1 to [`MAX_MIB`]; files at
//! or above it are withheld from backup commits. Accepted roots are full
//! 40-character commit ids; a pull or push that would join any other
//! history root pauses (see `reflect_git::PullPolicy`).
//!
//! Like the local-only folders, both are loaded at every graph open into
//! `GraphState`, a value Reflect cannot use falls back with a warning the
//! app shows at open, and Rust owns the keys: `settings_save` keeps the copy
//! on disk, so an edit made while the app runs survives the app's next save
//! and applies at the next open.

use std::path::Path;

use git2::Oid;
use reflect_git::{ACCEPTED_HISTORY_ROOTS_SETTINGS_KEY, MAX_FILE_BYTES};

use crate::settings::{GraphSection, SettingsDoc, graph_section};

/// The settings-document key holding every graph's backup size limit.
pub(crate) const MAX_FILE_SIZE_SETTINGS_KEY: &str = "backupMaxFileMiB";

const BYTES_PER_MIB: u64 = 1024 * 1024;

/// The highest limit a graph may set, in MiB: the default.
const MAX_MIB: u64 = MAX_FILE_BYTES / BYTES_PER_MIB;

/// One graph's backup settings as loaded at open.
#[derive(Debug, PartialEq)]
pub(crate) struct BackupSettings {
    pub(crate) max_file_bytes: u64,
    pub(crate) accepted_roots: Vec<Oid>,
    /// Problems the user must see, in display order.
    pub(crate) warnings: Vec<String>,
}

impl Default for BackupSettings {
    fn default() -> Self {
        Self {
            max_file_bytes: MAX_FILE_BYTES,
            accepted_roots: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

/// Load the backup settings for the graph at `root`. An unreadable settings
/// file keeps the defaults (the highest limit, no accepted roots) without a
/// warning of its own: the local-only configuration already reports it, and
/// pauses sync until it is fixed.
pub(crate) fn load_backup_settings(root: &Path) -> BackupSettings {
    match crate::settings::load_document() {
        Ok(doc) => {
            let limit = limit_from_settings(&doc, root);
            let roots = roots_from_settings(&doc, root);
            let mut warnings = limit.warnings;
            warnings.extend(roots.warnings);
            BackupSettings {
                max_file_bytes: limit.max_file_bytes,
                accepted_roots: roots.roots,
                warnings,
            }
        }
        Err(err) => {
            tracing::warn!(?err, "could not read settings for the backup settings");
            BackupSettings::default()
        }
    }
}

/// One graph's limit as loaded at open.
#[derive(Debug, PartialEq)]
struct LoadedLimit {
    max_file_bytes: u64,
    warnings: Vec<String>,
}

impl Default for LoadedLimit {
    fn default() -> Self {
        Self {
            max_file_bytes: MAX_FILE_BYTES,
            warnings: Vec::new(),
        }
    }
}

/// The limit for `root` in a settings document. A key that names a folder
/// that does not exist (a moved vault, a typo) is reported, since it would
/// otherwise leave this graph on the default without a word.
fn limit_from_settings(doc: &SettingsDoc, root: &Path) -> LoadedLimit {
    let key = MAX_FILE_SIZE_SETTINGS_KEY;
    let (entry, others) = match graph_section(doc, key, root) {
        GraphSection::Absent => return LoadedLimit::default(),
        GraphSection::Malformed => {
            return LoadedLimit {
                warnings: vec![format!(
                    "\"{key}\" in the settings file must map graph folders to a size in MiB, so \
                     it is ignored and backups withhold files of {MAX_MIB} MiB or more."
                )],
                ..LoadedLimit::default()
            };
        }
        GraphSection::Present { entry, others } => (entry, others),
    };
    let mut warnings: Vec<String> = others
        .into_iter()
        .filter(|key| !Path::new(key).is_dir())
        .map(|key| {
            format!(
                "A backup size limit is configured for {key}, which does not exist (was the \
                 graph moved or renamed?). Check the path."
            )
        })
        .collect();
    let Some(value) = entry else {
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

/// One graph's accepted roots as loaded at open.
#[derive(Debug, Default, PartialEq)]
struct LoadedRoots {
    roots: Vec<Oid>,
    warnings: Vec<String>,
}

/// The accepted roots for `root` in a settings document. A key that names a
/// folder that does not exist (a moved vault, a typo) is reported, since it
/// would otherwise leave this graph pausing on a root the user did accept.
fn roots_from_settings(doc: &SettingsDoc, root: &Path) -> LoadedRoots {
    let key = ACCEPTED_HISTORY_ROOTS_SETTINGS_KEY;
    let (entry, others) = match graph_section(doc, key, root) {
        GraphSection::Absent => return LoadedRoots::default(),
        GraphSection::Malformed => {
            return LoadedRoots {
                warnings: vec![format!(
                    "\"{key}\" in the settings file must map graph folders to lists of commit \
                     ids, so it is ignored and sync pauses on any history it has not accepted."
                )],
                ..LoadedRoots::default()
            };
        }
        GraphSection::Present { entry, others } => (entry, others),
    };
    let mut warnings: Vec<String> = others
        .into_iter()
        .filter(|key| !Path::new(key).is_dir())
        .map(|key| {
            format!(
                "Accepted history roots are configured for {key}, which does not exist (was the \
                 graph moved or renamed?). Check the path."
            )
        })
        .collect();
    let Some(value) = entry else {
        return LoadedRoots {
            warnings,
            ..LoadedRoots::default()
        };
    };
    let Some(items) = value.as_array() else {
        warnings.push(format!(
            "The accepted history roots for this graph must be a list of commit ids; {value} is \
             not, so none are accepted."
        ));
        return LoadedRoots {
            warnings,
            ..LoadedRoots::default()
        };
    };
    let mut roots = Vec::new();
    for item in items {
        match item.as_str().and_then(full_commit_id) {
            Some(oid) => {
                if !roots.contains(&oid) {
                    roots.push(oid);
                }
            }
            None => warnings.push(format!(
                "{item} in the accepted history roots for this graph is not a full 40-character \
                 commit id, so it is ignored."
            )),
        }
    }
    LoadedRoots { roots, warnings }
}

/// A full commit id, in either case. `Oid::from_str` alone would zero-pad an
/// abbreviated one into an id that matches nothing.
fn full_commit_id(text: &str) -> Option<Oid> {
    if text.len() != 40 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Oid::from_str(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const SIZE_KEY: &str = MAX_FILE_SIZE_SETTINGS_KEY;
    const ROOTS_KEY: &str = ACCEPTED_HISTORY_ROOTS_SETTINGS_KEY;
    const ROOT_A: &str = "d39c5fa0d39c5fa0d39c5fa0d39c5fa0d39c5fa0";
    const ROOT_B: &str = "0123456789abcdef0123456789abcdef01234567";

    fn doc(settings: Value) -> SettingsDoc {
        match settings {
            Value::Object(doc) => doc,
            _ => panic!("settings document must be an object"),
        }
    }

    fn limit(settings: Value, root: &Path) -> LoadedLimit {
        limit_from_settings(&doc(settings), root)
    }

    fn roots(settings: Value, root: &Path) -> LoadedRoots {
        roots_from_settings(&doc(settings), root)
    }

    fn oid(text: &str) -> Oid {
        Oid::from_str(text).unwrap()
    }

    #[test]
    fn an_unconfigured_graph_keeps_the_default_limit_without_a_warning() {
        let loaded = limit(json!({}), Path::new("/vaults/notes"));
        assert_eq!(loaded, LoadedLimit::default());
        assert_eq!(loaded.max_file_bytes, 95 * 1024 * 1024);
    }

    #[test]
    fn an_entry_sets_the_limit_in_mib() {
        let settings = json!({ SIZE_KEY: { "/vaults/notes": 32 } });
        let loaded = limit(settings, Path::new("/vaults/notes"));
        assert_eq!(loaded.max_file_bytes, 32 * 1024 * 1024);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
        let ceiling = json!({ SIZE_KEY: { "/vaults/notes": 95 } });
        let loaded = limit(ceiling, Path::new("/vaults/notes"));
        assert_eq!(loaded.max_file_bytes, MAX_FILE_BYTES);
    }

    #[test]
    fn a_limit_out_of_range_or_not_whole_falls_back_and_says_so() {
        for value in [
            json!(0),
            json!(-5),
            json!(96),
            json!(32.5),
            json!("32"),
            json!(null),
        ] {
            let settings = json!({ SIZE_KEY: { "/vaults/notes": value.clone() } });
            let loaded = limit(settings, Path::new("/vaults/notes"));
            assert_eq!(loaded.max_file_bytes, MAX_FILE_BYTES, "{value}");
            assert_eq!(loaded.warnings.len(), 1, "{value}: {:?}", loaded.warnings);
            assert!(
                loaded.warnings[0].contains(&format!("{value} is not")),
                "{:?}",
                loaded.warnings
            );
        }
    }

    #[test]
    fn a_malformed_limit_key_is_reported_and_ignored() {
        let loaded = limit(json!({ SIZE_KEY: 32 }), Path::new("/vaults/notes"));
        assert_eq!(loaded.max_file_bytes, MAX_FILE_BYTES);
        assert!(loaded.warnings[0].contains("must map graph folders"));
    }

    #[test]
    fn a_limit_for_a_folder_that_does_not_exist_is_reported() {
        let settings = json!({ SIZE_KEY: { "/vaults/notse": 32 } });
        let loaded = limit(settings, Path::new("/vaults/notes"));
        assert_eq!(loaded.max_file_bytes, MAX_FILE_BYTES);
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("/vaults/notse"));
        // Another existing graph's entry is no concern of this one.
        let other = tempfile::tempdir().unwrap();
        let key = other.path().to_string_lossy().into_owned();
        let loaded = limit(json!({ SIZE_KEY: { key: 8 } }), Path::new("/vaults/notes"));
        assert_eq!(loaded, LoadedLimit::default());
    }

    #[test]
    fn a_non_canonical_limit_key_matches_the_same_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let spelled = format!("{}/./", root.display());
        let loaded = limit(json!({ SIZE_KEY: { spelled: 8 } }), &root);
        assert_eq!(loaded.max_file_bytes, 8 * 1024 * 1024);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    }

    #[test]
    fn an_unconfigured_graph_accepts_no_roots_without_a_warning() {
        assert_eq!(
            roots(json!({}), Path::new("/vaults/notes")),
            LoadedRoots::default()
        );
    }

    #[test]
    fn full_ids_load_in_either_case_and_once() {
        let settings = json!({ ROOTS_KEY: {
            "/vaults/notes": [ROOT_A, ROOT_B.to_uppercase(), ROOT_A]
        } });
        let loaded = roots(settings, Path::new("/vaults/notes"));
        assert_eq!(loaded.roots, vec![oid(ROOT_A), oid(ROOT_B)]);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    }

    #[test]
    fn a_malformed_id_is_dropped_and_reported() {
        for value in [
            json!("d39c5fa"),
            json!(format!("{ROOT_A}0")),
            json!(format!(" {}", &ROOT_A[1..])),
            json!("g39c5fa0d39c5fa0d39c5fa0d39c5fa0d39c5fa0"),
            json!(42),
            json!(null),
        ] {
            let settings = json!({ ROOTS_KEY: { "/vaults/notes": [value.clone(), ROOT_A] } });
            let loaded = roots(settings, Path::new("/vaults/notes"));
            assert_eq!(loaded.roots, vec![oid(ROOT_A)], "{value}");
            assert_eq!(loaded.warnings.len(), 1, "{value}: {:?}", loaded.warnings);
            assert!(
                loaded.warnings[0].starts_with(&format!("{value} in the accepted")),
                "{:?}",
                loaded.warnings
            );
        }
    }

    #[test]
    fn a_malformed_roots_key_or_entry_is_reported_and_accepts_nothing() {
        let loaded = roots(json!({ ROOTS_KEY: [ROOT_A] }), Path::new("/vaults/notes"));
        assert!(loaded.roots.is_empty());
        assert!(loaded.warnings[0].contains("must map graph folders"));

        let settings = json!({ ROOTS_KEY: { "/vaults/notes": ROOT_A } });
        let loaded = roots(settings, Path::new("/vaults/notes"));
        assert!(loaded.roots.is_empty());
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("must be a list"));
    }

    #[test]
    fn roots_for_a_folder_that_does_not_exist_are_reported() {
        let settings = json!({ ROOTS_KEY: { "/vaults/notse": [ROOT_A] } });
        let loaded = roots(settings, Path::new("/vaults/notes"));
        assert!(loaded.roots.is_empty());
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("/vaults/notse"));
        // Another existing graph's entry is no concern of this one.
        let other = tempfile::tempdir().unwrap();
        let key = other.path().to_string_lossy().into_owned();
        let loaded = roots(
            json!({ ROOTS_KEY: { key: [ROOT_A] } }),
            Path::new("/vaults/notes"),
        );
        assert_eq!(loaded, LoadedRoots::default());
    }

    #[test]
    fn a_non_canonical_roots_key_matches_the_same_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let spelled = format!("{}/./", root.display());
        let loaded = roots(json!({ ROOTS_KEY: { spelled: [ROOT_A] } }), &root);
        assert_eq!(loaded.roots, vec![oid(ROOT_A)]);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    }

    /// Both keys round-trip through the settings store: the app's own save
    /// keeps them as written, and the next graph open loads them.
    #[test]
    fn the_keys_survive_an_app_save_and_load_at_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        crate::settings::TEST_STORE_PATH.with(|store| *store.borrow_mut() = Some(path.clone()));
        let key = root.to_string_lossy().into_owned();
        let edited = json!({
            SIZE_KEY: { key.clone(): 8 },
            ROOTS_KEY: { key.clone(): [ROOT_A, "d39c5fa"] },
        });
        std::fs::write(&path, serde_json::to_vec(&edited).unwrap()).unwrap();

        let mut app_copy = SettingsDoc::new();
        app_copy.insert("theme".into(), json!("dark"));
        crate::settings::settings_save(app_copy).unwrap();
        let loaded = load_backup_settings(&root);
        crate::settings::TEST_STORE_PATH.with(|store| *store.borrow_mut() = None);

        assert_eq!(loaded.max_file_bytes, 8 * 1024 * 1024);
        assert_eq!(loaded.accepted_roots, vec![oid(ROOT_A)]);
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("\"d39c5fa\""));
    }
}
