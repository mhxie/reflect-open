//! The staging store: one directory per recording under app data, holding the
//! capture parts, a manifest, and the cached transcript. A recording leaves
//! staging once its transcript is in the graph and its audio is archived.
//! Staging is local and outside any graph on purpose: capture never depends
//! on which graph is open, a synced folder, or a network drive being writable.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

use super::audio_file::SAMPLE_RATE;

const MANIFEST: &str = "session.json";
const TRANSCRIPT: &str = "transcript.json";
const ID_PREFIX: &str = "session-";
/// Bytes per stored stereo 16-bit frame.
const FRAME_BYTES: u64 = 4;

/// One capture part: the devices stayed the same for its whole length.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartRecord {
    pub file: String,
    /// When the part started, in milliseconds from the recording's start.
    pub offset_ms: u64,
    /// The microphone/system split fell back to a guess (see `device::Meters`).
    #[serde(default)]
    pub layout_fallback: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionManifest {
    pub id: String,
    pub started_at_ms: u64,
    /// Absent while recording, and after a crash until the store recovers it.
    pub ended_at_ms: Option<u64>,
    pub parts: Vec<PartRecord>,
    /// Watchdog findings and capture notes, as stable codes.
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl SessionManifest {
    /// Record `code` once; true when it is new for this recording.
    pub fn warn(&mut self, code: &str) -> bool {
        if self.warnings.iter().any(|existing| existing == code) {
            return false;
        }
        self.warnings.push(code.to_string());
        true
    }
}

/// A finished recording, as the frontend sees it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishedSession {
    pub id: String,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    /// Whether a transcript is cached, so a retry skips the model.
    pub transcribed: bool,
    pub warnings: Vec<String>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// Session ids are generated here; anything else is rejected before it can
/// become a path.
fn is_session_id(id: &str) -> bool {
    id.strip_prefix(ID_PREFIX).is_some_and(|digits| {
        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn dir(&self, id: &str) -> Result<PathBuf, String> {
        if is_session_id(id) {
            Ok(self.root.join(id))
        } else {
            Err(format!("not a recording: {id}"))
        }
    }

    /// Start a recording's directory and manifest.
    pub fn create(&self, started_at_ms: u64) -> Result<(SessionManifest, PathBuf), String> {
        let id = format!("{ID_PREFIX}{started_at_ms}");
        let dir = self.dir(&id)?;
        fs::create_dir_all(&dir).map_err(|err| format!("creating {}: {err}", dir.display()))?;
        let manifest = SessionManifest {
            id,
            started_at_ms,
            ended_at_ms: None,
            parts: Vec::new(),
            warnings: Vec::new(),
        };
        self.save(&manifest)?;
        Ok((manifest, dir))
    }

    pub fn save(&self, manifest: &SessionManifest) -> Result<(), String> {
        self.write_json(&manifest.id, MANIFEST, manifest)
    }

    pub fn load(&self, id: &str) -> Result<SessionManifest, String> {
        self.read_json(id, MANIFEST)?
            .ok_or_else(|| format!("no recording {id}"))
    }

    /// Every recording except `active`, oldest first. One left unfinished by
    /// a crash is closed here, ending where its audio ends.
    pub fn finished(&self, active: Option<&str>) -> Vec<FinishedSession> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut sessions: Vec<FinishedSession> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|id| is_session_id(id) && Some(id.as_str()) != active)
            .filter_map(|id| {
                let mut manifest = self.load(&id).ok()?;
                let ended_at_ms = match manifest.ended_at_ms {
                    Some(ended) => ended,
                    None => {
                        let ended = manifest.started_at_ms + self.recorded_ms(&manifest);
                        manifest.ended_at_ms = Some(ended);
                        manifest.warn("interrupted");
                        let _ = self.save(&manifest);
                        ended
                    }
                };
                Some(FinishedSession {
                    transcribed: self.dir(&id).ok()?.join(TRANSCRIPT).is_file(),
                    id,
                    started_at_ms: manifest.started_at_ms,
                    ended_at_ms,
                    warnings: manifest.warnings,
                })
            })
            .collect();
        sessions.sort_by_key(|session| session.started_at_ms);
        sessions
    }

    /// How far the last part's audio reaches, from the file sizes.
    fn recorded_ms(&self, manifest: &SessionManifest) -> u64 {
        let Some(last) = manifest.parts.last() else {
            return 0;
        };
        let bytes = self
            .dir(&manifest.id)
            .ok()
            .and_then(|dir| fs::metadata(dir.join(&last.file)).ok())
            .map_or(0, |metadata| metadata.len());
        last.offset_ms + bytes / FRAME_BYTES * 1_000 / u64::from(SAMPLE_RATE)
    }

    pub fn read_transcript<T: DeserializeOwned>(&self, id: &str) -> Result<Option<T>, String> {
        self.read_json(id, TRANSCRIPT)
    }

    pub fn write_transcript<T: Serialize>(&self, id: &str, transcript: &T) -> Result<(), String> {
        self.write_json(id, TRANSCRIPT, transcript)
    }

    pub fn remove(&self, id: &str) -> Result<(), String> {
        let dir = self.dir(id)?;
        match fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(format!("removing {}: {err}", dir.display())),
        }
    }

    fn read_json<T: DeserializeOwned>(&self, id: &str, name: &str) -> Result<Option<T>, String> {
        let path = self.dir(id)?.join(name);
        let raw = match fs::read(&path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(format!("reading {}: {err}", path.display())),
        };
        serde_json::from_slice(&raw)
            .map(Some)
            .map_err(|err| format!("reading {}: {err}", path.display()))
    }

    /// Replace `name` atomically, so a crash never leaves half a manifest.
    fn write_json<T: Serialize>(&self, id: &str, name: &str, value: &T) -> Result<(), String> {
        let dir = self.dir(id)?;
        let json = serde_json::to_vec_pretty(value).map_err(|err| err.to_string())?;
        let mut file =
            NamedTempFile::new_in(&dir).map_err(|err| format!("writing {name}: {err}"))?;
        file.write_all(&json)
            .and_then(|()| file.flush())
            .map_err(|err| format!("writing {name}: {err}"))?;
        file.persist(dir.join(name))
            .map(|_| ())
            .map_err(|err| format!("writing {name}: {err}"))
    }
}

