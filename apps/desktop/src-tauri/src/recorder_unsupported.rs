//! Stand-in for platforms without the recorder (everything but macOS):
//! the identical command surface, so `invoke_handler` needs no platform
//! branches. Status reports unsupported; every action fails.

use serde::Serialize;
use tauri::AppHandle;

use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct RecorderState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    supported: bool,
    default_recordings_folder: String,
    recording: Option<()>,
}

#[derive(Serialize)]
pub struct Unavailable;

fn unsupported() -> AppError {
    AppError::io("recording system audio is only available on macOS")
}

pub fn shutdown(app: &AppHandle) {
    let _ = app;
}

#[tauri::command]
pub fn recorder_status() -> CaptureStatus {
    CaptureStatus {
        supported: false,
        default_recordings_folder: String::new(),
        recording: None,
    }
}

#[tauri::command]
pub fn recorder_start() -> AppResult<CaptureStatus> {
    Err(unsupported())
}

#[tauri::command]
pub fn recorder_stop() -> AppResult<CaptureStatus> {
    Ok(recorder_status())
}

#[tauri::command]
pub fn recorder_cancel() -> AppResult<CaptureStatus> {
    Ok(recorder_status())
}

#[tauri::command]
pub fn recorder_sessions() -> Vec<Unavailable> {
    Vec::new()
}

#[tauri::command]
pub async fn recorder_transcribe(request: serde_json::Value) -> AppResult<Unavailable> {
    let _ = request;
    Err(unsupported())
}

#[tauri::command]
pub async fn recorder_archive(request: serde_json::Value) -> AppResult<()> {
    let _ = request;
    Err(unsupported())
}

#[tauri::command]
pub fn recorder_configure(config: serde_json::Value) -> AppResult<()> {
    let _ = config;
    Ok(())
}
