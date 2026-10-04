//! Stand-in for platforms without on-device transcription (everything but
//! macOS): the identical command surface, so `invoke_handler` needs no
//! platform branches. Status reports `unsupported`; every action fails.

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

// Braced, not a unit struct, so `lib.rs` builds it with `::default()` like
// the macOS state.
#[derive(Default)]
pub struct LocalTranscriptionState {}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum ModelStatus {
    Unsupported,
}

#[derive(Serialize)]
pub struct Unavailable;

fn unsupported() -> AppError {
    AppError::io("on-device transcription is only available on macOS")
}

#[tauri::command]
pub fn local_transcription_status(model: String) -> AppResult<ModelStatus> {
    let _ = model;
    Ok(ModelStatus::Unsupported)
}

#[tauri::command]
pub async fn local_transcription_download(model: String) -> AppResult<ModelStatus> {
    let _ = model;
    Err(unsupported())
}

#[tauri::command]
pub fn local_transcription_delete(model: String) -> AppResult<ModelStatus> {
    let _ = model;
    Err(unsupported())
}

#[tauri::command]
pub async fn local_transcription_transcribe(
    request: serde_json::Value,
    graph: State<'_, GraphState>,
    state: State<'_, LocalTranscriptionState>,
) -> AppResult<Unavailable> {
    let _ = (request, graph, state);
    Err(unsupported())
}

#[tauri::command]
pub async fn local_transcription_check_updates(
    model: String,
    force: bool,
) -> AppResult<Unavailable> {
    let _ = (model, force);
    Err(unsupported())
}

#[tauri::command]
pub fn local_transcription_skip_update(etag: String) -> AppResult<()> {
    let _ = etag;
    Err(unsupported())
}
