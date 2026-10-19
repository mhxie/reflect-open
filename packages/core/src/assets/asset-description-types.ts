import type { ReconcileStop } from '../reconcile/reconcile.ts'

/**
 * Whether new eligible assets are described automatically vs. only on backfill.
 */
export type AssetDescriptionMode = 'incremental' | 'backfill'

export interface ReconcileAssetDescriptionsInput {
  /**
   * `GraphInfo.generation` — pins every read/write to the issuing graph.
   */
  generation: number
  /**
   * `incremental` processes `changed`; `backfill` enumerates every asset.
   */
  mode: AssetDescriptionMode
  /**
   * The explicitly selected on-device vision provider (`localOcrProviderId`).
   * Set, the pass recognizes text into the device-only OCR cache with that
   * model only; a missing, unverified or non-vision selection stops the pass
   * and never falls back to a cloud provider. Absent, the pass writes managed
   * AI descriptions with the default provider.
   */
  localOcrProviderId?: string | null | undefined
  /**
   * Incremental only: the eligible asset paths the watcher reported changed.
   */
  changed?: readonly string[]
  /**
   * Abort gate, checked between assets and after each slow await.
   */
  isStale?: () => boolean
  /**
   * Backfill progress: `(processed, total)` after each handled asset.
   */
  onProgress?: (processed: number, total: number) => void
}

export interface ReconcileAssetDescriptionsOutcome {
  /**
   * Eligible assets this pass considered.
   */
  pending: number
  /**
   * Assets described and written this pass.
   */
  described: number
  /**
   * Skipped — a managed description already matched the source hash.
   */
  skippedUpToDate: number
  /**
   * Skipped — referenced by no public note (or none at all).
   */
  skippedUnreferenced: number
  /**
   * Skipped — referenced by a private note (the hard block).
   */
  skippedPrivate: number
  /**
   * Skipped — an existing description was user-authored, never overwritten.
   */
  skippedUserAuthored: number
  /**
   * Skipped — the description file (or, for local OCR, the source) changed
   * while the asset was being described (a sync pull, the user); the new file
   * is kept as it is and the asset is tried again.
   */
  skippedChanged: number
  /**
   * Skipped — larger than the size cap, or a type this platform can't read.
   */
  skippedOversize: number
  /**
   * Permanent refusals — logged, no description written: the provider refused
   * the asset, or (local OCR) its source couldn't be read or recognized.
   */
  refused: number
  /**
   * Asset paths for which a description was written this pass. The session
   * and the backfill re-index the notes referencing them so the new text
   * becomes searchable (`IndexLifecycleService.reindexNotesReferencing`).
   */
  describedAssetPaths: string[]
  /**
   * Why the pass ended early, or `null` when every asset was handled.
   */
  stopped: ReconcileStop | null
}
