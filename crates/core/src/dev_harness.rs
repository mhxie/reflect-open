//! Development-build overrides read from the environment. A release build
//! ignores every one of them.

use std::path::PathBuf;

#[cfg(not(test))]
use reflect_types::AppError;
use reflect_types::AppResult;

#[cfg(not(test))]
const CONFIG_DIR_ENV: &str = "REFLECT_DEV_CONFIG_DIR";

/// The path in the environment variable `name`, in a debug build only.
pub fn dev_env_path(name: &str) -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// The OS config directory, or the development override of it.
#[cfg(not(test))]
pub fn config_dir() -> AppResult<PathBuf> {
    match dev_env_path(CONFIG_DIR_ENV) {
        Some(dir) => Ok(dir),
        None => dirs::config_dir().ok_or_else(|| AppError::io("no OS config dir")),
    }
}

/// A directory of this test process's own, never the user's. A command that
/// opens a graph records it in recents, and tests that did so against the real
/// directory pushed the user's graphs out of their list.
#[cfg(test)]
pub fn config_dir() -> AppResult<PathBuf> {
    static TEST_DIR: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let dir = TEST_DIR.get_or_init(|| tempfile::tempdir().expect("test config dir"));
    Ok(dir.path().to_path_buf())
}
