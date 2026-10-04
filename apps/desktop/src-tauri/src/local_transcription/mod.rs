//! On-device audio-memo transcription (macOS): whisper.cpp on Metal. Models
//! download on demand into app data, never bundled, and transcription runs
//! off the UI thread. Recordings never leave the device; the only network
//! traffic is the model download and the optional update check, both against
//! Hugging Face. Every failure degrades to a reported state and leaves the
//! audio untouched: a recording that isn't decodable audio is reported once,
//! and any other failure leaves the memo pending for the next pass.

mod audio;
mod engine;
mod models;
mod updates;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use hf_hub::api::sync::ApiBuilder;
use hf_hub::api::Progress;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;
use engine::{Engine, TranscriptSegment};
use models::{ModelSpec, MODEL_REPO};
use updates::UpdateReport;

/// Where recordings live; transcription reads nothing else.
const AUDIO_MEMOS_PREFIX: &str = "audio-memos/";

const STATUS_EVENT: &str = "local-transcription:status";

/// Newly downloaded bytes between progress events: about two hundred events
/// for the full-precision turbo model.
const PROGRESS_EMIT_STEP: u64 = 8 * 1024 * 1024;

/// Run as the first line of `run`, before any thread exists: ggml reads
/// `GGML_METAL_NO_RESIDENCY` when it opens the Metal device. With residency
/// sets on, ggml asserts at process exit while a model is still loaded, so
/// quitting mid-transcription — or within the idle window — would end in a
/// crash report. Transcription is bursty; keeping its memory wired between
/// memos buys nothing.
pub fn prepare_process_environment() {
    if std::env::var_os("GGML_METAL_NO_RESIDENCY").is_none() {
        std::env::set_var("GGML_METAL_NO_RESIDENCY", "1");
    }
}

/// Byte counts for an active download.
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteProgress {
    pub downloaded: u64,
    pub total: u64,
}

/// One model's lifecycle, as the settings surface shows it.
#[derive(Clone, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum ModelStatus {
    /// Not on disk.
    Missing,
    /// A download is running; `progress` arrives once it is sized.
    Downloading {
        #[serde(skip_serializing_if = "Option::is_none")]
        progress: Option<ByteProgress>,
    },
    /// On disk and verified; transcription can use it.
    Ready,
    /// The first download failed; nothing usable is on disk.
    Failed { message: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    model: &'static str,
    status: ModelStatus,
}

/// What transcribing one recording concluded. Bytes that aren't decodable
/// audio are an answer about the recording rather than a failed call, so the
/// caller can record them once instead of retrying on every pass.
#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum LocalTranscript {
    /// The joined text plus timed segments.
    Transcribed {
        text: String,
        segments: Vec<TranscriptSegment>,
    },
    Undecodable {
        reason: String,
    },
}

/// Process-wide state: running or failed downloads by model id (a model
/// absent from the map is `Ready` or `Missing` by what the cache holds), and
/// the inference engine.
#[derive(Default)]
pub struct LocalTranscriptionState {
    downloads: Mutex<HashMap<&'static str, ModelStatus>>,
    engine: Engine,
}

fn lock_downloads<'a>(
    state: &'a LocalTranscriptionState,
) -> AppResult<MutexGuard<'a, HashMap<&'static str, ModelStatus>>> {
    state
        .downloads
        .lock()
        .map_err(|_| AppError::io("transcription download state lock poisoned"))
}

fn spec(model: &str) -> AppResult<&'static ModelSpec> {
    models::model_spec(model)
        .ok_or_else(|| AppError::not_found(format!("unknown transcription model: {model}")))
}

fn app_data(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|err| AppError::io(format!("no app data dir: {err}")))
}

/// The hf-hub cache the embedding runtime also uses, with the same override.
fn cache_dir(app: &AppHandle) -> AppResult<PathBuf> {
    match std::env::var("HF_HOME") {
        Ok(home) => Ok(PathBuf::from(home)),
        Err(_) => Ok(app_data(app)?.join("models")),
    }
}

fn endpoint() -> String {
    std::env::var("HF_ENDPOINT").unwrap_or_else(|_| "https://huggingface.co".to_string())
}

fn status_of(state: &LocalTranscriptionState, cache: &Path, spec: &ModelSpec) -> ModelStatus {
    let tracked = state
        .downloads
        .lock()
        .ok()
        .and_then(|downloads| downloads.get(spec.id).cloned());
    let cached = models::find_cached(cache, spec.file).is_some();
    match tracked {
        Some(status @ ModelStatus::Downloading { .. }) => status,
        Some(status @ ModelStatus::Failed { .. }) if !cached => status,
        _ if cached => ModelStatus::Ready,
        _ => ModelStatus::Missing,
    }
}

