//! The open graph's accepted history roots: the starting (parentless)
//! commits Git sync may join.
//!
//! libgit2 merges two histories that share no commit like any other pair,
//! and a fast-forward can carry a separate history in under a merge another
//! device made. Either way removed notes and history come back (a device
//! still on a replaced history merges it back in). So sync never joins a
//! history root the graph has not accepted: a pull checks the commits it
//! would bring in (`merge::merge_remote`) and pauses, a push checks the
//! commits it would upload (`remote::push`) and refuses, both before
//! anything changes. Roots already in the history on the other side are
//! never checked again, an unborn HEAD adopts the remote's history as
//! before, and the first push (no remote branch yet) goes out as before.
//!
//! The list lives in the user settings document under [`SETTINGS_KEY`],
//! keyed by graph root, as full 40-character commit ids:
//!
//! ```json
//! "acceptedHistoryRoots": { "/Users/me/Notes": ["<40-character commit id>"] }
//! ```
//!
//! Like the backup size limit, it is loaded at every graph open into
//! `GraphState`, an entry Reflect cannot use is dropped with a warning the
//! app shows at open, and Rust owns the key: `settings_save` keeps the copy
//! on disk, so an edit made while the app runs survives the app's next save
//! and applies at the next open.

use std::path::Path;

use git2::{Oid, Repository};

use crate::error::{AppError, AppResult};
use crate::settings::SettingsDoc;

/// The settings-document key holding every graph's accepted history roots.
pub(crate) const SETTINGS_KEY: &str = "acceptedHistoryRoots";

/// One graph's accepted roots as loaded at open.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct LoadedRoots {
    pub(crate) roots: Vec<Oid>,
    /// Problems the user must see, in display order.
    pub(crate) warnings: Vec<String>,
}

/// Load the accepted roots for the graph at `root`. An unreadable settings
/// file accepts none without a warning of its own: the local-only
/// configuration already reports it, and pauses sync until it is fixed.
pub(crate) fn load_for_root(root: &Path) -> LoadedRoots {
    match crate::settings::load_document() {
        Ok(doc) => from_settings(&doc, root),
        Err(err) => {
            tracing::warn!(
                ?err,
                "could not read settings for the accepted history roots"
            );
            LoadedRoots::default()
        }
    }
}

