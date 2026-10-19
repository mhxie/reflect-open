import { useState } from 'react'
import type { ConflictResolution } from '@reflect/core'
import { invalidateIndexQueries } from '@/lib/query-client.ts'
import { useCoreServices } from '@/services/services-provider.tsx'

export interface ConflictResolutionState {
  busy: boolean
  error: string | null
  /** Splice the chosen side(s) into the file, reindex it, and notify views. */
  resolve: (keep: ConflictResolution) => Promise<void>
}

/**
 * Resolution of sync conflict markers for one note: the busy and error state
 * around core's `ConflictResolutionService`, which does the raw-text surgery
 * (read the file, splice the kept side(s), write it back, reindex, and notify
 * open sessions). The conflict flag is a projection of the file content, so
 * consumers (the notice banner) clear themselves once the resolved file
 * reindexes.
 */
export function useConflictResolution(path: string): ConflictResolutionState {
  const { conflictResolution: service } = useCoreServices()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function resolve(keep: ConflictResolution): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const outcome = await service.resolve(path, keep)
      if (outcome.error !== null) {
        setError(outcome.error)
      }
      if (outcome.wrote) {
        // The file changed on disk even if the reindex step failed (the
        // watcher will redo that): refresh index-backed views.
        invalidateIndexQueries()
      }
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, resolve }
}
