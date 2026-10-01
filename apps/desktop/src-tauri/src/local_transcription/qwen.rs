//! Qwen3-ASR on Metal through candle (the `qwen3-asr` crate): a second
//! on-device model family beside whisper.cpp, reported stronger on Mandarin.
//!
//! The weights download from Hugging Face at a pinned revision into the same
//! hf-hub cache whisper uses, so nothing changes until the catalog moves the
//! pin. The repos ship no `tokenizer.json`, so one is assembled from the BPE
//! vocabulary next to the weights once the files are in.
//!
//! Qwen3-ASR returns one text per call and no timestamps; callers cut audio
//! into speech regions first (`utterances::QWEN_PLAN`) and time each region
//! by its edges.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hf_hub::api::sync::ApiBuilder;
use hf_hub::api::Progress;
use hf_hub::{Cache, Repo, RepoType};
use qwen3_asr::{AsrInference, TranscribeOptions};
use serde_json::{json, Value};

/// One Qwen3-ASR checkpoint at a pinned revision.
pub struct QwenModel {
    /// The settings id, mirrored by the frontend catalog.
    pub id: &'static str,
    pub repo: &'static str,
    pub revision: &'static str,
}

/// Written last, so a half-finished download never reads as ready.
const COMPLETE_MARKER: &str = ".reflect-complete";
const TOKENIZER_FILE: &str = "tokenizer.json";
const TEXT_FILES: [&str; 4] = [
    "config.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
];
const WEIGHTS_INDEX: &str = "model.safetensors.index.json";
const SINGLE_WEIGHTS: &str = "model.safetensors";

/// How long a loaded model survives without use; the 1.7B one holds about
/// 4 GB of GPU memory.
const IDLE_RELEASE: Duration = Duration::from_secs(10 * 60);
const IDLE_POLL: Duration = Duration::from_secs(60);

/// The hf-hub cache directory of the repo.
fn repo_dir(cache: &Path, model: &QwenModel) -> PathBuf {
    cache.join(format!("models--{}", model.repo.replace('/', "--")))
}

/// The pinned snapshot: weights, configuration, and the assembled tokenizer.
pub fn model_dir(cache: &Path, model: &QwenModel) -> PathBuf {
    repo_dir(cache, model)
        .join("snapshots")
        .join(model.revision)
}

pub fn is_downloaded(cache: &Path, model: &QwenModel) -> bool {
    model_dir(cache, model).join(COMPLETE_MARKER).is_file()
}