fn emit_status(app: &AppHandle, spec: &'static ModelSpec, status: ModelStatus) {
    let _ = app.emit(
        STATUS_EVENT,
        StatusEvent {
            model: spec.id,
            status,
        },
    );
}

struct DownloadTally {
    app: AppHandle,
    spec: &'static ModelSpec,
    downloaded: u64,
    total: u64,
    emitted: u64,
}

impl DownloadTally {
    fn emit(&mut self) {
        self.emitted = self.downloaded;
        let progress = Some(ByteProgress {
            downloaded: self.downloaded,
            total: self.total,
        });
        let state = self.app.state::<LocalTranscriptionState>();
        if let Ok(mut downloads) = state.downloads.lock() {
            downloads.insert(self.spec.id, ModelStatus::Downloading { progress });
        }
        emit_status(&self.app, self.spec, ModelStatus::Downloading { progress });
    }
}

/// hf-hub takes the reporter by value, so the tally lives behind an `Arc`.
#[derive(Clone)]
struct DownloadProgress(Arc<Mutex<DownloadTally>>);

impl Progress for DownloadProgress {
    fn init(&mut self, _size: usize, _filename: &str) {}

    fn update(&mut self, size: usize) {
        let Ok(mut tally) = self.0.lock() else {
            return;
        };
        tally.downloaded += size as u64;
        if tally.downloaded - tally.emitted >= PROGRESS_EMIT_STEP || tally.downloaded >= tally.total
        {
            tally.emit();
        }
    }

    fn finish(&mut self) {}
}

/// Fetch the model's current upstream bytes, verify them against their
/// SHA-256 etag, and prune the copy they supersede. A failed or corrupt
/// download leaves any earlier copy in place.
fn download(app: &AppHandle, cache: &Path, spec: &'static ModelSpec) -> Result<(), String> {
    let previous = models::find_cached(cache, spec.file).map(|copy| copy.etag);
    let api = ApiBuilder::new()
        .with_cache_dir(cache.to_path_buf())
        .with_endpoint(endpoint())
        .build()
        .map_err(|err| format!("hf-hub api: {err}"))?;
    let repo = api.model(MODEL_REPO.to_string());
    let metadata = api
        .metadata(&repo.url(spec.file))
        .map_err(|err| format!("sizing {}: {err}", spec.file))?;
    let mut tally = DownloadTally {
        app: app.clone(),
        spec,
        downloaded: 0,
        total: metadata.size() as u64,
        emitted: 0,
    };
    // Surface the total before the first chunk, so the bar starts at a real 0%.
    tally.emit();
    let pointer = repo
        .download_with_progress(spec.file, DownloadProgress(Arc::new(Mutex::new(tally))))
        .map_err(|err| format!("downloading {}: {err}", spec.file))?;
    let etag = metadata.etag();
    if models::is_sha256(etag) {
        let actual = models::file_sha256(&pointer).map_err(|err| format!("verifying: {err}"))?;
        if actual != etag {
            let _ = models::remove_cached(cache, spec.file, previous.as_deref());
            return Err("the downloaded model failed its checksum; try again".to_string());
        }
    }
    models::remove_cached(cache, spec.file, Some(etag))
        .map_err(|err| format!("pruning the superseded model: {err}"))
}

/// The model's current status (poll on mount; changes arrive as
/// `local-transcription:status` events).
#[tauri::command]
pub fn local_transcription_status(
    model: String,
    app: AppHandle,
    state: State<LocalTranscriptionState>,
) -> AppResult<ModelStatus> {
    let spec = spec(&model)?;
    Ok(status_of(&state, &cache_dir(&app)?, spec))
}

/// Download the model, or its newer upstream revision when one is already on
/// disk. Idempotent while a download runs. Fails with the download's error;
/// status events report download progress either way.
#[tauri::command]
pub async fn local_transcription_download(
    model: String,
    app: AppHandle,
    state: State<'_, LocalTranscriptionState>,
) -> AppResult<ModelStatus> {
    let spec = spec(&model)?;
    let cache = cache_dir(&app)?;
    {
        let mut downloads = lock_downloads(&state)?;
        if let Some(status @ ModelStatus::Downloading { .. }) = downloads.get(spec.id) {
            return Ok(status.clone());
        }
        downloads.insert(spec.id, ModelStatus::Downloading { progress: None });
    }
    emit_status(&app, spec, ModelStatus::Downloading { progress: None });

    // From here every path must settle the entry: a stuck `Downloading`
    // would make every later download return early.
    let task_app = app.clone();
    let task_cache = cache.clone();
    let result =
        match tauri::async_runtime::spawn_blocking(move || download(&task_app, &task_cache, spec))
            .await
        {
            Ok(result) => result,
            Err(err) => Err(format!("model download task panicked: {err}")),
        };
    {
        let mut downloads = lock_downloads(&state)?;
        match &result {
            Ok(()) => downloads.remove(spec.id),
            Err(message) => downloads.insert(
                spec.id,
                ModelStatus::Failed {
                    message: message.clone(),
                },
            ),
        };
    }
    if result.is_ok() {
        // An update replaced the weights; the next memo loads them fresh.
        state.engine.release();
    }
    let status = status_of(&state, &cache, spec);
    emit_status(&app, spec, status.clone());
    result.map_err(AppError::io)?;
    Ok(status)
}

