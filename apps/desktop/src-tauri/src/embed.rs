//! The local embedding runtime (Plan 09): fastembed (ONNX) in-process, off the
//! UI thread. The model is chosen from [`MODELS`] (all-MiniLM-L6-v2 unless the
//! settings pick another), downloaded on demand into app data — never bundled —
//! and every failure degrades to a reported "unavailable" state (the same
//! recoverable contract as sqlite-vec): semantic search is strictly additive,
//! so nothing here may ever take the app down.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use hf_hub::api::sync::ApiBuilder;
use hf_hub::api::Progress;
use hf_hub::Cache;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};

/// One model the runtime can load. `id` is stored with every chunk and in
/// `index_meta.embeddingModel`, so switching models re-embeds the graph into
/// a vector table of the new width.
pub struct ModelSpec {
    pub id: &'static str,
    model: EmbeddingModel,
    /// Prepended to search queries and to stored passages: EmbeddingGemma was
    /// trained on task prompts, while MiniLM takes raw text.
    query_prefix: &'static str,
    passage_prefix: &'static str,
}

/// The models on offer; the first is the default (the original model, so an
/// existing index keeps its vector table's width).
pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: "all-MiniLM-L6-v2",
        model: EmbeddingModel::AllMiniLML6V2,
        query_prefix: "",
        passage_prefix: "",
    },
    ModelSpec {
        id: "embeddinggemma-300m",
        model: EmbeddingModel::EmbeddingGemma300M,
        query_prefix: "task: search result | query: ",
        passage_prefix: "title: none | text: ",
    },
];

fn model_spec(id: Option<&str>) -> AppResult<&'static ModelSpec> {
    match id {
        None => Ok(&MODELS[0]),
        Some(id) => MODELS
            .iter()
            .find(|spec| spec.id == id)
            .ok_or_else(|| AppError::parse(format!("unknown embedding model: {id}"))),
    }
}

/// The tokenizer files fastembed reads beside every model.
const TOKENIZER_FILES: [&str; 4] = [
    "tokenizer.json",
    "config.json",
    "special_tokens_map.json",
    "tokenizer_config.json",
];

/// Texts per model run. A long note's chunks arrive in one call, and fastembed
/// would otherwise run them as one batch padded to the longest: ONNX Runtime's
/// arena then grows to that peak and keeps it (13 GB seen on a real graph), while
/// small batches are no slower on CPU since they pad less.
const MODEL_BATCH_SIZE: usize = 8;

/// Whether a text is a search query or a stored passage; the models that were
/// trained with prefixes embed the two differently.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextRole {
    Query,
    #[default]
    Passage,
}
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const ONNX_RUNTIME_DYLIB_RESOURCE: &str = "libonnxruntime.dylib";

/// Byte counts for an active model download. Absent until the download
/// starts (cache probing, or a cached model that skips downloading); after
/// the last byte it stays at 100% through the model-load phase.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteProgress {
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum EmbedStatus {
    /// No model loaded yet; `embed_ensure` will download/load it.
    Uninitialized,
    /// Download/load in progress (first run downloads ~90MB). The runtime
    /// keeps the latest byte counts, so polls and `embed:status` events
    /// report the same progress.
    Loading {
        #[serde(skip_serializing_if = "Option::is_none")]
        progress: Option<ByteProgress>,
    },
    /// `embed_texts` is ready; `model` is recorded per vector (rebuild key)
    /// and `dims` is the width its vector table must have.
    Ready { model: String, dims: usize },
    /// Load failed; semantic search is unavailable (lexical still works).
    Failed { message: String },
}

/// A loaded model and what callers need to know about it.
struct Loaded {
    spec: &'static ModelSpec,
    dims: usize,
    // fastembed's `embed` takes `&mut self`, so the model sits behind its own
    // Mutex — embed calls serialize, which batching makes irrelevant.
    model: Arc<Mutex<TextEmbedding>>,
}

