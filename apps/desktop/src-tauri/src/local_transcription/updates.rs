//! Model update discovery. A downloaded model is pinned to the bytes it was
//! downloaded as — transcription never follows upstream silently — so newer
//! weights arrive only when the user accepts them. Two kinds are reported:
//! a new revision of the selected model's own file (its etag moved), offered
//! as an update; and a newer model generation in the repo, only announced,
//! since the app can't offer a model its catalog doesn't know.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use hf_hub::api::sync::ApiBuilder;
use serde::{Deserialize, Serialize};

use super::models::{self, ModelSpec, CATALOG_GENERATION, MODEL_REPO};

/// Upstream checks run at most this often unless forced.
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;

/// Persisted next to the models, outside every graph.
const STATE_FILE: &str = "local-transcription-updates.json";

/// A newer revision of the selected model's file.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionUpdate {
    pub etag: String,
    pub size_bytes: u64,
}

/// What a check found; empty when nothing is new or the check was throttled.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    pub revision: Option<RevisionUpdate>,
    /// Model generations newer than the catalog, each reported once.
    pub generations: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct UpdateState {
    last_checked_secs: u64,
    skipped_etags: BTreeSet<String>,
    announced_generations: BTreeSet<String>,
}

/// Check upstream for `model`. A model that isn't downloaded has nothing to
/// update; network failures surface as errors the caller may ignore.
pub fn check(
    app_data: &Path,
    cache_dir: &Path,
    endpoint: String,
    model: &ModelSpec,
    force: bool,
) -> Result<UpdateReport, String> {
    let state_path = app_data.join(STATE_FILE);
    let mut state = load_state(&state_path);
    let now = unix_now();
    if !force && now.saturating_sub(state.last_checked_secs) < CHECK_INTERVAL_SECS {
        return Ok(UpdateReport::default());
    }
    let Some(cached) = models::find_cached(cache_dir, model.file) else {
        return Ok(UpdateReport::default());
    };

    let api = ApiBuilder::new()
        .with_cache_dir(cache_dir.to_path_buf())
        .with_endpoint(endpoint)
        .build()
        .map_err(|err| format!("hf-hub api: {err}"))?;
    let repo = api.model(MODEL_REPO.to_string());
    let remote = api
        .metadata(&repo.url(model.file))
        .map_err(|err| format!("checking {}: {err}", model.file))?;
    let files: Vec<String> = repo
        .info()
        .map_err(|err| format!("listing {MODEL_REPO}: {err}"))?
        .siblings
        .into_iter()
        .map(|sibling| sibling.rfilename)
        .collect();

    let revision = (remote.etag() != cached.etag && !state.skipped_etags.contains(remote.etag()))
        .then(|| RevisionUpdate {
            etag: remote.etag().to_string(),
            size_bytes: remote.size() as u64,
        });
    let generations: Vec<String> = newer_generations(&files, CATALOG_GENERATION)
        .into_iter()
        .filter(|generation| state.announced_generations.insert(generation.clone()))
        .collect();
    state.last_checked_secs = now;
    save_state(&state_path, &state);
    Ok(UpdateReport {
        revision,
        generations,
    })
}

/// Stop offering the revision whose etag is `etag`.
pub fn skip(app_data: &Path, etag: &str) {
    let state_path = app_data.join(STATE_FILE);
    let mut state = load_state(&state_path);
    if state.skipped_etags.insert(etag.to_string()) {
        save_state(&state_path, &state);
    }
}

/// Generations newer than `known` named by the repo's files, e.g.
/// `ggml-large-v4-turbo-q5_0.bin` → `large-v4-turbo`. Quantizations of one
/// generation collapse into a single name.
pub fn newer_generations(files: &[String], known: u32) -> Vec<String> {
    let mut generations = BTreeSet::new();
    for file in files {
        let Some(rest) = file
            .strip_prefix("ggml-large-v")
            .and_then(|rest| rest.strip_suffix(".bin"))
        else {
            continue;
        };
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        let Ok(version) = digits.parse::<u32>() else {
            continue;
        };
        if version <= known {
            continue;
        }
        let turbo = rest[digits.len()..].starts_with("-turbo");
        generations.insert(format!(
            "large-v{version}{}",
            if turbo { "-turbo" } else { "" }
        ));
    }
    generations.into_iter().collect()
}

fn load_state(path: &Path) -> UpdateState {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Best effort: a lost write only means the next launch checks again.
fn save_state(path: &Path, state: &UpdateState) {
    let Ok(raw) = serde_json::to_string_pretty(state) else {
        return;
    };
    let temporary = PathBuf::from(format!("{}.tmp", path.display()));
    if fs::write(&temporary, raw).is_ok() {
        let _ = fs::rename(&temporary, path);
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(files: &[&str]) -> Vec<String> {
        files.iter().map(|file| file.to_string()).collect()
    }

    #[test]
    fn collapses_quantizations_into_generations() {
        let files = names(&[
            "ggml-large-v3-turbo.bin",
            "ggml-large-v3-q5_0.bin",
            "ggml-large-v4.bin",
            "ggml-large-v4-q5_0.bin",
            "ggml-large-v4-turbo-q8_0.bin",
            "ggml-large-v10-encoder.mlmodelc.zip",
            "README.md",
        ]);
        assert_eq!(newer_generations(&files, 3), ["large-v4", "large-v4-turbo"]);
        assert!(newer_generations(&files, 4).is_empty());
    }

    #[test]
    fn throttles_and_skips_without_touching_the_network() {
        let app_data = tempfile::tempdir().unwrap();
        let state_path = app_data.path().join(STATE_FILE);
        save_state(
            &state_path,
            &UpdateState {
                last_checked_secs: unix_now(),
                ..UpdateState::default()
            },
        );
        // Throttled: a recent check returns nothing before any network call.
        let report = check(
            app_data.path(),
            app_data.path(),
            "http://127.0.0.1:9".to_string(),
            &models::MODELS[0],
            false,
        )
        .unwrap();
        assert_eq!(report, UpdateReport::default());

        skip(app_data.path(), "abc");
        skip(app_data.path(), "abc");
        let state = load_state(&state_path);
        assert_eq!(state.skipped_etags.into_iter().collect::<Vec<_>>(), ["abc"]);
    }

    #[test]
    fn a_model_that_is_not_downloaded_has_nothing_to_update() {
        let app_data = tempfile::tempdir().unwrap();
        let report = check(
            app_data.path(),
            app_data.path(),
            "http://127.0.0.1:9".to_string(),
            &models::MODELS[0],
            true,
        )
        .unwrap();
        assert_eq!(report, UpdateReport::default());
    }
}