/// The accepted roots for `root` in a settings document. A key that names a
/// folder that does not exist (a moved vault, a typo) is reported, since it
/// would otherwise leave this graph pausing on a root the user did accept.
fn from_settings(doc: &SettingsDoc, root: &Path) -> LoadedRoots {
    let Some(value) = doc.get(SETTINGS_KEY) else {
        return LoadedRoots::default();
    };
    let Some(entries) = value.as_object() else {
        return LoadedRoots {
            warnings: vec![format!(
                "\"{SETTINGS_KEY}\" in the settings file must map graph folders to lists of \
                 commit ids, so it is ignored and sync pauses on any history it has not accepted."
            )],
            ..LoadedRoots::default()
        };
    };
    let matched = crate::fs::settings_key_for_root(entries, root);
    let mut warnings: Vec<String> = entries
        .keys()
        .filter(|key| Some(*key) != matched && !Path::new(key).is_dir())
        .map(|key| {
            format!(
                "Accepted history roots are configured for {key}, which does not exist (was the \
                 graph moved or renamed?). Check the path."
            )
        })
        .collect();
    let Some(value) = matched.and_then(|key| entries.get(key)) else {
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

/// The parentless commits reachable from `tip` but not from `known` that
/// `accepted` does not list. Everything `known` reaches is skipped, so a
/// root already in that history is never checked again.
pub(super) fn unaccepted_roots(
    repo: &Repository,
    tip: Oid,
    known: Oid,
    accepted: &[Oid],
) -> AppResult<Vec<Oid>> {
    let mut walk = repo.revwalk()?;
    walk.push(tip)?;
    walk.hide(known)?;
    let mut roots = Vec::new();
    for oid in walk {
        let oid = oid?;
        if !accepted.contains(&oid) && repo.find_commit(oid)?.parent_count() == 0 {
            roots.push(oid);
        }
    }
    Ok(roots)
}

/// Refuse a pull of `remote` into `local` that would bring in a history
/// root the graph at `root` has not accepted. The pause also names this
/// graph's own unaccepted roots the remote lacks: joining the two uploads
/// them next, and one edit to the list then covers both.
pub(super) fn ensure_pull_accepted(
    repo: &Repository,
    root: &Path,
    local: Oid,
    remote: Oid,
    accepted: &[Oid],
) -> AppResult<()> {
    let incoming = unaccepted_roots(repo, remote, local, accepted)?;
    if incoming.is_empty() {
        return Ok(());
    }
    let outgoing = unaccepted_roots(repo, local, remote, accepted)?;
    let mut message = format!(
        "Sync paused: the backup brings in history that starts from {} this graph has not \
         accepted ({}). Reflect never joins a separate history on its own, because it can \
         bring back notes and history that were removed from the backup.",
        commits(incoming.len()),
        listed(&incoming)
    );
    if !outgoing.is_empty() {
        message.push_str(&format!(
            " Joining them would also upload this graph's own history, which starts from {} the \
             backup does not have ({}).",
            commits(outgoing.len()),
            listed(&outgoing)
        ));
    }
    message.push_str(&format!(
        " If you expected this (for example, another device started its own graph and then \
         joined the backup), {}. If not, restore the backup repository from a good copy, or \
         re-clone this graph from the backup.",
        accept_hint(root, incoming.len() + outgoing.len())
    ));
    Err(AppError::io(message))
}

/// Why a push of `local` must not go out: it would upload a history root
/// the remote branch at `known` lacks and the graph at `root` has not
/// accepted. `None` when the push may proceed.
pub(super) fn push_refusal(
    repo: &Repository,
    root: &Path,
    local: Oid,
    known: Oid,
    accepted: &[Oid],
) -> AppResult<Option<String>> {
    let outgoing = unaccepted_roots(repo, local, known, accepted)?;
    if outgoing.is_empty() {
        return Ok(None);
    }
    Ok(Some(format!(
        "Sync paused: this graph's history starts from {} the backup does not have ({}), so \
         nothing was uploaded. Reflect never uploads a separate history on its own. If you \
         meant to join the two, {}. If not, re-clone this graph from the backup.",
        commits(outgoing.len()),
        listed(&outgoing),
        accept_hint(root, outgoing.len())
    )))
}

fn commits(count: usize) -> &'static str {
    if count == 1 {
        "a commit"
    } else {
        "commits"
    }
}

fn listed(ids: &[Oid]) -> String {
    ids.iter()
        .map(Oid::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// How to accept roots: the list loads at graph open, so an edit takes
/// effect only once the graph opens again.
fn accept_hint(root: &Path, count: usize) -> String {
    let pronoun = if count == 1 { "it" } else { "them" };
    format!(
        "add {pronoun} to \"{SETTINGS_KEY}\" under \"{}\" in Reflect's settings.json, then \
         reopen the graph",
        root.display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const ROOT_A: &str = "d39c5fa0d39c5fa0d39c5fa0d39c5fa0d39c5fa0";
    const ROOT_B: &str = "0123456789abcdef0123456789abcdef01234567";

    fn load(settings: Value, root: &Path) -> LoadedRoots {
        match settings {
            Value::Object(doc) => from_settings(&doc, root),
            _ => panic!("settings document must be an object"),
        }
    }

    fn oid(text: &str) -> Oid {
        Oid::from_str(text).unwrap()
    }

    #[test]
    fn an_unconfigured_graph_accepts_no_roots_without_a_warning() {
        assert_eq!(
            load(json!({}), Path::new("/vaults/notes")),
            LoadedRoots::default()
        );
    }

    #[test]
    fn full_ids_load_in_either_case_and_once() {
        let settings = json!({ SETTINGS_KEY: {
            "/vaults/notes": [ROOT_A, ROOT_B.to_uppercase(), ROOT_A]
        } });
        let loaded = load(settings, Path::new("/vaults/notes"));
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
            let settings = json!({ SETTINGS_KEY: { "/vaults/notes": [value.clone(), ROOT_A] } });
            let loaded = load(settings, Path::new("/vaults/notes"));
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
    fn a_malformed_key_or_entry_is_reported_and_accepts_nothing() {
        let loaded = load(
            json!({ SETTINGS_KEY: [ROOT_A] }),
            Path::new("/vaults/notes"),
        );
        assert!(loaded.roots.is_empty());
        assert!(loaded.warnings[0].contains("must map graph folders"));

        let settings = json!({ SETTINGS_KEY: { "/vaults/notes": ROOT_A } });
        let loaded = load(settings, Path::new("/vaults/notes"));
        assert!(loaded.roots.is_empty());
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("must be a list"));
    }

    #[test]
    fn a_key_naming_a_folder_that_does_not_exist_is_reported() {
        let settings = json!({ SETTINGS_KEY: { "/vaults/notse": [ROOT_A] } });
        let loaded = load(settings, Path::new("/vaults/notes"));
        assert!(loaded.roots.is_empty());
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("/vaults/notse"));
        // Another existing graph's entry is no concern of this one.
        let other = tempfile::tempdir().unwrap();
        let key = other.path().to_string_lossy().into_owned();
        let loaded = load(
            json!({ SETTINGS_KEY: { key: [ROOT_A] } }),
            Path::new("/vaults/notes"),
        );
        assert_eq!(loaded, LoadedRoots::default());
    }

    #[test]
    fn a_non_canonical_key_matches_the_same_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        let spelled = format!("{}/./", root.display());
        let loaded = load(json!({ SETTINGS_KEY: { spelled: [ROOT_A] } }), &root);
        assert_eq!(loaded.roots, vec![oid(ROOT_A)]);
        assert!(loaded.warnings.is_empty(), "{:?}", loaded.warnings);
    }

    /// The key round-trips through the settings store: the app's own save
    /// keeps it as written, and the next graph open loads it.
    #[test]
    fn the_key_survives_an_app_save_and_loads_at_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let root = dir.path().join("vault");
        std::fs::create_dir_all(&root).unwrap();
        crate::settings::TEST_STORE_PATH.with(|store| *store.borrow_mut() = Some(path.clone()));
        let key = root.to_string_lossy().into_owned();
        let edited = json!({ SETTINGS_KEY: { key.clone(): [ROOT_A, "d39c5fa"] } });
        std::fs::write(&path, serde_json::to_vec(&edited).unwrap()).unwrap();

        let mut app_copy = SettingsDoc::new();
        app_copy.insert("theme".into(), json!("dark"));
        crate::settings::settings_save(app_copy).unwrap();
        let loaded = load_for_root(&root);
        crate::settings::TEST_STORE_PATH.with(|store| *store.borrow_mut() = None);

        assert_eq!(loaded.roots, vec![oid(ROOT_A)]);
        assert_eq!(loaded.warnings.len(), 1, "{:?}", loaded.warnings);
        assert!(loaded.warnings[0].contains("\"d39c5fa\""));
    }
}