#[derive(Default)]
enum Runtime {
    #[default]
    Uninitialized,
    Loading {
        progress: Option<ByteProgress>,
    },
    Ready(Arc<Loaded>),
    Failed(String),
}

/// Process-wide embedding runtime state.
#[derive(Default)]
pub struct EmbedState(Mutex<Runtime>);

fn lock_state<'a>(
    state: &'a State<'a, EmbedState>,
) -> AppResult<std::sync::MutexGuard<'a, Runtime>> {
    state.0.lock().map_err(|err| {
        tracing::error!(?err, "embed state lock poisoned by an earlier panic");
        AppError::io("embed state lock poisoned")
    })
}

fn status_of(runtime: &Runtime) -> EmbedStatus {
    match runtime {
        Runtime::Uninitialized => EmbedStatus::Uninitialized,
        Runtime::Loading { progress } => EmbedStatus::Loading {
            progress: *progress,
        },
        Runtime::Ready(loaded) => EmbedStatus::Ready {
            model: loaded.spec.id.to_string(),
            dims: loaded.dims,
        },
        Runtime::Failed(message) => EmbedStatus::Failed {
            message: message.clone(),
        },
    }
}

fn emit_status(app: &AppHandle, status: &EmbedStatus) {
    let _ = app.emit("embed:status", status);
}

/// Record download progress on the runtime state, so an `embed_status` poll
/// (e.g. a UI surface mounted mid-download) reports the same bytes as the
/// `embed:status` events. Only an in-flight load is updated — by the time a
/// stale progress callback could land, the state owns a terminal status.
fn store_progress(app: &AppHandle, progress: ByteProgress) {
    let state = app.state::<EmbedState>();
    let Ok(mut runtime) = state.0.lock() else {
        return;
    };
    if matches!(*runtime, Runtime::Loading { .. }) {
        *runtime = Runtime::Loading {
            progress: Some(progress),
        };
    }
}

/// How many newly-downloaded bytes accumulate between progress events — about
/// ninety events for the full model, comfortably few for the IPC channel yet
/// smooth enough for a progress bar.
const PROGRESS_EMIT_STEP: u64 = 1024 * 1024;

struct DownloadState {
    app: AppHandle,
    downloaded: u64,
    total: u64,
    emitted: u64,
}

impl DownloadState {
    fn emit(&mut self) {
        self.emitted = self.downloaded;
        let progress = ByteProgress {
            downloaded: self.downloaded,
            total: self.total,
        };
        store_progress(&self.app, progress);
        emit_status(
            &self.app,
            &EmbedStatus::Loading {
                progress: Some(progress),
            },
        );
    }
}

/// Cumulative byte progress across the whole file set, surfaced as
/// `embed:status` events. hf-hub takes the reporter by value per file, so the
/// shared tally lives behind an `Arc` and each download gets a clone.
#[derive(Clone)]
struct DownloadProgress(Arc<Mutex<DownloadState>>);

impl DownloadProgress {
    fn new(app: AppHandle, total: u64) -> Self {
        let mut state = DownloadState {
            app,
            downloaded: 0,
            total,
            emitted: 0,
        };
        // Surface the total before the first chunk lands, so the bar starts
        // at a real 0% instead of indeterminate.
        state.emit();
        Self(Arc::new(Mutex::new(state)))
    }
}

impl Progress for DownloadProgress {
    fn init(&mut self, _size: usize, _filename: &str) {}

    fn update(&mut self, size: usize) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        state.downloaded += size as u64;
        if state.downloaded - state.emitted >= PROGRESS_EMIT_STEP || state.downloaded >= state.total
        {
            state.emit();
        }
    }

    fn finish(&mut self) {}
}

