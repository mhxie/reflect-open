/** One note `retrieve()` found, with what a result may show of it. */
export interface RetrievalHit {
  path: string
  title: string
  displayTitle?: string | null | undefined
  lang?: string | null | undefined
  score: number
  /** Chunk text (semantic) or highlight-markered FTS snippet (lexical). */
  snippet: string
  heading: string | null
  isPrivate: boolean
  /** Device-only attachment text in this note's indexed snapshot. */
  hasDeviceOnlyContent?: boolean
  /** Attachment-text identity from the same snapshot as the snippet. */
  assetTextHash?: string
  hasConflict: boolean
  /** Hybrid only: which leg found the note — wording, meaning, or both. */
  matchedBy?: 'lexical' | 'semantic' | 'both'
}