/// Remove every cached revision of the model.
pub fn remove(cache: &Path, model: &QwenModel) -> std::io::Result<()> {
    match fs::remove_dir_all(repo_dir(cache, model)) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

/// Download the pinned snapshot. `on_total` receives the byte count of the
/// weights before they start; `progress` then counts them as they arrive.
/// Weights already cached (a retry after a later step failed) are counted as
/// done rather than fetched again.
pub fn download<P: Progress + Clone>(
    cache: &Path,
    endpoint: String,
    model: &QwenModel,
    on_total: impl FnOnce(u64),
    mut progress: P,
) -> Result<(), String> {
    let api = ApiBuilder::new()
        .with_cache_dir(cache.to_path_buf())
        .with_endpoint(endpoint)
        .build()
        .map_err(|err| format!("hf-hub api: {err}"))?;
    let repo = api.repo(Repo::with_revision(
        model.repo.to_string(),
        RepoType::Model,
        model.revision.to_string(),
    ));
    let listed: Vec<String> = repo
        .info()
        .map_err(|err| format!("listing {}: {err}", model.repo))?
        .siblings
        .into_iter()
        .map(|sibling| sibling.rfilename)
        .collect();
    let weights = if listed.iter().any(|file| file == WEIGHTS_INDEX) {
        let index = repo
            .get(WEIGHTS_INDEX)
            .map_err(|err| format!("downloading {WEIGHTS_INDEX}: {err}"))?;
        shard_files(&fs::read_to_string(index).map_err(|err| err.to_string())?)?
    } else {
        vec![SINGLE_WEIGHTS.to_string()]
    };

    let mut sizes = Vec::with_capacity(weights.len());
    for file in &weights {
        let metadata = api
            .metadata(&repo.url(file))
            .map_err(|err| format!("sizing {file}: {err}"))?;
        sizes.push(metadata.size());
    }
    on_total(sizes.iter().map(|size| *size as u64).sum());

    let mut text_paths = Vec::with_capacity(TEXT_FILES.len());
    for file in TEXT_FILES {
        text_paths.push(
            repo.get(file)
                .map_err(|err| format!("downloading {file}: {err}"))?,
        );
    }
    let cached = Cache::new(cache.to_path_buf()).repo(Repo::with_revision(
        model.repo.to_string(),
        RepoType::Model,
        model.revision.to_string(),
    ));
    for (file, size) in weights.iter().zip(sizes) {
        if cached.get(file).is_some() {
            progress.update(size);
            continue;
        }
        repo.download_with_progress(file, progress.clone())
            .map_err(|err| format!("downloading {file}: {err}"))?;
    }

    let read = |path: &PathBuf| fs::read_to_string(path).map_err(|err| err.to_string());
    let tokenizer = tokenizer_json(
        &read(&text_paths[2])?,
        &read(&text_paths[3])?,
        &read(&text_paths[1])?,
    )?;
    let dir = model_dir(cache, model);
    fs::write(dir.join(TOKENIZER_FILE), tokenizer)
        .map_err(|err| format!("writing the tokenizer: {err}"))?;
    fs::write(dir.join(COMPLETE_MARKER), b"")
        .map_err(|err| format!("finishing the download: {err}"))
}

/// The weight shards a `model.safetensors.index.json` names, in order.
fn shard_files(index: &str) -> Result<Vec<String>, String> {
    let index: Value =
        serde_json::from_str(index).map_err(|err| format!("reading {WEIGHTS_INDEX}: {err}"))?;
    let map = index["weight_map"]
        .as_object()
        .ok_or_else(|| format!("{WEIGHTS_INDEX} has no weight_map"))?;
    let mut shards: Vec<String> = map
        .values()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    shards.sort();
    shards.dedup();
    Ok(shards)
}

/// A Qwen3 byte-level BPE `tokenizer.json` from the files the repo ships:
/// `vocab.json`, `merges.txt`, and the added tokens in `tokenizer_config.json`.
/// Mirrors the `qwen3-asr` crate's own hub loader (MIT), which isn't public.
fn tokenizer_json(vocab: &str, merges: &str, config: &str) -> Result<Vec<u8>, String> {
    let vocab: Value =
        serde_json::from_str(vocab).map_err(|err| format!("reading vocab.json: {err}"))?;
    let merges: Vec<&str> = merges
        .lines()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    let config: Value = serde_json::from_str(config)
        .map_err(|err| format!("reading tokenizer_config.json: {err}"))?;
    let mut added: Vec<(u64, &Value)> = config["added_tokens_decoder"]
        .as_object()
        .map(|decoder| {
            decoder
                .iter()
                .filter_map(|(id, token)| id.parse::<u64>().ok().map(|id| (id, token)))
                .collect()
        })
        .unwrap_or_default();
    added.sort_by_key(|(id, _)| *id);
    let added_tokens: Vec<Value> = added
        .into_iter()
        .map(|(id, token)| {
            json!({
                "id": id,
                "content": token["content"],
                "single_word": false,
                "lstrip": false,
                "rstrip": false,
                "normalized": false,
                "special": token["special"],
            })
        })
        .collect();
    let byte_level = json!({
        "type": "ByteLevel",
        "add_prefix_space": false,
        "trim_offsets": false,
        "use_regex": false,
    });
    let tokenizer = json!({
        "version": "1.0",
        "truncation": null,
        "padding": null,
        "added_tokens": added_tokens,
        "normalizer": { "type": "NFC" },
        "pre_tokenizer": {
            "type": "Sequence",
            "pretokenizers": [
                {
                    "type": "Split",
                    "pattern": { "Regex": "(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\\r\\n\\p{L}\\p{N}]?\\p{L}+|\\p{N}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n]*|\\s*[\\r\\n]+|\\s+(?!\\S)|\\s+" },
                    "behavior": "Isolated",
                    "invert": false,
                },
                byte_level,
            ],
        },
        "post_processor": byte_level,
        "decoder": byte_level,
        "model": {
            "type": "BPE",
            "dropout": null,
            "unk_token": null,
            "continuing_subword_prefix": "",
            "end_of_word_suffix": "",
            "fuse_unk": false,
            "byte_fallback": false,
            "ignore_merges": false,
            "vocab": vocab,
            "merges": merges,
        },
    });
    serde_json::to_vec(&tokenizer).map_err(|err| err.to_string())
}

/// The language name Qwen3-ASR's prompt takes for an ISO 639 code, or `None`
/// to let it detect the language.
pub fn language_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "zh" => "chinese",
        "yue" => "cantonese",
        "en" => "english",
        "ja" => "japanese",
        "ko" => "korean",
        "de" => "german",
        "fr" => "french",
        "es" => "spanish",
        "it" => "italian",
        "pt" => "portuguese",
        "ru" => "russian",
        "ar" => "arabic",
        _ => return None,
    })
}

/// Speech runs about 3 to 8 characters a second; a region that produced far
/// more text than it could hold is the decoder looping, not speech.
const MAX_CHARS_PER_SECOND: f32 = 25.0;

/// Whether `text` is plausible output for `seconds` of audio.
pub fn is_plausible(text: &str, seconds: f32) -> bool {
    let characters = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .count();
    characters > 0 && characters as f32 <= MAX_CHARS_PER_SECOND * seconds.max(1.0)
}

struct Loaded {
    dir: PathBuf,
    inference: Arc<AsrInference>,
    last_used: Instant,
    epoch: u64,
}

