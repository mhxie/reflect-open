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

/** Maintain existing local OCR on open/wake and source changes, even when automatic OCR is off. */
export function startAssetOcrMaintenance(generation: number): () => void {
  if (!hasBridge()) return () => {}
  const changed = new Set<string>()
  let fullScan = true
  let loggedError: string | null = null
  const loop = createBackgroundReconciler({
    pass: async (isStale) => {
      const batch = [...changed]
      const scanAll = fullScan
      fullScan = false
      for (const path of batch) changed.delete(path)
      try {
        const invalidated = await reconcileCachedAssetOcr(generation, scanAll ? undefined : batch)
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
