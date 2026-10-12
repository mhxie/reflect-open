import type { AiProvidersState } from '../ai/provider-config.ts'
import type { ReconcileStop } from './audio-memo.ts'

/** Whether new eligible assets are described automatically vs. only on backfill. */
export type AssetDescriptionMode = 'incremental' | 'backfill'

export interface ReconcileAssetDescriptionsInput {
  /** The configured-providers state — decides the provider and keychain entry. */
  providers: AiProvidersState
  /** Explicit on-device vision provider. A missing/invalid selection never falls back. */
  localOcrProviderId?: string | null | undefined
  /** `GraphInfo.generation` — pins every read/write to the issuing graph. */
  generation: number
  /** `incremental` processes `changed`; `backfill` enumerates every asset. */
  mode: AssetDescriptionMode
  /** Incremental only: the eligible asset paths the watcher reported changed. */
  changed?: readonly string[]
  /** Host transport for the provider call (the Tauri HTTP plugin's fetch). */
  fetchFn?: typeof fetch
  /** Abort gate, checked between assets and after each slow await. */
  isStale?: () => boolean
  /** Backfill progress: `(processed, total)` after each handled asset. */
  onProgress?: (processed: number, total: number) => void
  /** Injectable clock for the description's `generatedAt`. */
  now?: () => Date
}

export interface ReconcileAssetDescriptionsOutcome {
  /** Eligible assets this pass considered. */
  pending: number
  /** Assets described and written this pass. */
  described: number
  /** Skipped — a managed description already matched the source hash. */
  skippedUpToDate: number
  /** Skipped — referenced by no public note (or none at all). */
  skippedUnreferenced: number
  /** Skipped — referenced by a private note (the hard block). */
  skippedPrivate: number
  /** Skipped — an existing description was user-authored, never overwritten. */
  skippedUserAuthored: number
  /**
   * Skipped — the description file changed while the asset was being
   * described (a sync pull, the user); the new file is kept as it is.
   */
  skippedChanged: number
  /** Skipped — larger than the size cap, or a type this platform can't read. */
  skippedOversize: number
  /**
   * Permanent refusals — logged, no description written: the provider refused
   * the asset, or (local OCR) its source couldn't be read or recognized.
   */
  refused: number
  /**
   * Asset paths for which a description was written this pass. The caller
   * re-indexes the notes referencing them so the new text becomes searchable
   * (`reindexNotesReferencing`).
   */
  describedAssetPaths: string[]
  /** Why the pass ended early, or `null` when every asset was handled. */
  stopped: ReconcileStop | null
}
