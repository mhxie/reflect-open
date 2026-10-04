//! The recorder (macOS 14.2+): every recording on the Mac, a memo or a call,
//! captures the microphone ("Me") and everything the Mac plays ("Them") as
//! two channels on one clock, then transcribes both on the device. A
//! two-sided call needs no diarization: who spoke is which channel it arrived
//! on.
//!
//! Rust owns the capability: capture, the watchdog, the staging store, echo
//! suppression and per-channel transcription, archiving the audio, and the
//! menu bar item and global shortcut that start and stop a recording from
//! another app. What a transcript becomes (the note, the daily-note links,
//! whether a calendar event makes it a meeting) is policy in `@reflect/core`.
//! Nothing here touches the network.

mod audio_file;
mod device;
mod echo;
mod menu_bar;
mod session;
mod transcribe;
mod watchdog;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::MenuEvent;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::activity::ActivityGuard;
use crate::error::{AppError, AppResult};
use crate::local_transcription::LocalTranscriptionState;
use device::Capture;
use menu_bar::{Display, MenuBar};
use session::{now_ms, part_file, part_path, FinishedSession, PartRecord, SessionManifest, Store};
use transcribe::{ModelChoice, RecordingTranscript};
use watchdog::{Action, Observation, Warning, Watchdog};

const STATUS_EVENT: &str = "recorder:status";
const LEVEL_EVENT: &str = "recorder:level";
/// How often the input level reaches the recording panel's waveform.
const LEVEL_INTERVAL: Duration = Duration::from_millis(60);
const WARNING_EVENT: &str = "recorder:warning";
const RECORDED_EVENT: &str = "recorder:recorded";

/// The live recording, if any, as the frontend sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    /// False below macOS 14.2, where process taps don't exist.
    supported: bool,
    /// Where recordings are archived when the user hasn't chosen a folder.
    default_recordings_folder: String,
    recording: Option<ActiveRecording>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRecording {
    session_id: String,
    started_at_ms: u64,
    warnings: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WarningEvent {
    session_id: String,
    code: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordedEvent {
    session_id: String,
}

/// User settings the frontend pushes whenever they change.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureConfig {
    menu_bar: bool,
    /// An accelerator such as `Control+Alt+Super+KeyM`; absent turns it off.
    shortcut: Option<String>,
    /// Where archived recordings go, for the menu's "Open Recordings Folder".
    recordings_folder: Option<String>,
}

struct Active {
    manifest: SessionManifest,
    dir: PathBuf,
    capture: Option<Capture>,
    watchdog: Watchdog,
    /// Held for the recording's lifetime; dropping it ends the activity.
    _activity: ActivityGuard,
    /// When the current part started, and whether audio has reached it yet.
    part_started: std::time::Instant,
    part_heard: bool,
}

#[derive(Default)]
struct Inner {
    active: Option<Active>,
    transcribing: HashSet<String>,
    config: CaptureConfig,
    shortcut: Option<Shortcut>,
}

/// Two locks, always taken in this order. Menu bar calls block until the main
/// thread runs them, so `menu_bar` is only ever locked on the main thread;
/// other threads enqueue their updates (see [`refresh_menu_bar`]).
#[derive(Default)]
pub struct RecorderState {
    inner: Mutex<Inner>,
    menu_bar: Mutex<Option<MenuBar>>,
}

impl RecorderState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn menu_bar(&self) -> MutexGuard<'_, Option<MenuBar>> {
        self.menu_bar
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }
}

fn app_data(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|err| AppError::io(format!("no app data dir: {err}")))
}

fn store(app: &AppHandle) -> AppResult<Store> {
    Ok(Store::new(app_data(app)?.join("recorder")))
}

fn warning_code(warning: Warning) -> &'static str {
    match warning {
        Warning::NoAudio => "noAudio",
        Warning::MicrophoneSilent => "microphoneSilent",
        Warning::Idle => "idle",
        Warning::WriteFailed => "writeFailed",
    }
}

