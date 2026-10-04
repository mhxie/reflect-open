//! The open graph's local-only folders configuration: which folders (by name)
//! stay on this machine, and which raw-store directory their symlinks may
//! point into (`reflect_graph_paths::LocalOnlyFolders` holds the rules).
//!
//! The configuration lives in the user settings document — outside every
//! graph, so a vault can never grant itself reads outside its own root —
//! under [`SETTINGS_KEY`], keyed by graph root:
//!
//! ```json
//! "localOnlyFolders": {
//!   "/Users/me/Notes": { "folders": ["secure"], "rawRoot": "/Users/me/Raw" }
//! }
//! ```
//!
//! It is loaded at every graph open into `GraphState`, from which the walk,
//! the read and write guards, the watcher, the index flag, Git, and (through
//! `GraphInfo`) the TypeScript privacy gates all read the same value. Nothing
//! is repaired silently: a dropped name, an unusable `rawRoot`, a key naming
//! a missing folder or no graph Reflect has opened, and an unreadable
//! settings file all come back as warnings the app shows at open.
//!
//! The configuration fails closed when it goes missing. [`load_for_root`]
//! compares it with the names the graph's index recorded at its last open:
//! any it no longer lists (a moved vault, an unreadable file) stay local-only
//! on the deny side, and the configuration counts as unknown, which pauses
//! sync and privacy-sensitive sharing (`fs::graph_for_sync`,
//! `fs::graph_for_sharing`) and lets the record only grow. A deliberate
//! removal is acknowledged in the graph's own entry, `"released": [...]`;
//! the next index open then records the shorter list. A name in both lists
//! pauses the same way until one of them drops it. Rust owns the key:
//! `settings_save` keeps the copy on disk, so an edit made while the app runs
//! survives the app's next save and applies at the next open.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use reflect_graph_paths::{folder_name_problem, LocalOnlyFolders};
use serde_json::{Map, Value};

use crate::settings::SettingsDoc;

/// The settings-document key holding every graph's local-only configuration.
pub(crate) const SETTINGS_KEY: &str = "localOnlyFolders";

/// One graph's configuration as loaded at open.
#[derive(Debug)]
pub(crate) struct LoadedConfig {
    pub(crate) folders: Option<Arc<LocalOnlyFolders>>,
    /// Problems the user must see, in display order.
    pub(crate) warnings: Vec<String>,
    /// Which folders are local-only is unknown: sync and privacy-sensitive
    /// sharing pause.
    pub(crate) unknown: bool,
    /// Whether the index open may replace the record with these folders.
    /// Off while the configuration is unknown: the record then only grows.
    pub(crate) record: bool,
    /// The names this graph's own entry releases.
    released: Vec<String>,
    /// The settings carry an entry for this graph.
    has_entry: bool,
}

impl Default for LoadedConfig {
    fn default() -> Self {
        Self {
            folders: None,
            warnings: Vec::new(),
            unknown: false,
            record: true,
            released: Vec::new(),
            has_entry: false,
        }
    }
}

/// What a graph's index recorded about its local-only folders at its last
/// open (`db::recorded_local_only_folders`).
#[derive(Debug)]
pub(crate) enum Recorded {
    /// No index yet, or an index without a record: nothing to compare.
    Nothing,
    Names(Vec<String>),
    /// The record exists but cannot be read; `corrupt` when it does not parse.
    Unreadable {
        reason: String,
        corrupt: bool,
    },
}

/// Load the configuration for the graph at `root`, already compared with
/// what the graph's index recorded: no caller can skip the comparison.
pub(crate) fn load_for_root(root: &Path) -> LoadedConfig {
    let opened = || -> Vec<PathBuf> {
        crate::recents::list()
            .map(|recents| recents.into_iter().map(|graph| graph.root.into()).collect())
            .unwrap_or_default()
    };
    with_recorded(
        loaded_from(crate::settings::load_document(), root, opened),
        crate::db::recorded_local_only_folders(root),
    )
}

