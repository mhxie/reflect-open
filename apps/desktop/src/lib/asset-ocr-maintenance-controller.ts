import {
  errorMessage,
  hasBridge,
  localOcrAssetTypeFor,
  reconcileCachedAssetOcr,
  reindexNotesReferencing,
  subscribeIndexApplied,
} from '@reflect/core'
import { createBackgroundReconciler } from './background-reconciler.ts'
import { invalidateIndexQueries } from './query-client.ts'

/**
 * The least time between wake-triggered full scans: focus fires on every
 * switch back to the app, and a scan reads every cache entry.
 */
const WAKE_SCAN_INTERVAL_MS = 5 * 60 * 1000

/** Maintain existing local OCR on open/wake and source changes, even when automatic OCR is off. */
export function startAssetOcrMaintenance(generation: number): () => void {
  if (!hasBridge()) return () => {}
  const changed = new Set<string>()
  let fullScan = true
  // Open (and a retry after a failed reindex) reindexes every cached source;
  // a wake scan reindexes only what it invalidates.
  let reindexCached = true
  // Wake scans trust an unchanged size and mtime; open and retries re-hash.
  let trustUnchangedStat = false
  let lastWakeScan = -Infinity
  let loggedError: string | null = null
  const loop = createBackgroundReconciler({
    pass: async (isStale) => {
      const batch = [...changed]
      const scanAll = fullScan
      const reindexAll = reindexCached
      const trustStat = trustUnchangedStat
      fullScan = false
      reindexCached = false
      trustUnchangedStat = false
      for (const path of batch) changed.delete(path)
      try {
        const invalidated = await reconcileCachedAssetOcr(generation, scanAll ? undefined : batch, {
          reindexCached: scanAll && reindexAll,
          trustUnchangedStat: scanAll && trustStat,
        })
        if (isStale()) return
        const affected = [...new Set([...batch, ...invalidated])]
        if (affected.length > 0) {
          await reindexNotesReferencing(affected, generation)
          if (!isStale()) invalidateIndexQueries()
        }
        loggedError = null
      } catch (cause) {
        for (const path of batch) changed.add(path)
        fullScan = true
        reindexCached = true
        const message = errorMessage(cause)
        if (!isStale() && loggedError !== message) {
          loggedError = message
          console.warn('Local OCR maintenance failed:', message)
        }
        return 'stop'
      }
    },
  })
  loop.onDispose(
    subscribeIndexApplied((changes, currentGeneration) => {
      if (currentGeneration !== generation) return
      for (const change of changes) {
        if (localOcrAssetTypeFor(change.path) !== null) changed.add(change.path)
      }
      if (changed.size > 0) loop.schedule()
    }),
  )
  const wake = (): void => {
    const now = Date.now()
    // A failed pass (`fullScan` still set) retries on the next wake regardless.
    if (!fullScan) {
      if (now - lastWakeScan < WAKE_SCAN_INTERVAL_MS) return
      trustUnchangedStat = true
    }
    lastWakeScan = now
    fullScan = true
    loop.schedule()
  }
  window.addEventListener('focus', wake)
  window.addEventListener('online', wake)
  loop.onDispose(() => window.removeEventListener('focus', wake))
  loop.onDispose(() => window.removeEventListener('online', wake))
  loop.schedule()
  return () => loop.dispose()
}