/// Remove the model's cached files.
#[tauri::command]
pub fn local_transcription_delete(
    model: String,
    app: AppHandle,
    state: State<LocalTranscriptionState>,
) -> AppResult<ModelStatus> {
    let spec = spec(&model)?;
    let cache = cache_dir(&app)?;
    {
        let mut downloads = lock_downloads(&state)?;
        if matches!(
            downloads.get(spec.id),
            Some(ModelStatus::Downloading { .. })
        ) {
            return Err(AppError::io("the model is still downloading"));
        }
        downloads.remove(spec.id);
    }
    state.engine.release();
    models::remove_cached(&cache, spec.file, None)
        .map_err(|err| AppError::io(format!("deleting the model: {err}")))?;
    let status = status_of(&state, &cache, spec);
    emit_status(&app, spec, status.clone());
    Ok(status)
}

/// One recording to transcribe and how.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    /// Graph-relative path under `audio-memos/`.
    path: String,
    /// Pins the read to the issuing graph session.
    generation: u64,
    model: String,
    /// ISO 639 code; absent, empty, or `auto` detects it per recording.
    language: Option<String>,
    /// The user's hint, used as the model's initial prompt.
    prompt: Option<String>,
}

/// The recording `path` names in the graph session `generation` pins. The
/// transcript lands in an ordinary note, so a recording in a local-only
/// folder (an `audio-memos/` linked into one) is refused like a share.
fn recording_path(graph: &GraphState, generation: u64, path: &str) -> AppResult<PathBuf> {
    if !path.starts_with(AUDIO_MEMOS_PREFIX) || !reflect_graph_paths::is_attachment(path) {
        return Err(AppError::traversal(format!("not an audio memo: {path}")));
    }
    let (root, local_only) = crate::fs::graph_for(graph, Some(generation))?;
    crate::fs::resolve_shareable_in_graph(&root, path, local_only.as_deref())
}

/// Transcribe one recording under `audio-memos/` on the device. Pinned to
/// `generation` like every background-pass read: a graph switch mid-pass
/// must not transcribe the *new* graph's same-named file.
#[tauri::command]
pub async fn local_transcription_transcribe(
    request: TranscribeRequest,
    app: AppHandle,
    graph: State<'_, GraphState>,
    state: State<'_, LocalTranscriptionState>,
) -> AppResult<LocalTranscript> {
    let TranscribeRequest {
        path,
        generation,
        model,
        language,
        prompt,
    } = request;
    let spec = spec(&model)?;
    let recording = recording_path(&graph, generation, &path)?;
    let model_path = models::find_cached(&cache_dir(&app)?, spec.file)
        .ok_or_else(|| AppError::not_found("the on-device transcription model is not downloaded"))?
        .path;
    let language = language.filter(|code| !code.is_empty() && code != "auto");
    let prompt = prompt.filter(|hint| !hint.trim().is_empty());
    let engine = state.engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let samples = match audio::decode_channels(&recording) {
            Ok(tracks) => audio::downmix(tracks),
            Err(audio::DecodeError::Undecodable(detail)) => {
                return Ok(LocalTranscript::Undecodable {
                    reason: format!("the recording couldn't be decoded ({detail})"),
                })
            }
            Err(audio::DecodeError::Unreadable(detail)) => {
                return Err(format!("the recording couldn't be read ({detail})"))
            }
        };
        let segments = engine.transcribe(
            &model_path,
            &samples,
            language.as_deref(),
            prompt.as_deref(),
        )?;
        Ok(LocalTranscript::Transcribed {
            text: engine::join_segments(&segments),
            segments: segments
                .into_iter()
                .map(|segment| TranscriptSegment {
                    text: segment.text.trim().to_string(),
                    ..segment
                })
                .filter(|segment| !segment.text.is_empty())
                .collect(),
        })
    })
    .await
    .map_err(|err| AppError::io(format!("transcription task panicked: {err}")))?
    .map_err(|message: String| AppError::io(message))
}

/// Ask Hugging Face whether the model has a newer revision or the repo a newer
/// generation. Throttled to once a day unless `force`; see [`updates`].
#[tauri::command]
pub async fn local_transcription_check_updates(
    model: String,
    force: bool,
    app: AppHandle,
) -> AppResult<UpdateReport> {
    let spec = spec(&model)?;
    let cache = cache_dir(&app)?;
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        updates::check(&data, &cache, endpoint(), spec, force)
    })
    .await
    .map_err(|err| AppError::io(format!("update check task panicked: {err}")))?
    .map_err(AppError::io)
}