/// Fetch whatever model files are missing from the cache, with byte progress.
/// fastembed downloads these itself inside `try_new`, but silently; fetching
/// them first through the same hf-hub cache gives the UI a real progress bar
/// and leaves `try_new` a pure cache hit. Mirrors fastembed's resolution —
/// its model table for the repo and files, env overrides included — so both
/// sides agree on location and endpoint. Returns the model's vector width.
fn download_model_files(
    app: &AppHandle,
    cache_dir: &Path,
    spec: &ModelSpec,
) -> Result<usize, String> {
    let info = TextEmbedding::get_model_info(&spec.model).map_err(|err| err.to_string())?;
    let cache_dir = std::env::var("HF_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| cache_dir.to_path_buf());
    let endpoint =
        std::env::var("HF_ENDPOINT").unwrap_or_else(|_| "https://huggingface.co".to_string());

    let files: Vec<String> = std::iter::once(info.model_file.clone())
        .chain(info.additional_files.iter().cloned())
        .chain(TOKENIZER_FILES.iter().map(|file| (*file).to_string()))
        .collect();
    let cached = Cache::new(cache_dir.clone()).model(info.model_code.clone());
    let missing: Vec<&str> = files
        .iter()
        .map(String::as_str)
        .filter(|file| cached.get(file).is_none())
        .collect();
    if missing.is_empty() {
        return Ok(info.dim);
    }

    let api = ApiBuilder::new()
        .with_cache_dir(cache_dir)
        .with_endpoint(endpoint)
        .build()
        .map_err(|err| format!("hf-hub api: {err}"))?;
    let repo = api.model(info.model_code.clone());

    // Size every missing file up front (HEAD-weight requests, ~nothing next
    // to the 90MB body) so the bar tracks one stable total instead of
    // restarting per file.
    let mut total: u64 = 0;
    for file in &missing {
        total += api
            .metadata(&repo.url(file))
            .map_err(|err| format!("sizing {file}: {err}"))?
            .size() as u64;
    }

    let progress = DownloadProgress::new(app.clone(), total);
    for file in missing {
        repo.download_with_progress(file, progress.clone())
            .map_err(|err| format!("downloading {file}: {err}"))?;
    }
    Ok(info.dim)
}

fn configure_onnx_runtime(app: &AppHandle) -> Result<(), String> {
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        let dylib = app
            .path()
            .resource_dir()
            .map_err(|err| format!("locating app resources: {err}"))?
            .join(ONNX_RUNTIME_DYLIB_RESOURCE);
        if !dylib.exists() {
            return Err(format!(
                "ONNX Runtime library is missing from app resources: {}",
                dylib.display()
            ));
        }
        let committed = ort::init_from(&dylib)
            .map_err(|err| format!("loading ONNX Runtime from {}: {err}", dylib.display()))?
            .commit();
        if committed {
            tracing::info!(path = %dylib.display(), "loaded bundled ONNX Runtime");
        }
    }
    #[cfg(not(all(target_os = "macos", target_arch = "x86_64")))]
    {
        let _ = app;
    }
    Ok(())
}

/// Current runtime status (poll on startup; live changes arrive on
/// `embed:status` events).
#[tauri::command]
pub fn embed_status(state: State<EmbedState>) -> AppResult<EmbedStatus> {
    Ok(status_of(&*lock_state(&state)?))
}

