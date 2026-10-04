//! whisper.cpp inference. One model stays loaded across a pass's segments and
//! is released after a quiet spell: a full-precision turbo model pins about
//! 1.6 GB, which a notes app has no business holding between memos.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

/// One transcribed stretch of the recording, in milliseconds from its start.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptSegment {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// A segment with whisper's confidence in it.
#[derive(Clone, Debug)]
pub struct ScoredSegment {
    pub segment: TranscriptSegment,
    /// Whisper's estimate that the window held no speech at all.
    pub no_speech_probability: f32,
    /// The mean natural-log probability of the segment's tokens.
    pub mean_log_probability: f32,
}

/// Sign-offs whisper writes over music, applause, or silence: lines from the
/// subtitles of the videos it learned from, never what a recording held.
/// Compared after [`stock_key`].
const STOCK_PHRASES: [&str; 14] = [
    "ご視聴ありがとうございました",
    "thanksforwatching",
    "thankyouforwatching",
    "thankyousomuchforwatching",
    "pleasesubscribe",
    "subtitlesbytheamaraorgcommunity",
    "字幕由amaraorg社区提供",
    "请不吝点赞订阅转发打赏支持明镜与点点栏目",
    "明镜与点点栏目",
    "谢谢观看",
    "謝謝觀看",
    "感谢观看",
    "感謝觀看",
    "多谢收看",
];

/// Sign-offs that are also real replies: dropped only when whisper itself
/// leans toward the window holding no speech.
const AMBIGUOUS_STOCK_PHRASES: [&str; 6] = ["thankyou", "thanks", "you", "bye", "谢谢", "謝謝"];
const AMBIGUOUS_NO_SPEECH: f32 = 0.2;