/// A stop this soon after the start was a double press, not a recording: the
/// recording is discarded rather than turned into an empty transcript.
const MIN_RECORDING_MS: u64 = 1_500;

/// The menu bar's click handler, registered once per process: Tauri keeps
/// every tray's handler for the app's lifetime, so rebuilding the item must
/// not register another one.
static MENU_LISTENER: std::sync::Once = std::sync::Once::new();

fn status_of(app: &AppHandle, inner: &Inner) -> CaptureStatus {
    CaptureStatus {
        supported: device::taps_available(),
        default_recordings_folder: app_data(app)
            .map(|data| data.join("recordings").to_string_lossy().into_owned())
            .unwrap_or_default(),
        recording: inner.active.as_ref().map(|active| ActiveRecording {
            session_id: active.manifest.id.clone(),
            started_at_ms: active.manifest.started_at_ms,
            warnings: active.manifest.warnings.clone(),
        }),
    }
}

/// Bring the menu bar item in line with the state, on the main thread.
fn refresh_menu_bar(app: &AppHandle, inner: &Inner) {
    let display = Display {
        recording_seconds: inner
            .active
            .as_ref()
            .map(|active| now_ms().saturating_sub(active.manifest.started_at_ms) / 1_000),
        warning: inner
            .active
            .as_ref()
            .is_some_and(|active| !active.manifest.warnings.is_empty()),
        transcribing: inner.transcribing.len(),
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(menu_bar) = handle.state::<RecorderState>().menu_bar().as_mut() {
            menu_bar.show(display);
        }
    });
}

fn emit_status(app: &AppHandle, inner: &Inner) {
    let _ = app.emit(STATUS_EVENT, status_of(app, inner));
}

/// Start a new capture part on the current devices.
fn start_part(active: &mut Active) -> Result<(), String> {
    let index = active.manifest.parts.len();
    tracing::info!(session = %active.manifest.id, part = index, "recorder: starting a part");
    let capture = Capture::start(&part_path(&active.dir, index)).inspect_err(|err| {
        tracing::warn!(session = %active.manifest.id, part = index, error = %err, "recorder: part failed to start");
    })?;
    active.part_started = std::time::Instant::now();
    active.part_heard = false;
    active.manifest.parts.push(PartRecord {
        file: part_file(index),
        offset_ms: now_ms().saturating_sub(active.manifest.started_at_ms),
        layout_fallback: false,
    });
    active.capture = Some(capture);
    Ok(())
}

/// Finalize the current part, noting whether its channel split was a guess
/// and whether the disk ever fell so far behind that audio was dropped.
fn end_part(active: &mut Active) {
    let Some(capture) = active.capture.take() else {
        return;
    };
    tracing::info!(
        session = %active.manifest.id,
        part = active.manifest.parts.len().saturating_sub(1),
        frames = capture.meters.frames(),
        seconds = active.part_started.elapsed().as_secs_f32(),
        dropped = capture.dropped_samples(),
        layout_fallback = capture.meters.layout_fallback(),
        "recorder: part ended"
    );
    if capture.meters.layout_fallback() {
        if let Some(part) = active.manifest.parts.last_mut() {
            part.layout_fallback = true;
        }
        active.manifest.warn("layoutFallback");
    }
    if capture.dropped_samples() > 0 {
        active.manifest.warn("samplesDropped");
    }
}

fn start_recording(app: &AppHandle, inner: &mut Inner) -> AppResult<()> {
    if inner.active.is_some() {
        return Ok(());
    }
    if !device::taps_available() {
        return Err(AppError::io(
            "Recording system audio needs macOS 14.2 or later",
        ));
    }
    let store = store(app)?;
    let (manifest, dir) = store.create(now_ms()).map_err(AppError::io)?;
    let mut active = Active {
        manifest,
        dir,
        capture: None,
        watchdog: Watchdog::default(),
        _activity: ActivityGuard::recording(),
        part_started: std::time::Instant::now(),
        part_heard: false,
    };
    if let Err(err) = start_part(&mut active) {
        let _ = store.remove(&active.manifest.id);
        return Err(AppError::io(err));
    }
    store.save(&active.manifest).map_err(AppError::io)?;
    let session_id = active.manifest.id.clone();
    inner.active = Some(active);
    refresh_menu_bar(app, inner);
    emit_status(app, inner);
    spawn_level_meter(app.clone(), session_id.clone());
    spawn_watchdog(app.clone(), session_id);
    Ok(())
}

