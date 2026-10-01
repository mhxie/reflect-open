//! User settings store: one JSON document in the OS config dir.
//!
//! Settings live next to the recents store — **never** inside any one graph's
//! `.reflect/` — because they are per-user preferences that must follow the
//! user across graphs and survive graph deletion. Rust treats the document as
//! an opaque JSON object (a capability, per the architecture conventions);
//! the schema, defaults, and validation are policy and live in
//! `@reflect/core`'s zod layer.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tempfile::NamedTempFile;

use crate::error::{AppError, AppResult};

/// The settings document: a JSON object keyed by setting name. `Map` (not
/// `Value`) so a non-object payload is rejected at deserialization.
pub type SettingsDoc = Map<String, Value>;

#[cfg(test)]
thread_local! {
    /// Points this test thread's settings store at a temp file, so commands
    /// that read or write settings run without touching the user's own.
    pub(crate) static TEST_STORE_PATH: std::cell::RefCell<Option<PathBuf>> =
        const { std::cell::RefCell::new(None) };
}

fn store_path() -> AppResult<PathBuf> {
    #[cfg(test)]
    if let Some(path) = TEST_STORE_PATH.with(|path| path.borrow().clone()) {
        return Ok(path);
    }
    let base = crate::dev_harness::config_dir()?;
    Ok(base.join("reflect-open").join("settings.json"))
}

/// Load the stored document. A missing store is an empty object, but a real IO
/// error or malformed JSON is propagated — silently treating a corrupt store as
/// empty would let the next save persist that emptiness and wipe every setting.
fn load_from(path: &Path) -> AppResult<SettingsDoc> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(SettingsDoc::new()),
        Err(err) => return Err(AppError::io(err.to_string())),
    };
    serde_json::from_str(&raw).map_err(|err| AppError::io(err.to_string()))
}

