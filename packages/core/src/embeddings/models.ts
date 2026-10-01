/**
 * The embedding models the desktop runtime can load (`MODELS` in
 * `apps/desktop/src-tauri/src/embed.rs`; the ids must match). The first is
 * the default: the original model, so an existing index keeps its vectors.
 * Choosing another re-embeds the graph into a vector table of its width.
 */
export const SEMANTIC_MODEL_IDS = ['all-MiniLM-L6-v2', 'embeddinggemma-300m'] as const

export type SemanticModelId = (typeof SEMANTIC_MODEL_IDS)[number]

export const DEFAULT_SEMANTIC_MODEL: SemanticModelId = SEMANTIC_MODEL_IDS[0]

export interface SemanticModel {
  readonly id: SemanticModelId
  readonly label: string
  readonly description: string
  /** The download: the ONNX weights plus tokenizer files. */
  readonly sizeBytes: number
  /**
   * Neighbors farther than this cosine distance are noise, not matches. KNN
   * always fills its candidate list with the nearest chunks however unrelated
   * they are, so without a cutoff a gibberish query still "finds" notes; each
   * model spreads its distances differently, so each has its own.
   */
  readonly maxCosineDistance: number
}

export const SEMANTIC_MODELS: readonly SemanticModel[] = [
  {
    id: 'all-MiniLM-L6-v2',
    label: 'MiniLM',
    description: 'English only',
    sizeBytes: 91_102_036,
    // The old app's tuned cutoff: real matches land under ~0.65, gibberish
    // and unrelated queries at ~0.72+.
    maxCosineDistance: 0.7,
  },
  {
    id: 'embeddinggemma-300m',
    label: 'EmbeddingGemma',
    description: '100 languages',
    sizeBytes: 1_256_483_589,
    // Every link target it ranked in its top 10 on a real multilingual graph
    // lay within 0.63; 17 of 20 gibberish queries found nothing that close.
    maxCosineDistance: 0.63,
  },
]

/** The catalog entry for `id`; unknown ids (a model since dropped) read as the default. */
export function semanticModel(id: string): SemanticModel {
  return (
    SEMANTIC_MODELS.find((model) => model.id === id) ??
    SEMANTIC_MODELS.find((model) => model.id === DEFAULT_SEMANTIC_MODEL)!
  )
}