/// Lowercased letters and digits only.
fn stock_key(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

impl ScoredSegment {
    /// Text whisper probably invented: a stock sign-off it writes over music
    /// or silence, or its own test (the window probably held no speech and
    /// the decoder wasn't confident in what it wrote anyway).
    pub fn is_probably_invented(&self) -> bool {
        let key = stock_key(&self.segment.text);
        if STOCK_PHRASES.contains(&key.as_str()) {
            return true;
        }
        if AMBIGUOUS_STOCK_PHRASES.contains(&key.as_str())
            && self.no_speech_probability > AMBIGUOUS_NO_SPEECH
        {
            return true;
        }
        self.no_speech_probability > 0.6 && self.mean_log_probability < -1.0
    }
}

/// How long a loaded model survives without use.
const IDLE_RELEASE: Duration = Duration::from_secs(10 * 60);
const IDLE_POLL: Duration = Duration::from_secs(60);

struct Loaded {
    model_path: PathBuf,
    context: Arc<WhisperContext>,
    last_used: Instant,
    /// Bumped per load so a superseded idle watcher retires itself.
    epoch: u64,
}

#[derive(Default)]
struct Slot {
    loaded: Option<Loaded>,
    epoch: u64,
}

/// The process-wide model slot.
#[derive(Default, Clone)]
pub struct Engine(Arc<Mutex<Slot>>);

impl Engine {
    /// Transcribe 16 kHz mono `samples` with the model at `model_path`.
    /// `language` is an ISO 639-1 code, or `None` to detect it. Blocking:
    /// callers run it on a worker thread.
    pub fn transcribe(
        &self,
        model_path: &Path,
        samples: &[f32],
        language: Option<&str>,
        prompt: Option<&str>,
    ) -> Result<Vec<TranscriptSegment>, String> {
        Ok(self
            .transcribe_scored(model_path, samples, language, prompt)?
            .into_iter()
            .filter(|scored| !scored.is_probably_invented())
            .map(|scored| scored.segment)
            .collect())
    }

    /// [`Engine::transcribe`], keeping whisper's own confidence in each
    /// segment so a caller can drop text invented over noise.
    pub fn transcribe_scored(
        &self,
        model_path: &Path,
        samples: &[f32],
        language: Option<&str>,
        prompt: Option<&str>,
    ) -> Result<Vec<ScoredSegment>, String> {
        // A recording stopped before any audio has nothing to say, and
        // whisper.cpp's language detection fails on an empty input.
        if samples.is_empty() {
            return Ok(Vec::new());
        }
        let context = self.context(model_path)?;
        let mut state = context
            .create_state()
            .map_err(|err| format!("preparing the model: {err}"))?;
        let mut params = FullParams::new(SamplingStrategy::BeamSearch {
            beam_size: 5,
            patience: -1.0,
        });
        params.set_language(language);
        if let Some(prompt) = prompt.filter(|prompt| !prompt.is_empty()) {
            params.set_initial_prompt(prompt);
        }
        params.set_n_threads(thread_count());
        // Each segment decodes without the previous one's text, which keeps a
        // hallucinated phrase from repeating through the rest of the memo.
        params.set_no_context(true);
        params.set_suppress_blank(true);
        params.set_suppress_nst(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        state
            .full(params, samples)
            .map_err(|err| format!("transcribing: {err}"))?;
        let segments = (0..state.full_n_segments())
            .filter_map(|index| state.get_segment(index))
            .map(|segment| ScoredSegment {
                no_speech_probability: segment.no_speech_probability(),
                mean_log_probability: mean_log_probability(&segment),
                segment: TranscriptSegment {
                    start_ms: centiseconds_to_ms(segment.start_timestamp()),
                    end_ms: centiseconds_to_ms(segment.end_timestamp()),
                    text: segment
                        .to_str_lossy()
                        .map(|text| text.into_owned())
                        .unwrap_or_default(),
                },
            })
            .collect();
        self.touch();
        Ok(segments)
    }

    /// Drop the loaded model (after a delete or an update of its file).
    /// An in-flight transcription keeps its own handle until it finishes.
    pub fn release(&self) {
        if let Ok(mut slot) = self.0.lock() {
            slot.loaded = None;
        }
    }

    fn context(&self, model_path: &Path) -> Result<Arc<WhisperContext>, String> {
        let mut slot = self
            .0
            .lock()
            .map_err(|_| "the transcription engine lock was poisoned".to_string())?;
        if let Some(loaded) = slot.loaded.as_mut() {
            if loaded.model_path == model_path {
                loaded.last_used = Instant::now();
                return Ok(Arc::clone(&loaded.context));
            }
        }
        install_logging();
        let context =
            WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
                .map(Arc::new)
                .map_err(|err| format!("loading the model: {err}"))?;
        slot.epoch += 1;
        let epoch = slot.epoch;
        slot.loaded = Some(Loaded {
            model_path: model_path.to_path_buf(),
            context: Arc::clone(&context),
            last_used: Instant::now(),
            epoch,
        });
        self.watch_idle(epoch);
        Ok(context)
    }

    fn touch(&self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(loaded) = slot.loaded.as_mut() {
                loaded.last_used = Instant::now();
            }
        }
    }

    /// Release the model once it has idled for [`IDLE_RELEASE`].
    fn watch_idle(&self, epoch: u64) {
        let slot = Arc::clone(&self.0);
        std::thread::spawn(move || loop {
            std::thread::sleep(IDLE_POLL);
            let Ok(mut slot) = slot.lock() else {
                return;
            };
            match slot.loaded.as_ref() {
                Some(loaded) if loaded.epoch == epoch => {
                    if loaded.last_used.elapsed() >= IDLE_RELEASE {
                        slot.loaded = None;
                        return;
                    }
                }
                _ => return,
            }
        });
    }
}

/// Route whisper.cpp's and GGML's console chatter into `tracing`.
fn install_logging() {
    static ONCE: Once = Once::new();
    ONCE.call_once(whisper_rs::install_logging_hooks);
}

fn thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|cores| cores.get().min(8) as i32)
        .unwrap_or(4)
}

fn mean_log_probability(segment: &whisper_rs::WhisperSegment<'_>) -> f32 {
    let count = segment.n_tokens();
    if count <= 0 {
        return 0.0;
    }
    let total: f32 = (0..count)
        .filter_map(|index| segment.get_token(index))
        .map(|token| token.token_probability().max(1e-9).ln())
        .sum();
    total / count as f32
}