#[derive(Default)]
struct Slot {
    loaded: Option<Loaded>,
    epoch: u64,
}

/// The process-wide Qwen model slot, released after a quiet spell.
#[derive(Default, Clone)]
pub struct QwenEngine(Arc<Mutex<Slot>>);

impl QwenEngine {
    /// Transcribe one region of 16 kHz mono audio. Blocking.
    pub fn transcribe(
        &self,
        dir: &Path,
        samples: &[f32],
        language: Option<&str>,
    ) -> Result<String, String> {
        if samples.is_empty() {
            return Ok(String::new());
        }
        let inference = self.inference(dir)?;
        let mut options = TranscribeOptions::default();
        if let Some(name) = language.and_then(language_name) {
            options = options.with_language(name);
        }
        let result = inference
            .transcribe_samples(samples, options)
            .map_err(|err| format!("transcribing: {err}"))?;
        self.touch();
        Ok(result.text.trim().to_string())
    }

    /// Drop the loaded model (after a delete). An in-flight call keeps its
    /// own handle until it finishes.
    pub fn release(&self) {
        if let Ok(mut slot) = self.0.lock() {
            slot.loaded = None;
        }
    }

    fn inference(&self, dir: &Path) -> Result<Arc<AsrInference>, String> {
        {
            let mut slot = self.lock()?;
            if let Some(loaded) = slot.loaded.as_mut() {
                if loaded.dir == dir {
                    loaded.last_used = Instant::now();
                    return Ok(Arc::clone(&loaded.inference));
                }
            }
        }
        // Loading takes seconds; the slot stays unlocked meanwhile so a
        // release (a model delete, on the main thread) never waits for it.
        let inference = AsrInference::load(dir, qwen3_asr::best_device())
            .map(Arc::new)
            .map_err(|err| format!("loading the model: {err}"))?;
        let mut slot = self.lock()?;
        slot.epoch += 1;
        let epoch = slot.epoch;
        slot.loaded = Some(Loaded {
            dir: dir.to_path_buf(),
            inference: Arc::clone(&inference),
            last_used: Instant::now(),
            epoch,
        });
        self.watch_idle(epoch);
        Ok(inference)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Slot>, String> {
        self.0
            .lock()
            .map_err(|_| "the transcription engine lock was poisoned".to_string())
    }

    fn touch(&self) {
        if let Ok(mut slot) = self.0.lock() {
            if let Some(loaded) = slot.loaded.as_mut() {
                loaded.last_used = Instant::now();
            }
        }
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assembles_a_loadable_tokenizer() {
        let vocab = r#"{"a": 0, "b": 1, "ab": 2, "Ġ": 3}"#;
        let merges = "#version: 0.2\na b\n";
        let config = r#"{"added_tokens_decoder": {"5": {"content": "<|im_end|>", "special": true},
                         "4": {"content": "<|im_start|>", "special": true}}}"#;
        let bytes = tokenizer_json(vocab, merges, config).unwrap();
        let tokenizer = tokenizers::Tokenizer::from_bytes(&bytes).unwrap();
        let encoding = tokenizer.encode("ab<|im_end|>", false).unwrap();
        assert_eq!(encoding.get_ids(), &[2, 5]);
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["added_tokens"][0]["id"], 4);
    }

    #[test]
    fn lists_weight_shards_once_in_order() {
        let index = r#"{"weight_map": {"x": "model-00002-of-00002.safetensors",
                        "y": "model-00001-of-00002.safetensors",
                        "z": "model-00002-of-00002.safetensors"}}"#;
        assert_eq!(
            shard_files(index).unwrap(),
            vec![
                "model-00001-of-00002.safetensors",
                "model-00002-of-00002.safetensors"
            ]
        );
        assert!(shard_files("{}").is_err());
    }

    #[test]
    fn maps_languages_and_rejects_runaway_text() {
        assert_eq!(language_name("zh"), Some("chinese"));
        assert_eq!(language_name("xx"), None);
        assert!(is_plausible("我们下周发布。", 2.0));
        assert!(!is_plausible("", 2.0));
        assert!(!is_plausible(&"的".repeat(200), 2.0));
    }

    #[test]
    fn only_a_finished_download_reads_as_ready() {
        let cache = tempfile::tempdir().unwrap();
        let model = QwenModel {
            id: "qwen3-asr-0.6b",
            repo: "Qwen/Qwen3-ASR-0.6B",
            revision: "abc",
        };
        let dir = model_dir(cache.path(), &model);
        fs::create_dir_all(&dir).unwrap();
        assert!(!is_downloaded(cache.path(), &model));
        fs::write(dir.join(COMPLETE_MARKER), b"").unwrap();
        assert!(is_downloaded(cache.path(), &model));
        remove(cache.path(), &model).unwrap();
        assert!(!is_downloaded(cache.path(), &model));
        remove(cache.path(), &model).unwrap();
    }
}
