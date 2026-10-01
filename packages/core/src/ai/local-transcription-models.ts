/**
 * The on-device transcription models: whisper.cpp GGML conversions, and
 * Qwen3-ASR checkpoints run through candle. The ids mirror
 * `apps/desktop/src-tauri/src/local_transcription/` (`models.rs` maps the
 * whisper ids to files, `mod.rs` pins the Qwen repos); this catalog owns their
 * display names and sizes. Dependency-free so the settings schema can import it.
 */
export const LOCAL_TRANSCRIPTION_MODEL_IDS = [
  'large-v3-turbo',
  'large-v3-turbo-q8_0',
  'large-v3-turbo-q5_0',
  'large-v3-q5_0',
  'qwen3-asr-1.7b',
  'qwen3-asr-0.6b',
] as const

export type LocalTranscriptionModelId = (typeof LOCAL_TRANSCRIPTION_MODEL_IDS)[number]

/** The model a fresh install downloads when on-device transcription is chosen. */
export const DEFAULT_LOCAL_TRANSCRIPTION_MODEL: LocalTranscriptionModelId = 'large-v3-turbo'

export interface LocalTranscriptionModel {
  readonly id: LocalTranscriptionModelId
  readonly label: string
  readonly description: string
  readonly sizeBytes: number
}

export const LOCAL_TRANSCRIPTION_MODELS: readonly LocalTranscriptionModel[] = [
  {
    id: 'large-v3-turbo',
    label: 'Whisper large-v3 turbo',
    description: 'Full precision',
    sizeBytes: 1_624_555_275,
  },
  {
    id: 'large-v3-turbo-q8_0',
    label: 'Whisper large-v3 turbo (8-bit)',
    description: 'Half the size',
    sizeBytes: 874_188_075,
  },
  {
    id: 'large-v3-turbo-q5_0',
    label: 'Whisper large-v3 turbo (5-bit)',
    description: 'Smallest',
    sizeBytes: 574_041_195,
  },
  {
    id: 'large-v3-q5_0',
    label: 'Whisper large-v3 (5-bit)',
    description: 'Slower; stronger outside English',
    sizeBytes: 1_081_140_203,
  },
  {
    id: 'qwen3-asr-1.7b',
    label: 'Qwen3-ASR 1.7B',
    description: 'Reported stronger on Mandarin; largest',
    sizeBytes: 4_703_053_700,
  },
  {
    id: 'qwen3-asr-0.6b',
    label: 'Qwen3-ASR 0.6B',
    description: 'Smaller Qwen; weaker on mixed Chinese and English',
    sizeBytes: 1_880_559_070,
  },
]

/** The catalog entry for `id`. */
export function localTranscriptionModel(id: LocalTranscriptionModelId): LocalTranscriptionModel {
  return (
    LOCAL_TRANSCRIPTION_MODELS.find((model) => model.id === id) ?? LOCAL_TRANSCRIPTION_MODELS[0]!
  )
}