fn centiseconds_to_ms(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0) * 10
}

/// The transcript of `segments`. Whisper leads English segments with a space
/// and runs CJK text on, but in a memo that switches languages a segment can
/// arrive bare, so a space goes in wherever neither side brings one and the
/// two sides aren't both CJK.
pub fn join_segments(segments: &[TranscriptSegment]) -> String {
    let mut text = String::new();
    for segment in segments {
        let next = segment.text.as_str();
        if let (Some(last), Some(first)) = (text.chars().last(), next.chars().next()) {
            if !last.is_whitespace() && !first.is_whitespace() && !(is_cjk(last) && is_cjk(first)) {
                text.push(' ');
            }
        }
        text.push_str(next);
    }
    text.trim().to_string()
}

/// Han, kana, Hangul, and their punctuation and fullwidth forms: scripts
/// written without spaces between words.
fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{1100}'..='\u{11ff}'
            | '\u{2e80}'..='\u{9fff}'
            | '\u{ac00}'..='\u{d7af}'
            | '\u{f900}'..='\u{faff}'
            | '\u{ff00}'..='\u{ffef}'
            | '\u{20000}'..='\u{2ffff}')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(text: &str) -> TranscriptSegment {
        TranscriptSegment {
            start_ms: 0,
            end_ms: 0,
            text: text.to_string(),
        }
    }

    #[test]
    fn joins_english_and_chinese_segments_without_extra_spacing() {
        let segments = [
            segment(" Let's ship it."),
            segment(" 我们下周"),
            segment("发预算表。"),
        ];
        assert_eq!(
            join_segments(&segments),
            "Let's ship it. 我们下周发预算表。"
        );
        assert_eq!(join_segments(&[]), "");
    }

    #[test]
    fn spaces_a_language_switch_that_arrives_without_one() {
        let segments = [
            segment("测试一下"),
            segment("How do you do?"),
            segment("Fine."),
            segment("好的。"),
        ];
        assert_eq!(
            join_segments(&segments),
            "测试一下 How do you do? Fine. 好的。"
        );
    }

    fn scored(text: &str, no_speech_probability: f32) -> ScoredSegment {
        ScoredSegment {
            segment: segment(text),
            no_speech_probability,
            mean_log_probability: -0.3,
        }
    }

    #[test]
    fn drops_stock_sign_offs_whisper_writes_over_music() {
        assert!(scored("ご視聴ありがとうございました", 0.0).is_probably_invented());
        assert!(scored(" Thanks for watching!", 0.0).is_probably_invented());
        assert!(scored("字幕由Amara.org社区提供", 0.0).is_probably_invented());
        assert!(scored("Thank you.", 0.5).is_probably_invented());
        assert!(!scored("Thank you.", 0.05).is_probably_invented());
        assert!(!scored("Thanks for watching the build for me.", 0.5).is_probably_invented());
        assert!(!scored("我们下周发布。", 0.5).is_probably_invented());
    }

    #[test]
    fn converts_whisper_centiseconds() {
        assert_eq!(centiseconds_to_ms(123), 1230);
        assert_eq!(centiseconds_to_ms(-1), 0);
    }

    #[test]
    fn an_empty_recording_needs_no_model() {
        let segments = Engine::default()
            .transcribe(Path::new("/nonexistent/model.bin"), &[], None, None)
            .unwrap();
        assert!(segments.is_empty());
    }

    #[test]
    #[ignore = "needs a real model: REFLECT_WHISPER_TEST_MODEL=/path/to/ggml-*.bin"]
    fn transcribes_silence_without_inventing_speech() {
        super::super::prepare_process_environment();
        let model =
            std::env::var("REFLECT_WHISPER_TEST_MODEL").expect("REFLECT_WHISPER_TEST_MODEL");
        let engine = Engine::default();
        let segments = engine
            .transcribe(Path::new(&model), &vec![0.0; 16_000 * 2], None, None)
            .unwrap();
        assert!(
            join_segments(&segments).chars().count() < 20,
            "{segments:?}"
        );
    }
}
