//! Dev-build affordances for running the app against a scratch graph without
//! touching an installed app's state, and for scoring search offline. Both
//! environment variables are ignored in release builds.
//!
//! - `REFLECT_DEV_CONFIG_DIR` relocates the per-user stores (settings, recent
//!   graphs, the capture pointer, browser host manifests). A dev app opened on
//!   a snapshot then never becomes the graph an installed app reopens, nor the
//!   target of browser captures.
//! - `REFLECT_SEARCH_EVAL` names a job file the dev app polls for (see
//!   `apps/desktop/src/dev/search-eval-runner.tsx`). Whoever writes the job
//!   decides when the index is ready, so a run never races the first pass.

use std::path::PathBuf;

use crate::error::{AppError, AppResult};

const CONFIG_DIR_ENV: &str = "REFLECT_DEV_CONFIG_DIR";
const SEARCH_EVAL_ENV: &str = "REFLECT_SEARCH_EVAL";

fn dev_env_path(name: &str) -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The directory the per-user stores live under: the OS config dir, unless a
/// dev build is pointed elsewhere.
pub fn config_dir() -> AppResult<PathBuf> {
    match dev_env_path(CONFIG_DIR_ENV) {
        Some(dir) => Ok(dir),
        None => dirs::config_dir().ok_or_else(|| AppError::io("no OS config dir")),
    }
}

/// The pending search-evaluation job, if this dev app was started with one
/// and it hasn't run yet.
#[tauri::command]
pub fn dev_search_eval_poll() -> AppResult<Option<serde_json::Value>> {
    let Some(job) = dev_env_path(SEARCH_EVAL_ENV) else {
        return Ok(None);
    };
    match std::fs::read_to_string(&job) {
        Ok(raw) => serde_json::from_str(&raw)
            .map(Some)
            .map_err(|err| AppError::parse(format!("search eval job: {err}"))),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err.into()),
    }
}

/// Write a job's results beside it (`<job>.results.json`) and retire the job
/// (`<job>.done.json`), so the next poll waits for a new one.
#[tauri::command]
pub fn dev_search_eval_finish(results: serde_json::Value) -> AppResult<()> {
    let job = dev_env_path(SEARCH_EVAL_ENV)
        .ok_or_else(|| AppError::io("this build has no search eval job"))?;
    let body =
        serde_json::to_string_pretty(&results).map_err(|err| AppError::parse(err.to_string()))?;
    std::fs::write(job.with_extension("results.json"), body)?;
    std::fs::rename(&job, job.with_extension("done.json"))?;
    Ok(())
}