fn stop_recording(app: &AppHandle, inner: &mut Inner) -> AppResult<()> {
    let Some(mut active) = inner.active.take() else {
        return Ok(());
    };
    end_part(&mut active);
    let ended_at_ms = now_ms();
    active.manifest.ended_at_ms = Some(ended_at_ms);
    tracing::info!(
        session = %active.manifest.id,
        seconds = ended_at_ms.saturating_sub(active.manifest.started_at_ms) as f32 / 1000.0,
        parts = active.manifest.parts.len(),
        warnings = ?active.manifest.warnings,
        "recorder: stopped"
    );
    let store = store(app);
    refresh_menu_bar(app, inner);
    emit_status(app, inner);
    let store = store?;
    if ended_at_ms.saturating_sub(active.manifest.started_at_ms) < MIN_RECORDING_MS {
        return store.remove(&active.manifest.id).map_err(AppError::io);
    }
    let saved = store.save(&active.manifest).map_err(AppError::io);
    let _ = app.emit(
        RECORDED_EVENT,
        RecordedEvent {
            session_id: active.manifest.id,
        },
    );
    saved
}

/// Stop and throw the recording away: nothing is transcribed or kept.
fn cancel_recording(app: &AppHandle, inner: &mut Inner) -> AppResult<()> {
    let Some(mut active) = inner.active.take() else {
        return Ok(());
    };
    end_part(&mut active);
    refresh_menu_bar(app, inner);
    emit_status(app, inner);
    store(app)?
        .remove(&active.manifest.id)
        .map_err(AppError::io)
}

fn toggle(app: &AppHandle) {
    let state = app.state::<RecorderState>();
    let mut inner = state.lock();
    let outcome = if inner.active.is_some() {
        stop_recording(app, &mut inner)
    } else {
        start_recording(app, &mut inner)
    };
    if let Err(err) = outcome {
        tracing::warn!(error = ?err, "recording toggle failed");
        let _ = app.emit(
            WARNING_EVENT,
            WarningEvent {
                session_id: String::new(),
                code: "startFailed",
            },
        );
    }
}

/// Once a second while `session_id` records: apply the watchdog and tick the
/// menu bar clock. Ends when that recording does.
fn spawn_watchdog(app: AppHandle, session_id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        let state = app.state::<RecorderState>();
        let mut inner = state.lock();
        let Some(active) = inner.active.as_mut() else {
            return;
        };
        if active.manifest.id != session_id {
            return;
        }
        let observation = match active.capture.as_ref() {
            Some(capture) => {
                let (mic_peak, system_peak) = capture.meters.take_peaks();
                Observation {
                    frames: capture.meters.frames(),
                    mic_peak,
                    system_peak,
                    devices_changed: device::current_devices()
                        .is_ok_and(|devices| devices != capture.devices),
                    write_failed: capture.writer_failed(),
                }
            }
            None => Observation::default(),
        };
        if observation.frames > 0 && !active.part_heard {
            active.part_heard = true;
            tracing::info!(
                session = %session_id,
                after_seconds = active.part_started.elapsed().as_secs_f32(),
                "recorder: first audio arrived"
            );
        }
        let mut stop = false;
        let mut warnings = Vec::new();
        let actions = active.watchdog.tick(observation);
        if !actions.is_empty() {
            tracing::info!(session = %session_id, ?actions, ?observation, "recorder: watchdog acted");
        }
        for action in actions {
            match action {
                Action::Rebuild => {
                    end_part(active);
                    if let Err(err) = start_part(active) {
                        // The watchdog keeps retrying while no audio arrives.
                        tracing::warn!(error = %err, "rebuilding the capture failed");
                        if active.manifest.warn("captureFailed") {
                            warnings.push("captureFailed");
                        }
                    }
                }
                Action::Warn(warning) => {
                    active.manifest.warn(warning_code(warning));
                    warnings.push(warning_code(warning));
                }
                Action::Stop => stop = true,
            }
        }
        if let Ok(store) = store(&app) {
            let _ = store.save(&active.manifest);
        }
        for code in warnings {
            let _ = app.emit(
                WARNING_EVENT,
                WarningEvent {
                    session_id: session_id.clone(),
                    code,
                },
            );
        }
        if stop {
            if let Some(active) = inner.active.as_mut() {
                active.manifest.warn("autoStopped");
            }
            let _ = stop_recording(&app, &mut inner);
            return;
        }
        refresh_menu_bar(&app, &inner);
    });
}