/// Stop offering the upstream revision `etag`.
#[tauri::command]
pub fn local_transcription_skip_update(etag: String, app: AppHandle) -> AppResult<()> {
    updates::skip(&app_data(&app)?, &etag);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact payload `transcribeLocally` (`packages/core`) sends.
    #[test]
    fn accepts_the_frontend_transcribe_request() {
        let request: TranscribeRequest = serde_json::from_value(serde_json::json!({
            "path": "audio-memos/audio-memo-2026-06-11-153022-845.m4a",
            "generation": 3,
            "model": "large-v3-turbo",
            "language": null,
            "prompt": "Names: Ocavue",
        }))
        .unwrap();
        assert_eq!(
            request.path,
            "audio-memos/audio-memo-2026-06-11-153022-845.m4a"
        );
        assert_eq!(request.generation, 3);
        assert_eq!(request.model, "large-v3-turbo");
        assert_eq!(request.language, None);
        assert_eq!(request.prompt.as_deref(), Some("Names: Ocavue"));
    }

    /// The shapes `localTranscriptSchema` (`packages/core`) parses.
    #[test]
    fn reports_outcomes_the_frontend_parses() {
        let transcribed = LocalTranscript::Transcribed {
            text: "Hello.".to_string(),
            segments: vec![TranscriptSegment {
                start_ms: 0,
                end_ms: 1_200,
                text: "Hello.".to_string(),
            }],
        };
        assert_eq!(
            serde_json::to_value(transcribed).unwrap(),
            serde_json::json!({
                "outcome": "transcribed",
                "text": "Hello.",
                "segments": [{ "startMs": 0, "endMs": 1200, "text": "Hello." }],
            })
        );
        let undecodable = LocalTranscript::Undecodable {
            reason: "no audio".to_string(),
        };
        assert_eq!(
            serde_json::to_value(undecodable).unwrap(),
            serde_json::json!({ "outcome": "undecodable", "reason": "no audio" })
        );
    }

    /// A recording in a real local-only folder, reached through an
    /// `audio-memos/` linked into it, is refused before it is read; the
    /// control session without folders resolves it.
    #[cfg(unix)]
    #[test]
    fn a_recording_in_a_local_only_folder_is_never_transcribed() {
        let memo = "audio-memos/audio-memo-2026-06-11-153022-845.m4a";
        for configured in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().canonicalize().unwrap();
            std::fs::create_dir_all(root.join("people/secure")).unwrap();
            std::os::unix::fs::symlink(root.join("people/secure"), root.join("audio-memos"))
                .unwrap();
            std::fs::write(
                root.join(memo.replace("audio-memos", "people/secure")),
                b"m4a",
            )
            .unwrap();
            let graph = GraphState::default();
            {
                let mut inner = graph.0.lock().unwrap();
                inner.generation = 1;
                inner.root = Some(root.clone());
                inner.set_local_only(if configured {
                    reflect_graph_paths::LocalOnlyFolders::new(["secure"], None)
                } else {
                    None
                });
            }
            let resolved = recording_path(&graph, 1, memo);
            assert_eq!(resolved.is_ok(), !configured, "{resolved:?}");
            if let Err(err) = resolved {
                assert!(format!("{err:?}").contains("local-only"), "{err:?}");
            }
        }
    }

    /// Decode → resample → whisper on a real recording. Needs
    /// `REFLECT_WHISPER_TEST_MODEL` (a ggml model) and `REFLECT_WHISPER_TEST_AUDIO`
    /// (m4a, WebM, or WAV speech); `REFLECT_WHISPER_TEST_EXPECT` optionally
    /// names a phrase the transcript must contain.
    #[test]
    #[ignore = "needs REFLECT_WHISPER_TEST_MODEL and REFLECT_WHISPER_TEST_AUDIO"]
    fn transcribes_a_real_recording() {
        prepare_process_environment();
        let model = PathBuf::from(std::env::var("REFLECT_WHISPER_TEST_MODEL").expect("model"));
        let recording = PathBuf::from(std::env::var("REFLECT_WHISPER_TEST_AUDIO").expect("audio"));
        let samples = audio::downmix(audio::decode_channels(&recording).unwrap());
        let segments = Engine::default()
            .transcribe(&model, &samples, None, None)
            .unwrap();
        let text = engine::join_segments(&segments);
        println!("{text}\n{segments:#?}");
        assert!(!segments.is_empty());
        assert!(segments
            .windows(2)
            .all(|pair| pair[0].start_ms <= pair[1].start_ms));
        if let Ok(expected) = std::env::var("REFLECT_WHISPER_TEST_EXPECT") {
            assert!(text.contains(&expected), "{text}");
        }
    }
}