fn loaded_from(
    document: crate::error::AppResult<SettingsDoc>,
    root: &Path,
    opened: impl FnOnce() -> Vec<PathBuf>,
) -> LoadedConfig {
    match document {
        Ok(doc) => from_settings(&doc, root, &opened()),
        Err(err) => {
            tracing::warn!(?err, "could not read settings for local-only folders");
            LoadedConfig {
                warnings: vec![format!(
                    "Reflect could not read its settings file, so it cannot tell which folders \
                     are local-only. Sync and privacy-sensitive sharing are paused until the \
                     file is fixed. ({})",
                    error_message(&err)
                )],
                unknown: true,
                record: false,
                ..LoadedConfig::default()
            }
        }
    }
}

fn error_message(err: &crate::error::AppError) -> String {
    serde_json::to_value(err)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("{err:?}"))
}

fn quoted(names: &[String]) -> String {
    names
        .iter()
        .map(|name| format!("\"{name}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Fold in what the graph's index recorded at its last open.
///
/// - A recorded name the configuration no longer lists (a moved or renamed
///   vault, an unreadable settings file) stays local-only on the deny side,
///   private and read-only, even one today's name rules would refuse; the
///   configuration counts as unknown and the record only grows.
/// - A recorded name this graph's own entry lists under `released` is let go
///   (once: the index open then records the shorter list). Only this graph's
///   entry can release, so a moved vault still fails closed, and a released
///   name that matches nothing recorded changes nothing (a typo still
///   pauses).
/// - An unreadable record also leaves the configuration unknown. One that
///   does not parse carries nothing to keep, so with an entry for this graph
///   that names a valid folder, the index open records that entry in its
///   place; a record that merely could not be read is left as it is.
pub(crate) fn with_recorded(mut loaded: LoadedConfig, recorded: Recorded) -> LoadedConfig {
    let names = match recorded {
        Recorded::Nothing => return loaded,
        Recorded::Unreadable { reason, corrupt } => {
            // Only an entry that names at least one valid folder, and none
            // in both lists, replaces a corrupt record: an empty, broken, or
            // ambiguous entry is not a configuration.
            loaded.record =
                corrupt && loaded.has_entry && loaded.folders.is_some() && !loaded.unknown;
            loaded.unknown = true;
            // Name what replaces the record, so a typo shows before it sticks.
            let replacement = match &loaded.folders {
                Some(folders) if loaded.record => format!(
                    " Reflect records {} from this graph's entry in its place, so they resume \
                     the next time the graph opens. Check that list now: a folder it leaves out \
                     is no longer remembered as local-only.",
                    quoted(folders.names())
                ),
                _ => String::new(),
            };
            loaded.warnings.push(format!(
                "Reflect could not read which folders this graph's index recorded as local-only \
                 ({reason}), so it cannot tell whether any went missing. Sync and \
                 privacy-sensitive sharing are paused.{replacement}"
            ));
            return loaded;
        }
        Recorded::Names(names) => names,
    };
    let listed = |name: &str| {
        loaded
            .folders
            .as_ref()
            .is_some_and(|folders| folders.is_folder_name(name))
    };
    let released = |name: &str| {
        loaded
            .released
            .iter()
            .any(|released| released.eq_ignore_ascii_case(name))
    };
    let (releasing, missing): (Vec<String>, Vec<String>) = names
        .into_iter()
        .filter(|name| !listed(name))
        .partition(|name| released(name));
    if !releasing.is_empty() {
        let (verb, pronoun) = if releasing.len() == 1 {
            ("is", "it")
        } else {
            ("are", "them")
        };
        loaded.warnings.push(format!(
            "{} {verb} no longer local-only: this graph's entry releases {pronoun}. You can now \
             remove {pronoun} from \"released\".",
            quoted(&releasing)
        ));
    }
    if missing.is_empty() {
        return loaded;
    }
    let raw_root = loaded
        .folders
        .as_ref()
        .and_then(|folders| folders.raw_root().map(Path::to_path_buf));
    let kept: Vec<String> = loaded
        .folders
        .iter()
        .flat_map(|folders| folders.names().to_vec())
        .chain(missing.iter().cloned())
        .collect();
    loaded.folders = LocalOnlyFolders::recorded(kept, raw_root.as_deref()).map(Arc::new);
    let list = quoted(&missing);
    // Unknown already without an entry for this graph: the settings file
    // itself is unreadable (reported). An entry is unknown only when a name
    // sits in both of its lists.
    loaded
        .warnings
        .push(if loaded.unknown && !loaded.has_entry {
            format!(
                "Meanwhile {list}, which this graph's index recorded as local-only, stay private \
             and read-only."
            )
        } else {
            format!(
                "The local-only configuration no longer lists {list}, which this graph's index \
             recorded as local-only (was the graph moved or renamed?). They stay private and \
             read-only, and sync and privacy-sensitive sharing are paused until the settings \
             file lists them again. If you stopped treating them as local-only on purpose, add \
             them to \"released\" in this graph's entry."
            )
        });
    loaded.unknown = true;
    loaded.record = false;
    loaded
}

/// The configuration for `root` in a settings document. `opened` are the
/// roots of graphs Reflect has opened (recents). A key that names a folder
/// that no longer exists (a moved or renamed vault keeps its stale recents
/// entry), or one that names none of them (a typo), is reported instead of
/// silently ignored.
fn from_settings(doc: &SettingsDoc, root: &Path, opened: &[PathBuf]) -> LoadedConfig {
    let mut warnings = Vec::new();
    let Some(value) = doc.get(SETTINGS_KEY) else {
        return LoadedConfig::default();
    };
    let Some(entries) = value.as_object() else {
        warnings.push(format!(
            "\"{SETTINGS_KEY}\" in the settings file must map graph folders to their \
             configuration, so it is ignored."
        ));
        return LoadedConfig {
            warnings,
            ..LoadedConfig::default()
        };
    };
    let matched = matching_key(entries, root);
    for key in entries.keys() {
        if Some(key) == matched {
            continue;
        }
        if !Path::new(key).is_dir() {
            warnings.push(format!(
                "Local-only folders are configured for {key}, which does not exist (was the \
                 graph moved or renamed?). Check the path."
            ));
        } else if !opened.iter().any(|graph| same_folder(key, graph)) {
            warnings.push(format!(
                "Local-only folders are configured for {key}, which is not a graph Reflect \
                 has opened. Check the path."
            ));
        }
    }
    let Some(entry) = matched.and_then(|key| entries.get(key)) else {
        return LoadedConfig {
            warnings,
            ..LoadedConfig::default()
        };
    };
    let Some(entry) = entry.as_object() else {
        warnings.push(
            "The local-only entry for this graph must be an object, so it is ignored.".into(),
        );
        return LoadedConfig {
            warnings,
            ..LoadedConfig::default()
        };
    };
    let mut names = Vec::new();
    for value in string_list(entry, "folders", &mut warnings) {
        match folder_name_problem(&value) {
            None => names.push(value),
            Some(problem) => warnings.push(format!(
                "\"{value}\" can't be a local-only folder ({problem}), so it is not one."
            )),
        }
    }
    let released = string_list(entry, "released", &mut warnings);
    let raw_root = entry.get("rawRoot").and_then(Value::as_str).map(Path::new);
    let folders = LocalOnlyFolders::new(names, raw_root);
    match &folders {
        None => warnings.push(
            "No valid local-only folder names are configured for this graph, so no folder \
             is local-only."
                .into(),
        ),
        Some(folders) => {
            if let Some(problem) = folders.raw_root_problem(root) {
                warnings.push(format!(
                    "Local-only folders stay private and read-only, but linked ones can't be \
                     read: {problem}."
                ));
            }
        }
    }
    // A name in both lists is ambiguous: it stays local-only (listed), and
    // the configuration is unknown until one list drops it, so a leftover
    // release never sits quietly beside the folder it names.
    let both: Vec<String> = released
        .iter()
        .filter(|name| {
            folders
                .as_ref()
                .is_some_and(|folders| folders.is_folder_name(name))
        })
        .cloned()
        .collect();
    if !both.is_empty() {
        let (verb, pronoun, one, folder) = if both.len() == 1 {
            ("is", "it", "it", "the folder")
        } else {
            ("are", "them", "one of them", "that folder")
        };
        warnings.push(format!(
            "{} {verb} in both \"folders\" and \"released\" in this graph's entry. Reflect keeps \
             {pronoun} local-only, and sync and privacy-sensitive sharing are paused until you \
             remove {pronoun} from one of the two lists. Until you do, removing or mistyping \
             {one} in \"folders\" releases {folder}.",
            quoted(&both)
        ));
    }
    LoadedConfig {
        folders: folders.map(Arc::new),
        warnings,
        unknown: !both.is_empty(),
        record: both.is_empty(),
        released,
        has_entry: true,
    }
}

/// The strings of `entry[key]` (an array), reporting anything else in it.
fn string_list(entry: &Map<String, Value>, key: &str, warnings: &mut Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in entry
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        match value.as_str() {
            Some(name) => out.push(name.to_string()),
            None => warnings.push(format!(
                "Local-only folder names must be strings; {value} in \"{key}\" is ignored."
            )),
        }
    }
    out
}

/// The entry key for `root`: the exact root string or, failing that, one
/// naming the same folder (recents may hold a non-canonical spelling).
/// Shared with the other settings keyed by graph root.
pub(crate) fn matching_key<'doc>(
    entries: &'doc Map<String, Value>,
    root: &Path,
) -> Option<&'doc String> {
    if let Some((key, _)) = root.to_str().and_then(|root| entries.get_key_value(root)) {
        return Some(key);
    }
    entries.keys().find(|key| same_folder(key, root))
}

