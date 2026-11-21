//! Development-build overrides read from the environment. A release build
//! ignores every one of them.

use std::path::PathBuf;

use reflect_types::{AppError, AppResult};

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
pub fn config_dir() -> AppResult<PathBuf> {
    match dev_env_path(CONFIG_DIR_ENV) {
        Some(dir) => Ok(dir),
        None => dirs::config_dir().ok_or_else(|| AppError::io("no OS config dir")),
    }
}