/// While `session_id` records: stream the louder side's input level to the
/// recording panel's waveform.
fn spawn_level_meter(app: AppHandle, session_id: String) {
    std::thread::spawn(move || loop {
        std::thread::sleep(LEVEL_INTERVAL);
        let level = {
            let state = app.state::<RecorderState>();
            let inner = state.lock();
            match inner.active.as_ref() {
                Some(active) if active.manifest.id == session_id => active
                    .capture
                    .as_ref()
                    .map_or(0.0, |capture| capture.meters.take_display_level()),
                _ => return,
            }
        };
        let _ = app.emit(LEVEL_EVENT, level);
    });
}

/// Finalize a recording in progress when the app quits, so its last part
/// keeps a valid header. Staging keeps it for transcription at next launch.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<RecorderState>();
    let mut inner = state.lock();
    let _ = stop_recording(app, &mut inner);
}

/// Command: whether capture is available and what is recording.
#[tauri::command]
pub fn recorder_status(app: AppHandle, state: State<'_, RecorderState>) -> CaptureStatus {
    status_of(&app, &state.lock())
}

/// Command: start recording (a no-op while one runs).
#[tauri::command]
pub fn recorder_start(app: AppHandle, state: State<'_, RecorderState>) -> AppResult<CaptureStatus> {
    let mut inner = state.lock();
    start_recording(&app, &mut inner)?;
    Ok(status_of(&app, &inner))
}

/// Command: stop recording; the recording waits in staging for transcription.
#[tauri::command]
pub fn recorder_stop(app: AppHandle, state: State<'_, RecorderState>) -> AppResult<CaptureStatus> {
    let mut inner = state.lock();
    stop_recording(&app, &mut inner)?;
    Ok(status_of(&app, &inner))
}

/// Command: stop and discard the recording without transcribing it.
#[tauri::command]
pub fn recorder_cancel(
    app: AppHandle,
    state: State<'_, RecorderState>,
) -> AppResult<CaptureStatus> {
    let mut inner = state.lock();
    cancel_recording(&app, &mut inner)?;
    Ok(status_of(&app, &inner))
}