fn save_to(path: &Path, settings: &SettingsDoc) -> AppResult<()> {
    let dir = path
        .parent()
        .ok_or_else(|| AppError::io("settings store path has no parent directory"))?;
    fs::create_dir_all(dir)?;
    let json =
        serde_json::to_string_pretty(settings).map_err(|err| AppError::io(err.to_string()))?;
    // Write to a temp file in the same dir, then atomically rename over the
    // target so a crash mid-write can't truncate the existing store.
    let mut tmp = NamedTempFile::new_in(dir)?;
    tmp.write_all(json.as_bytes())?;
    tmp.flush()?;
    tmp.persist(path)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

/// Command: the persisted settings document (an empty object on first run).
#[tauri::command]
pub fn settings_load() -> AppResult<SettingsDoc> {
    load_document()
}

/// The persisted settings document, for the few keys Rust itself must read
/// (the local-only folders a graph open loads into `GraphState`).
pub(crate) fn load_document() -> AppResult<SettingsDoc> {
    load_from(&store_path()?)
}

/// Keys Rust owns: the app never edits them, so a save keeps the copy on disk
/// rather than writing back whatever the app loaded at startup.
const RUST_OWNED_KEYS: [&str; 1] = [crate::fs::LOCAL_ONLY_SETTINGS_KEY];

/// Command: atomically replace the persisted settings document, except for
/// the Rust-owned keys, which keep their on-disk value. An edit to the
/// local-only configuration made while the app runs (the documented way to
/// configure it) must survive the app's next save; and since an unreadable
/// store cannot be merged, it refuses the save instead of replacing that
/// configuration with the app's copy.
#[tauri::command]
pub fn settings_save(settings: SettingsDoc) -> AppResult<()> {
    save_keeping_rust_keys(&store_path()?, settings)
}

fn save_keeping_rust_keys(path: &Path, mut settings: SettingsDoc) -> AppResult<()> {
    let on_disk = load_from(path).map_err(|err| {
        let reason = match err {
            AppError::Io { message } | AppError::NotFound { message } => message,
            other => format!("{other:?}"),
        };
        AppError::io(format!(
            "Settings not saved: Reflect could not read its settings file ({reason}). Fix or \
             remove {}; saving over it would replace its local-only folder configuration.",
            path.display()
        ))
    })?;
    for key in RUST_OWNED_KEYS {
        match on_disk.get(key) {
            Some(value) => settings.insert(key.to_string(), value.clone()),
            None => settings.remove(key),
        };
    }
    save_to(path, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    /// The command itself goes through the key-preserving save: an app copy
    /// without the key (or with a stale one) never replaces the file's.
    #[test]
    fn the_save_command_keeps_the_local_only_configuration_on_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        TEST_STORE_PATH.with(|store| *store.borrow_mut() = Some(path.clone()));
        let key = crate::fs::LOCAL_ONLY_SETTINGS_KEY;
        let configured = json!({ "/Users/me/Notes": { "folders": ["secure"] } });
        save_to(
            &path,
            &doc(&[("theme", json!("dark")), (key, configured.clone())]),
        )
        .unwrap();

        settings_save(doc(&[("theme", json!("light"))])).unwrap();
        assert_eq!(settings_load().unwrap().get(key), Some(&configured));
        assert_eq!(settings_load().unwrap().get("theme"), Some(&json!("light")));

        fs::write(&path, b"{ not json").unwrap();
        assert!(settings_save(doc(&[("theme", json!("dark"))])).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{ not json");
        TEST_STORE_PATH.with(|store| *store.borrow_mut() = None);
    }

    fn doc(entries: &[(&str, Value)]) -> SettingsDoc {
        entries
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect()
    }

    #[test]
    fn save_load_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let settings = doc(&[("editorMarkdownSyntax", json!("show"))]);
        save_to(&path, &settings).unwrap();
        assert_eq!(load_from(&path).unwrap(), settings);
    }

    #[test]
    fn missing_store_loads_empty() {
        let dir = tempdir().unwrap();
        assert!(load_from(&dir.path().join("nope.json")).unwrap().is_empty());
    }

    #[test]
    fn corrupt_store_errors_instead_of_wiping() {
        // A malformed store must surface an error, not silently read as empty
        // (which a later save would persist, destroying the real settings).
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, b"{ this is not json").unwrap();
        assert!(load_from(&path).is_err());
    }

    #[test]
    fn non_object_store_errors() {
        // The document contract is a JSON object; a stray array/string must not
        // load (and then round-trip) as if it were settings.
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, b"[1, 2, 3]").unwrap();
        assert!(load_from(&path).is_err());
    }

    #[test]
    fn a_save_keeps_the_local_only_configuration_on_disk() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let key = crate::fs::LOCAL_ONLY_SETTINGS_KEY;
        // The app loaded the document before the user configured a folder...
        let app_copy = doc(&[("theme", json!("dark")), (key, json!({ "/old": {} }))]);
        // ...then the user edited the file while the app ran.
        let edited = json!({ "/Users/me/Notes": { "folders": ["secure"] } });
        save_to(
            &path,
            &doc(&[("theme", json!("dark")), (key, edited.clone())]),
        )
        .unwrap();

        save_keeping_rust_keys(&path, doc(&[("theme", json!("light")), (key, json!({}))])).unwrap();
        let saved = load_from(&path).unwrap();
        assert_eq!(saved.get(key), Some(&edited));
        assert_eq!(saved.get("theme"), Some(&json!("light")));

        // Removing the key from the file removes it, whatever the app holds.
        save_to(&path, &doc(&[("theme", json!("dark"))])).unwrap();
        save_keeping_rust_keys(&path, app_copy).unwrap();
        assert_eq!(load_from(&path).unwrap().get(key), None);
    }

    #[test]
    fn a_save_over_an_unreadable_store_is_refused() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, b"{ this is not json").unwrap();
        assert!(save_keeping_rust_keys(&path, doc(&[("theme", json!("dark"))])).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{ this is not json");
        // A missing store is simply created.
        let fresh = dir.path().join("fresh.json");
        save_keeping_rust_keys(&fresh, doc(&[("theme", json!("dark"))])).unwrap();
        assert_eq!(load_from(&fresh).unwrap(), doc(&[("theme", json!("dark"))]));
    }

    #[test]
    fn save_creates_parent_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("nested").join("settings.json");
        save_to(&path, &doc(&[("theme", json!("dark"))])).unwrap();
        assert_eq!(load_from(&path).unwrap(), doc(&[("theme", json!("dark"))]));
    }
}
