import { useState } from 'react'
import {
  emitFileChanges,
  errorMessage,
  indexNote,
  readNote,
  resolveConflictMarkers,
  writeNote,
  type ConflictResolution,
} from '@reflect/core'
import { invalidateIndexQueries } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

export interface ConflictResolutionState {
  busy: boolean
  error: string | null
  /** Splice the chosen side(s) into the file, reindex it, and notify views. */
  resolve: (keep: ConflictResolution) => Promise<void>
}

/**
 * Resolution of sync conflict markers for one note, as raw-text surgery:
 * splice the kept side(s) into the file's text (`resolveConflictMarkers` —
 * markers don't survive the editor round-trip, so the editor can't do this),
 * write it back, reindex, and notify open sessions. The conflict flag is a
 * projection of the file content, so consumers (the notice banner) clear
 * themselves once the resolved file reindexes.
 *
 * `shownContent` is the file text the user is deciding on (the protected
 * conflict view). The splice runs on exactly that text and the write is
 * checked against it, so a version that landed after the view rendered is
 * refused rather than resolved unseen; the view refreshes from disk and the
 * user decides again. Without it (no conflict view on screen) the splice runs
 * on a fresh read, and the write is checked against that.
 */
export function useConflictResolution(
  path: string,
  shownContent?: string,
): ConflictResolutionState {
  const { graph, indexGeneration } = useGraph()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const writeGeneration = graph?.generation ?? null

  async function resolve(keep: ConflictResolution): Promise<void> {
    if (writeGeneration === null) {
      return
    }
    setBusy(true)
    setError(null)
    let wrote = false
    try {
      const source = shownContent ?? (await readNote(path))
      const resolved = resolveConflictMarkers(source, keep)
      await writeNote(path, resolved, writeGeneration, source)
      wrote = true
      if (indexGeneration !== null) {
        await indexNote(path, { generation: indexGeneration, content: resolved })
      }
    } catch (caught: unknown) {
      setError(errorMessage(caught))
    } finally {
      if (wrote) {
        // The file changed on disk even if the reindex step failed (the
        // watcher will redo that) — reload the open (protected) session,
        // which round-trips again now and reopens editable, and refresh
        // index-backed views.
        emitFileChanges([{ path, kind: 'upsert' }], 'own-write')
        invalidateIndexQueries()
      }
      setBusy(false)
    }
  }

  return { busy, error, resolve }
}