/// Command: finished recordings still in staging, oldest first.
#[tauri::command]
pub fn recorder_sessions(
    app: AppHandle,
    state: State<'_, RecorderState>,
) -> AppResult<Vec<FinishedSession>> {
    let active = state
        .lock()
        .active
        .as_ref()
        .map(|active| active.manifest.id.clone());
    Ok(store(&app)?.finished(active.as_deref()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    session_id: String,
    model: String,
    /// ISO 639 code; absent, empty, or `auto` detects it per region.
    language: Option<String>,
    /// The vocabulary hint: the user's prompt plus the meeting's names, if any.
    prompt: Option<String>,
}

/// Command: transcribe a finished recording (cached per model).
#[tauri::command]
pub async fn recorder_transcribe(
    request: TranscribeRequest,
    app: AppHandle,
    state: State<'_, RecorderState>,
    local: State<'_, LocalTranscriptionState>,
) -> AppResult<RecordingTranscript> {
    let store = store(&app)?;
    let id = request.session_id;
    // A pass from an earlier graph session may still be transcribing this
    // recording; wait for its result instead of running the model twice.
    while state.lock().transcribing.contains(&id) {
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    let cached = store
        .read_transcript::<RecordingTranscript>(&id)
        .map_err(AppError::io)?;
    if let Some(cached) = cached
        .as_ref()
        .filter(|cached| cached.model == request.model)
    {
        return Ok(cached.clone());
    }
    let manifest = store.load(&id).map_err(AppError::io)?;
    if manifest.ended_at_ms.is_none()
        && state
            .lock()
            .active
            .as_ref()
            .is_some_and(|active| active.manifest.id == id)
    {
        return Err(AppError::io("it is still being recorded"));
    }
    // Another model's cached transcript beats none while this one is missing.
    let model = match crate::local_transcription::local_model(&app, &local, &request.model) {
        Ok(model) => model,
        Err(err) => return cached.ok_or(err),
    };
    let dir = store.dir(&id).map_err(AppError::io)?;
    let language = request
        .language
        .filter(|code| !code.is_empty() && code != "auto");
    let prompt = request.prompt.filter(|hint| !hint.trim().is_empty());
    let model_id = request.model;

    mark_transcribing(&app, &id, true);
    let transcribing = ActivityGuard::transcribing();
    let result = tauri::async_runtime::spawn_blocking(move || {
        transcribe::transcribe(
            &dir,
            &manifest,
            &ModelChoice {
                model: &model,
                id: &model_id,
                language: language.as_deref(),
                prompt: prompt.as_deref(),
            },
        )
    })
    .await;
    drop(transcribing);
    mark_transcribing(&app, &id, false);
    let transcript = result
        .map_err(|err| AppError::io(format!("transcription task panicked: {err}")))?
        .map_err(AppError::io)?;
    store
        .write_transcript(&id, &transcript)
        .map_err(AppError::io)?;
    Ok(transcript)
}

fn mark_transcribing(app: &AppHandle, id: &str, transcribing: bool) {
    let state = app.state::<RecorderState>();
    let mut inner = state.lock();
    if transcribing {
        inner.transcribing.insert(id.to_string());
    } else {
        inner.transcribing.remove(id);
    }
    refresh_menu_bar(app, &inner);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveRequest {
    session_id: String,
    /// Absolute path of the `.m4a` to write.
    destination: String,
}

/// Command: encode a transcribed recording into its archive m4a and remove it
/// from staging. The m4a is written locally first, then copied, so a synced
/// or network folder only ever sees a complete file.
#[tauri::command]
pub async fn recorder_archive(request: ArchiveRequest, app: AppHandle) -> AppResult<()> {
    let destination = PathBuf::from(&request.destination);
    if !destination.is_absolute()
        || destination
            .extension()
            .is_none_or(|extension| extension != "m4a")
    {
        return Err(AppError::io(format!(
            "not an m4a path: {}",
            request.destination
        )));
    }
    let store = store(&app)?;
    let id = request.session_id;
    tauri::async_runtime::spawn_blocking(move || archive(&store, &id, &destination))
        .await
        .map_err(|err| AppError::io(format!("archive task panicked: {err}")))?
        .map_err(AppError::io)
}

fn archive(store: &Store, id: &str, destination: &Path) -> Result<(), String> {
    let manifest = store.load(id)?;
    if manifest.ended_at_ms.is_none() {
        return Err("it is still being recorded".to_string());
    }
    let dir = store.dir(id)?;
    let parts: Vec<PathBuf> = manifest
        .parts
        .iter()
        .map(|part| dir.join(&part.file))
        .collect();
    let local = dir.join("archive.m4a");
    audio_file::encode_archive(&parts, &local)?;
    let parent = destination
        .parent()
        .ok_or_else(|| format!("no folder for {}", destination.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|err| format!("creating {}: {err}", parent.display()))?;
    // Copy under a hidden name, then rename: a sync client never uploads half
    // a file, and a failed copy never leaves a truncated archive behind.
    let file_name = destination
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let partial = parent.join(format!(".{file_name}.partial"));
    std::fs::copy(&local, &partial).map_err(|err| {
        let _ = std::fs::remove_file(&partial);
        format!("copying to {}: {err}", destination.display())
    })?;
    std::fs::rename(&partial, destination)
        .map_err(|err| format!("moving into {}: {err}", destination.display()))?;
    store.remove(id)
}

/// Command: apply the user's menu bar and shortcut settings.
#[tauri::command]
pub fn recorder_configure(
    config: CaptureConfig,
    app: AppHandle,
    state: State<'_, RecorderState>,
) -> AppResult<()> {
    let mut inner = state.lock();
    // A shortcut the OS rejects must not keep the menu bar away, so it is
    // reported only after everything else is applied.
    let shortcut_applied = apply_shortcut(&app, &mut inner, config.shortcut.as_deref());

    // A sync command: this runs on the main thread, where the menu bar lives.
    let menu_bar_applied = {
        let mut menu_bar = state.menu_bar();
        let rebuild =
            menu_bar.is_some() != config.menu_bar || inner.config.shortcut != config.shortcut;
        let mut built = Ok(());
        if rebuild {
            if let Some(previous) = menu_bar.take() {
                previous.remove(&app);
            }
            if config.menu_bar && device::taps_available() {
                MENU_LISTENER.call_once(|| app.on_menu_event(on_menu_event));
                match MenuBar::build(&app, config.shortcut.as_deref(), toggle) {
                    Ok(next) => *menu_bar = Some(next),
                    Err(err) => {
                        built = Err(AppError::io(format!("adding the menu bar item: {err}")))
                    }
                }
            }
        }
        if let Some(menu_bar) = menu_bar.as_ref() {
            menu_bar.set_folder_available(config.recordings_folder.is_some());
        }
        built
    };
    inner.config = config;
    refresh_menu_bar(&app, &inner);
    shortcut_applied.and(menu_bar_applied)
}

/// Register `accelerator` as the global toggle, replacing the previous one.
/// One the OS can't parse or register leaves the previous shortcut working.
fn apply_shortcut(app: &AppHandle, inner: &mut Inner, accelerator: Option<&str>) -> AppResult<()> {
    let next = match accelerator.filter(|text| !text.trim().is_empty()) {
        Some(text) => Some(
            text.parse::<Shortcut>()
                .map_err(|err| AppError::parse(format!("not a shortcut: {text} ({err})")))?,
        ),
        None => None,
    };
    if inner.shortcut == next {
        return Ok(());
    }
    let manager = app.global_shortcut();
    if let Some(next) = next {
        manager
            .on_shortcut(next, |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle(app);
                }
            })
            .map_err(|err| AppError::io(format!("registering the shortcut: {err}")))?;
    }
    if let Some(previous) = inner.shortcut.take() {
        let _ = manager.unregister(previous);
    }
    inner.shortcut = next;
    Ok(())
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        menu_bar::MENU_TOGGLE => toggle(app),
        menu_bar::MENU_SHOW => {
            crate::windows::surface_main_window(app);
        }
        menu_bar::MENU_FOLDER => {
            let folder = app
                .state::<RecorderState>()
                .lock()
                .config
                .recordings_folder
                .clone();
            if let Some(folder) = folder {
                use tauri_plugin_opener::OpenerExt;
                let _ = std::fs::create_dir_all(&folder);
                let _ = app.opener().open_path(folder, None::<&str>);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The settings default (`DEFAULT_RECORDING_SHORTCUT` in core) must be an
    /// accelerator the OS layer parses, or every launch reports an error.
    #[test]
    fn the_default_shortcut_parses() {
        let shortcut = "Control+Option+Command+M".parse::<Shortcut>().unwrap();
        assert_eq!(shortcut, "ctrl+alt+super+KeyM".parse::<Shortcut>().unwrap());
        assert!("Command+".parse::<Shortcut>().is_err());
    }
}