/// Ensure `model` (the default when absent) is loaded, downloading it on first
/// use; a different model already loaded is replaced. Idempotent: a concurrent
/// call while loading returns immediately (the event stream carries the
/// outcome). Runs the load on a blocking thread — model init is seconds even
/// when cached, and the first run downloads.
#[tauri::command]
pub async fn embed_ensure(
    model: Option<String>,
    app: AppHandle,
    state: State<'_, EmbedState>,
) -> AppResult<EmbedStatus> {
    let spec = model_spec(model.as_deref())?;
    // Resolve the cache dir BEFORE flipping to Loading: it's the only step
    // here that may fail without a guaranteed state transition afterwards.
    let cache_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| AppError::io(format!("no app data dir: {err}")))?
        .join("models");

    {
        let mut runtime = lock_state(&state)?;
        match &*runtime {
            Runtime::Ready(loaded) if std::ptr::eq(loaded.spec, spec) => {
                return Ok(status_of(&runtime))
            }
            Runtime::Loading { .. } => return Ok(status_of(&runtime)),
            Runtime::Ready(_) | Runtime::Uninitialized | Runtime::Failed(_) => {
                *runtime = Runtime::Loading { progress: None };
            }
        }
    }
    emit_status(&app, &EmbedStatus::Loading { progress: None });

    // From here every path — success, load failure, even a panicked blocking
    // task — must land the state in Ready or Failed: an early `?` would wedge
    // the runtime in Loading forever (later ensures return early on Loading).
    let app_for_progress = app.clone();
    let loaded: Result<Loaded, String> = match tauri::async_runtime::spawn_blocking(move || {
        configure_onnx_runtime(&app_for_progress)?;
        let dims = download_model_files(&app_for_progress, &cache_dir, spec)?;
        let model =
            TextEmbedding::try_new(InitOptions::new(spec.model.clone()).with_cache_dir(cache_dir))
                .map_err(|err| err.to_string())?;
        Ok(Loaded {
            spec,
            dims,
            model: Arc::new(Mutex::new(model)),
        })
    })
    .await
    {
        Ok(result) => result,
        Err(err) => Err(format!("embedding load task panicked: {err}")),
    };

    let status = {
        let mut runtime = lock_state(&state)?;
        *runtime = match loaded {
            Ok(loaded) => Runtime::Ready(Arc::new(loaded)),
            Err(message) => {
                tracing::error!(message, model = spec.id, "embedding model load failed");
                Runtime::Failed(message)
            }
        };
        status_of(&runtime)
    };
    emit_status(&app, &status);
    Ok(status)
}

/// The loaded model, provided it is `expected` when the caller names one: a
/// caller that read the model id before a switch must not receive another
/// model's vectors under that id.
fn loaded_model(runtime: &Runtime, expected: Option<&str>) -> AppResult<Arc<Loaded>> {
    match runtime {
        Runtime::Ready(loaded) if expected.is_none_or(|model| model == loaded.spec.id) => {
            Ok(Arc::clone(loaded))
        }
        Runtime::Ready(_) => Err(AppError::io(
            "the embedding model changed; embed again with the loaded model",
        )),
        _ => Err(AppError::io("embedding model is not loaded")),
    }
}

/// Embed a batch of texts into the loaded model's vectors, off the UI thread,
/// prefixed for their `role` as the model expects. Errors if the model isn't
/// `Ready` (callers gate on `embed_status`/`embed_ensure`), or isn't `model`
/// when the caller names the one it expects.
#[tauri::command]
pub async fn embed_texts(
    texts: Vec<String>,
    role: Option<TextRole>,
    model: Option<String>,
    state: State<'_, EmbedState>,
) -> AppResult<Vec<Vec<f32>>> {
    let loaded = {
        let runtime = lock_state(&state)?;
        loaded_model(&runtime, model.as_deref())?
    };
    let prefix = match role.unwrap_or_default() {
        TextRole::Query => loaded.spec.query_prefix,
        TextRole::Passage => loaded.spec.passage_prefix,
    };
    let texts: Vec<String> = if prefix.is_empty() {
        texts
    } else {
        texts
            .into_iter()
            .map(|text| format!("{prefix}{text}"))
            .collect()
    };
    tauri::async_runtime::spawn_blocking(move || {
        let mut model = loaded
            .model
            .lock()
            .map_err(|_| AppError::io("embedding model lock poisoned"))?;
        model
            .embed(texts, Some(MODEL_BATCH_SIZE))
            .map_err(|err| AppError::io(format!("embedding failed: {err}")))
    })
    .await
    .map_err(|err| AppError::io(format!("embedding task panicked: {err}")))?
}