fn same_folder(key: &str, root: &Path) -> bool {
    Path::new(key) == root
        || match (Path::new(key).canonicalize(), root.canonicalize()) {
            (Ok(key), Ok(root)) => key == root,
            _ => false,
        }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn doc(value: Value) -> SettingsDoc {
        match value {
            Value::Object(map) => map,
            _ => panic!("settings document must be an object"),
        }
    }

    fn load(settings: Value, root: &str) -> LoadedConfig {
        from_settings(
            &doc(settings),
            Path::new(root),
            &[PathBuf::from("/vaults/other")],
        )
    }

    #[test]
    fn an_unconfigured_graph_has_no_policy_and_no_warning() {
        let loaded = load(json!({}), "/vaults/notes");
        assert!(loaded.folders.is_none() && loaded.warnings.is_empty() && !loaded.unknown);
        // Another opened graph's entry is no concern of this one.
        let other = tempfile::tempdir().unwrap();
        let key = other.path().to_string_lossy().into_owned();
        let loaded = from_settings(
            &doc(json!({ SETTINGS_KEY: { key: {} } })),
            Path::new("/vaults/notes"),
            &[other.path().to_path_buf()],
        );
        assert!(
            loaded.folders.is_none() && loaded.warnings.is_empty(),
            "{:?}",
            loaded.warnings
        );
    }

    #[test]
    fn an_entry_loads_names_and_reports_each_dropped_one() {
        let settings = json!({
            SETTINGS_KEY: {
                "/vaults/notes": {
                    "folders": ["secure", 7, ".git", "\u{17f}ecure", "daily"],
                    "rawRoot": "/raw"
                }
            }
        });
        let loaded = load(settings, "/vaults/notes");
        let folders = loaded.folders.expect("policy");
        assert_eq!(folders.names(), ["secure"]);
        assert_eq!(folders.raw_root(), Some(Path::new("/raw")));
        let warnings = loaded.warnings.join("\n");
        for dropped in ["7", "\".git\"", "\"\u{17f}ecure\"", "\"daily\""] {
            assert!(warnings.contains(dropped), "{dropped}: {warnings}");
        }
        assert!(warnings.contains("plain ASCII"), "{warnings}");
        assert!(
            warnings.contains("Reflect manages that folder"),
            "{warnings}"
        );
        // `/raw` does not exist here: the link side is reported too.
        assert!(warnings.contains("rawRoot does not exist"), "{warnings}");
    }

    #[test]
    fn a_bad_raw_root_keeps_only_the_deny_side_and_says_so() {
        let settings = json!({
            SETTINGS_KEY: { "/vaults/notes": { "folders": ["secure"], "rawRoot": "relative" } }
        });
        let loaded = load(settings, "/vaults/notes");
        let folders = loaded.folders.expect("policy");
        assert_eq!(folders.raw_root(), None);
        assert!(folders.contains("finance/secure/x.md"));
        assert!(loaded.warnings.join(" ").contains("no absolute rawRoot"));
    }

    #[test]
    fn an_entry_without_valid_names_is_reported_and_ignored() {
        let settings =
            json!({ SETTINGS_KEY: { "/vaults/notes": { "folders": [], "rawRoot": "/raw" } } });
        let loaded = load(settings, "/vaults/notes");
        assert!(loaded.folders.is_none());
        assert!(loaded
            .warnings
            .join(" ")
            .contains("No valid local-only folder names"));
    }

    #[test]
    fn a_key_naming_no_opened_graph_is_reported() {
        let settings = json!({ SETTINGS_KEY: { "/vaults/notse": { "folders": ["secure"] } } });
        let loaded = load(settings, "/vaults/notes");
        assert!(loaded.folders.is_none());
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].contains("/vaults/notse"));
        let malformed = load(json!({ SETTINGS_KEY: "secure" }), "/vaults/notes");
        assert!(malformed.warnings[0].contains("must map graph folders"));
    }

    #[test]
    fn an_unreadable_settings_file_leaves_the_configuration_unknown() {
        let loaded = loaded_from(
            Err(crate::error::AppError::io("expected value at line 1")),
            Path::new("/vaults/notes"),
            Vec::new,
        );
        assert!(loaded.unknown && loaded.folders.is_none());
        assert!(
            loaded.warnings[0].contains("sharing are paused"),
            "{:?}",
            loaded.warnings
        );
        assert!(loaded.warnings[0].contains("expected value at line 1"));
    }

    fn loaded(names: &[&str], raw_root: Option<&str>) -> LoadedConfig {
        LoadedConfig {
            folders: LocalOnlyFolders::new(names.iter().copied(), raw_root.map(Path::new))
                .map(Arc::new),
            has_entry: true,
            ..LoadedConfig::default()
        }
    }

    fn names(config: &LoadedConfig) -> Vec<String> {
        config
            .folders
            .as_ref()
            .map(|folders| folders.names().to_vec())
            .unwrap_or_default()
    }

    fn recorded(names: &[&str]) -> Recorded {
        Recorded::Names(names.iter().map(|name| name.to_string()).collect())
    }

    /// The entry for `/vaults/notes` (an existing folder in a real test is
    /// not needed: matching is by key string first).
    fn entry(settings: Value) -> LoadedConfig {
        from_settings(
            &doc(json!({ SETTINGS_KEY: { "/vaults/notes": settings } })),
            Path::new("/vaults/notes"),
            &[],
        )
    }

    #[test]
    fn recorded_names_the_configuration_still_lists_change_nothing() {
        let config = with_recorded(loaded(&["secure"], Some("/raw")), recorded(&["SECURE"]));
        assert!(!config.unknown && config.record && config.warnings.is_empty());
        assert_eq!(names(&config), ["secure"]);
        let config = with_recorded(LoadedConfig::default(), Recorded::Nothing);
        assert!(!config.unknown && config.record && config.folders.is_none());
    }

    #[test]
    fn a_recorded_name_gone_missing_stays_local_only_and_pauses_sharing() {
        // A moved vault: its entry no longer matches, so nothing is loaded.
        let config = with_recorded(LoadedConfig::default(), recorded(&["secure"]));
        assert!(config.unknown && !config.record);
        assert_eq!(names(&config), ["secure"]);
        assert!(
            config.warnings[0].contains("\"secure\""),
            "{:?}",
            config.warnings
        );
        assert!(config.warnings[0].contains("sharing are paused"));
        assert!(config.warnings[0].contains("\"released\""));
        assert!(!config.warnings[0].contains("index.sqlite"));
        // One name of two dropped: both stay, and the raw root is kept.
        let config = with_recorded(
            loaded(&["secure"], Some("/raw")),
            recorded(&["secure", "kids"]),
        );
        assert!(config.unknown);
        assert_eq!(names(&config), ["secure", "kids"]);
        assert_eq!(
            config
                .folders
                .as_ref()
                .and_then(|folders| folders.raw_root()),
            Some(Path::new("/raw"))
        );
    }

    #[test]
    fn a_deliberate_removal_released_by_the_graphs_own_entry_resumes() {
        let config = with_recorded(
            entry(json!({ "folders": ["kids"], "released": ["SECURE"] })),
            recorded(&["secure", "kids"]),
        );
        assert!(!config.unknown && config.record, "{:?}", config.warnings);
        assert_eq!(names(&config), ["kids"]);
        let releases = |config: &LoadedConfig| {
            config
                .warnings
                .iter()
                .filter(|warning| warning.contains("no longer local-only"))
                .count()
        };
        assert_eq!(releases(&config), 1, "{:?}", config.warnings);
        assert!(config
            .warnings
            .iter()
            .any(|warning| warning.contains("can now remove it")));
        // After the index re-records without it, the leftover is silent.
        let config = with_recorded(
            entry(json!({ "folders": ["kids"], "released": ["secure"] })),
            recorded(&["kids"]),
        );
        assert!(
            !config.unknown && releases(&config) == 0,
            "{:?}",
            config.warnings
        );
    }

    #[test]
    fn a_release_with_a_typo_still_pauses() {
        let config = with_recorded(
            entry(json!({ "folders": [], "released": ["secrue"] })),
            recorded(&["secure"]),
        );
        assert!(config.unknown && !config.record);
        assert_eq!(names(&config), ["secure"]);
    }

    #[test]
    fn a_name_in_both_lists_stays_local_only_and_pauses() {
        let both = json!({ "folders": ["kids"], "released": ["KIDS"] });
        let config = with_recorded(entry(both.clone()), recorded(&["kids"]));
        assert!(config.unknown && !config.record);
        assert_eq!(names(&config), ["kids"]);
        let warned = |config: &LoadedConfig, text: &str| {
            config.warnings.iter().any(|warning| warning.contains(text))
        };
        assert!(warned(
            &config,
            "\"KIDS\" is in both \"folders\" and \"released\""
        ));
        // The warning states the risk while it lasts.
        assert!(warned(
            &config,
            "removing or mistyping it in \"folders\" releases the folder"
        ));
        assert!(!warned(&config, "no longer local-only"));
        // A missing name beside it is reported as missing, not as the
        // unreadable-file story.
        let config = with_recorded(entry(both), recorded(&["kids", "secure"]));
        assert_eq!(names(&config), ["kids", "secure"]);
        assert!(
            warned(&config, "no longer lists \"secure\""),
            "{:?}",
            config.warnings
        );
        // Control: a release of another name pauses nothing.
        let config = with_recorded(
            entry(json!({ "folders": ["kids"], "released": ["secure"] })),
            recorded(&["kids", "secure"]),
        );
        assert!(!config.unknown && config.record, "{:?}", config.warnings);
        assert_eq!(names(&config), ["kids"]);
    }

    #[test]
    fn only_the_graphs_own_entry_can_release() {
        // A moved vault: the entry (with its release) is keyed by the old
        // path, so this graph's recorded names stay local-only.
        let settings = doc(json!({ SETTINGS_KEY: {
            "/vaults/old-home": { "folders": [], "released": ["secure"] }
        } }));
        let loaded = from_settings(&settings, Path::new("/vaults/notes"), &[]);
        let config = with_recorded(loaded, recorded(&["secure"]));
        assert!(config.unknown && !config.record);
        assert_eq!(names(&config), ["secure"]);
    }

    #[test]
    fn a_recorded_name_todays_rules_refuse_stays_local_only_until_released() {
        // Recorded before `daily` became a managed folder.
        let config = with_recorded(entry(json!({ "folders": [] })), recorded(&["daily"]));
        assert!(config.unknown);
        assert_eq!(names(&config), ["daily"]);
        assert!(config
            .folders
            .as_ref()
            .is_some_and(|folders| folders.contains("daily/2026-07-04.md")));
        let config = with_recorded(
            entry(json!({ "folders": [], "released": ["daily"] })),
            recorded(&["daily"]),
        );
        assert!(!config.unknown && config.record && config.folders.is_none());
    }

    #[test]
    fn an_unreadable_file_keeps_the_recorded_names_without_a_second_story() {
        let unreadable = loaded_from(
            Err(crate::error::AppError::io("expected value at line 1")),
            Path::new("/vaults/notes"),
            Vec::new,
        );
        let config = with_recorded(unreadable, recorded(&["secure"]));
        assert!(config.unknown && !config.record);
        assert_eq!(names(&config), ["secure"]);
        assert_eq!(config.warnings.len(), 2, "{:?}", config.warnings);
        assert!(config.warnings[1].contains("stay private and read-only"));
        assert!(!config.warnings[1].contains("no longer lists"));
    }

    #[test]
    fn an_unreadable_record_pauses_and_only_an_entry_may_replace_a_corrupt_one() {
        let corrupt = || Recorded::Unreadable {
            reason: "the record does not parse".into(),
            corrupt: true,
        };
        // No entry for this graph (a moved vault): paused, record kept.
        let config = with_recorded(LoadedConfig::default(), corrupt());
        assert!(config.unknown && !config.record);
        assert!(config.warnings[0].contains("sharing are paused"));
        assert!(!config.warnings[0].contains("in its place"));
        // With an entry, the corrupt record gives way to it next open, and
        // the warning names what it records (a typo shows before it sticks).
        let config = with_recorded(entry(json!({ "folders": ["secure", "kdis"] })), corrupt());
        assert!(config.unknown && config.record);
        assert!(
            config
                .warnings
                .iter()
                .any(|warning| warning.contains("records \"secure\", \"kdis\" from")),
            "{:?}",
            config.warnings
        );
        // An entry that names no valid folder is not a configuration.
        let config = with_recorded(entry(json!({ "folders": [] })), corrupt());
        assert!(config.unknown && !config.record);
        // A record that merely could not be read is never replaced.
        let config = with_recorded(
            entry(json!({ "folders": ["secure"] })),
            Recorded::Unreadable {
                reason: "database is locked".into(),
                corrupt: false,
            },
        );
        assert!(config.unknown && !config.record);
    }

    #[test]
    fn a_key_naming_a_folder_that_no_longer_exists_is_reported() {
        // Recents still holds the moved vault's old root.
        let gone = "/vaults/moved-away";
        let settings = doc(json!({ SETTINGS_KEY: { gone: { "folders": ["secure"] } } }));
        let loaded = from_settings(
            &settings,
            Path::new("/vaults/notes"),
            &[PathBuf::from(gone)],
        );
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("does not exist"));
    }

    #[test]
    fn a_non_canonical_key_matches_the_same_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let spelled = format!("{}/./", root.display());
        let settings = doc(json!({ SETTINGS_KEY: { spelled: { "folders": ["secure"] } } }));
        let loaded = from_settings(&settings, &root, &[]);
        assert!(loaded.folders.is_some());
        assert!(loaded
            .warnings
            .iter()
            .all(|warning| !warning.contains("not a graph")));
    }
}
