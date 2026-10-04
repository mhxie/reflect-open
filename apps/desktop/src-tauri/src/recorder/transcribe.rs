//! Transcribe a finished recording: for every capture part, suppress the far
//! end's echo in the microphone channel against the system channel, cut both
//! channels into speech regions, and run each region through the on-device
//! model. The two channels come back as separate timed segment lists ("Me" and
//! "Them"); interleaving them and dropping residual echo is policy and lives
//! in `@reflect/core`.

use std::path::Path;

use serde::{Deserialize, Serialize};

use super::audio_file::{read_part, Stereo, SAMPLE_RATE};
use super::echo::{self, EchoOutcome};
use super::session::SessionManifest;
use crate::local_transcription::engine::TranscriptSegment;
use crate::local_transcription::LocalModel;

/// Both sides of one recording, timed from its start.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingTranscript {
    /// The model id that produced it; a different model re-transcribes.
    pub model: String,
    pub duration_ms: u64,
    pub me: Vec<TranscriptSegment>,
    pub them: Vec<TranscriptSegment>,
    /// Whether the microphone was echo-gated in any part (speakers rather
    /// than headphones).
    pub echo_suppressed: bool,
    /// Nothing played through the Mac the whole time: the far end was silent,
    /// or system audio recording isn't allowed.
    pub system_silent: bool,
}

/// What to transcribe with.
pub struct ModelChoice<'a> {
    pub model: &'a LocalModel,
    /// The settings id, recorded with the cached transcript.
    pub id: &'a str,
    /// ISO 639-1, or `None` to detect per region.
    pub language: Option<&'a str>,
    /// Vocabulary hint: the user's prompt plus the meeting's names, if any.
    pub prompt: Option<&'a str>,
}

pub fn transcribe(
    dir: &Path,
    manifest: &SessionManifest,
    model: &ModelChoice<'_>,
) -> Result<RecordingTranscript, String> {
    let mut transcript = RecordingTranscript {
        model: model.id.to_string(),
        duration_ms: 0,
        me: Vec::new(),
        them: Vec::new(),
        echo_suppressed: false,
        system_silent: true,
    };
    for part in &manifest.parts {
        let stereo = read_part(&dir.join(&part.file))?;
        add_part(&mut transcript, stereo, part.offset_ms, model)?;
    }
    Ok(transcript)
}

/// Echo-suppress and transcribe one part's two channels into `transcript`.
fn add_part(
    transcript: &mut RecordingTranscript,
    stereo: Stereo,
    offset_ms: u64,
    model: &ModelChoice<'_>,
) -> Result<EchoOutcome, String> {
    let length_ms = samples_to_ms(stereo.mic.len());
    transcript.duration_ms = transcript.duration_ms.max(offset_ms + length_ms);
    if stereo.system.iter().any(|sample| *sample != 0.0) {
        transcript.system_silent = false;
    }
    let (mic, outcome) = echo::suppress(&stereo.mic, &stereo.system);
    transcript.echo_suppressed |= matches!(outcome, EchoOutcome::Suppressed { .. });
    tracing::info!(
        offset_ms,
        seconds = samples_to_ms(stereo.mic.len()) as f32 / 1000.0,
        mic_peak = peak(&stereo.mic),
        system_peak = peak(&stereo.system),
        echo = ?outcome,
        "recorder: transcribing a part"
    );
    transcript
        .them
        .extend(transcribe_channel(&stereo.system, offset_ms, model)?);
    drop(stereo);
    transcript
        .me
        .extend(transcribe_channel(&mic, offset_ms, model)?);
    Ok(outcome)
}

fn peak(samples: &[f32]) -> f32 {
    samples
        .iter()
        .fold(0.0, |peak, sample| peak.max(sample.abs()))
}

fn samples_to_ms(samples: usize) -> u64 {
    samples as u64 * 1_000 / u64::from(SAMPLE_RATE)
}

fn transcribe_channel(
    samples: &[f32],
    offset_ms: u64,
    choice: &ModelChoice<'_>,
) -> Result<Vec<TranscriptSegment>, String> {
    Ok(choice
        .model
        .transcribe_regions(samples, choice.language, choice.prompt)?
        .into_iter()
        .map(|segment| TranscriptSegment {
            start_ms: offset_ms + segment.start_ms,
            end_ms: offset_ms + segment.end_ms,
            text: segment.text,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_transcription::audio::decode_channels;

    /// Rerun a real recording through echo suppression and the model, e.g. a
    /// capture part (`part-000.wav`) or an archived recording (`.m4a`): the
    /// way to inspect Me/Them labeling and echo handling on actual audio.
    #[test]
    #[ignore = "needs real audio and a model: REFLECT_RECORDING_TEST_AUDIO=recording.m4a \
                REFLECT_WHISPER_TEST_MODEL=/path/to/ggml-*.bin (or a Qwen3-ASR snapshot dir)"]
    fn transcribes_a_real_recording() {
        crate::local_transcription::prepare_process_environment();
        let audio =
            std::env::var("REFLECT_RECORDING_TEST_AUDIO").expect("REFLECT_RECORDING_TEST_AUDIO");
        let model =
            std::env::var("REFLECT_WHISPER_TEST_MODEL").expect("REFLECT_WHISPER_TEST_MODEL");
        let path = Path::new(&audio);
        let stereo = match read_part(path) {
            Ok(stereo) => stereo,
            Err(_) => {
                let mut channels = decode_channels(path).expect("decodable audio").into_iter();
                Stereo {
                    mic: channels.next().expect("a microphone channel"),
                    system: channels.next().expect("a system channel"),
                }
            }
        };
        // A Qwen3-ASR snapshot directory selects that engine instead.
        let model = if Path::new(&model).is_dir() {
            LocalModel::Qwen {
                engine: crate::local_transcription::qwen::QwenEngine::default(),
                dir: model.into(),
            }
        } else {
            LocalModel::Whisper {
                engine: crate::local_transcription::engine::Engine::default(),
                path: model.into(),
            }
        };
        let language = std::env::var("REFLECT_RECORDING_TEST_LANGUAGE").ok();
        let choice = ModelChoice {
            model: &model,
            id: "test",
            language: language.as_deref(),
            prompt: None,
        };
        let mut transcript = RecordingTranscript {
            model: choice.id.to_string(),
            duration_ms: 0,
            me: Vec::new(),
            them: Vec::new(),
            echo_suppressed: false,
            system_silent: true,
        };
        let outcome = add_part(&mut transcript, stereo, 0, &choice).expect("transcribed");
        eprintln!(
            "echo: {outcome:?}, system silent: {}",
            transcript.system_silent
        );
        for (speaker, segments) in [("Me", &transcript.me), ("Them", &transcript.them)] {
            for segment in segments {
                eprintln!("[{:>7} ms] {speaker}: {}", segment.start_ms, segment.text);
            }
        }
    }
}