/// The capture part file for index `index`.
pub fn part_file(index: usize) -> String {
    format!("part-{index:03}.wav")
}

pub fn part_path(dir: &Path, index: usize) -> PathBuf {
    dir.join(part_file(index))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ids_that_could_escape_the_store() {
        let store = Store::new(PathBuf::from("/staging"));
        assert!(store.dir("session-1696000000000").is_ok());
        for id in ["../etc", "session-", "session-12/..", "other-1", ""] {
            assert!(store.dir(id).is_err(), "{id}");
        }
    }

    #[test]
    fn lists_finished_recordings_and_recovers_interrupted_ones() {
        let root = tempfile::tempdir().unwrap();
        let store = Store::new(root.path().to_path_buf());
        let (mut done, _) = store.create(2_000).unwrap();
        done.ended_at_ms = Some(9_000);
        store.save(&done).unwrap();
        store
            .write_transcript(&done.id, &serde_json::json!({"ok": true}))
            .unwrap();

        let (mut crashed, dir) = store.create(1_000).unwrap();
        crashed.parts.push(PartRecord {
            file: part_file(0),
            offset_ms: 500,
            layout_fallback: false,
        });
        store.save(&crashed).unwrap();
        fs::write(dir.join(part_file(0)), vec![0u8; 64_000 * 2]).unwrap();

        let (active, _) = store.create(3_000).unwrap();

        let finished = store.finished(Some(&active.id));
        assert_eq!(finished.len(), 2);
        assert_eq!(finished[0].id, crashed.id);
        assert_eq!(finished[0].ended_at_ms, 1_000 + 500 + 2_000);
        assert_eq!(finished[0].warnings, vec!["interrupted"]);
        assert!(!finished[0].transcribed);
        assert!(finished[1].transcribed);

        store.remove(&done.id).unwrap();
        store.remove(&done.id).unwrap();
        assert_eq!(store.finished(Some(&active.id)).len(), 1);
    }
}
