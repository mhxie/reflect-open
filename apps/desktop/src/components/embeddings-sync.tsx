import { useEffect, useRef } from 'react'
import {
  embedNote,
  embedPrepareIndex,
  embedRemove,
  isNotePath,
  subscribeIndexApplied,
  withActivity,
} from '@reflect/core'
import {
  backfillEmbeddingsVisibly,
  consumeLegacySemanticOptIn,
  ensureEmbeddingsVisibly,
} from '@/lib/semantic.ts'
import { setSemanticIndexProgress } from '@/lib/semantic-index-progress.ts'
import { useEmbedStatus } from '@/lib/use-embed-status.ts'
import { isMainWindow } from '@/lib/windows/window-role.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'

/**
 * Keeps embeddings in sync with the graph (Plan 09). Renders nothing; mounted
 * once per workspace. Three jobs:
 *
 * - load the configured model whenever `semanticSearchEnabled` is on and the
 *   runtime is untouched or holds another model — at launch for users who
 *   opted in earlier (the cache makes that instant), the moment the setting
 *   flips on (the one place the first download starts), and when the model
 *   setting changes;
 * - run one incremental backfill per graph-open once `ready` (hash-skip makes
 *   this cheap when nothing changed), publishing its progress for the search
 *   settings;
 * - follow the index: changed notes re-embed, deleted notes drop vectors.
 *   Work is serialized on one queue so passes can't interleave.
 *
 * The follow trigger is `subscribeIndexApplied` — the post-apply signal — not
 * the raw watcher stream, for two reasons. Ordering: `embed_apply` drops
 * chunks for paths without a `notes` row, so embedding a brand-new note off
 * the raw file event could race its index apply and lose the chunks until the
 * next backfill; post-apply, the row is always there. Coverage: asset
 * description writes re-index their referencing notes *outside* the watcher
 * pipeline (`reindexNotesReferencing` emits the same signal), and those notes
 * must re-embed for the description text to reach semantic search.
 *
 * Backfill and follow work need the runtime `ready` *and* the setting on:
 * disabling semantic search pauses embedding work immediately (the loaded
 * model just idles for the rest of the session), and re-enabling catches up
 * via the cheap hash-skip backfill.
 */
/** Backfill progress is published every this many notes: smooth, not a render per note. */
const PROGRESS_STEP = 10

export function EmbeddingsSync(): null {
  const { graph, indexGeneration, indexing } = useGraph()
  const { settings, updateSettings } = useSettings()
  const status = useEmbedStatus()
  const queue = useRef<Promise<void>>(Promise.resolve())

  // embed_apply/embed_remove are gated on the INDEX session generation, not
  // the file-write generation in GraphInfo — the counters are independent.
  const generation = indexGeneration
  const root = graph?.root ?? null
  // Main window only: a secondary note window loading the model and
  // re-embedding on the same watcher stream would duplicate every write.
  const enabled = settings.semanticSearchEnabled && isMainWindow()
  const wanted = settings.semanticModel
  // Ready means ready with the configured model: until a switch lands, the
  // previous model must not write vectors into the table.
  const loaded = status.status === 'ready' && status.model === wanted ? status : null
  const ready = loaded !== null
  const modelId = loaded?.model ?? null
  const dims = loaded?.dims ?? null

  // The opt-in predates the settings document (it lived in localStorage);
  // carry it over once so those users keep semantic search across the move.
  useEffect(() => {
    if (consumeLegacySemanticOptIn()) {
      updateSettings({ semanticSearchEnabled: true })
    }
  }, [updateSettings])

  // Load while enabled and untouched, or holding another model. Deliberately
  // not retried on `failed`: an automatic loop would hammer a broken download
  // — recovery rides the explicit enable/retry actions instead (see
  // retryFailedEmbeddings).
  const loadedModel = status.status === 'ready' ? status.model : null
  useEffect(() => {
    if (
      enabled &&
      (status.status === 'uninitialized' || (loadedModel !== null && loadedModel !== wanted))
    ) {
      void ensureEmbeddingsVisibly(wanted)
    }
  }, [enabled, status.status, loadedModel, wanted])

  // One backfill per (graph, model) once ready and the index pass has
  // settled, then live post-apply follow-up. The backfill reads the note list
  // once, so starting it mid-pass would miss notes the pass hasn't indexed
  // yet; a pass starting later tears it down, and the hash-skip makes the
  // rerun after it cheap. `enabled` is part of the gate so a mid-session
  // disable tears this down: pending queue items see `active` go false and
  // skip, and the subscription drops.
  useEffect(() => {
    if (
      !enabled ||
      !ready ||
      indexing ||
      generation === null ||
      root === null ||
      modelId === null ||
      dims === null
    ) {
      return
    }
    let active = true

    queue.current = queue.current
      .then(async () => {
        if (!active) {
          return
        }
        // A model switch first refits the vector table to the new width.
        await embedPrepareIndex(modelId, dims, generation)
        if (!active) {
          return
        }
        try {
          // A switch re-embeds the whole graph, often with the window hidden.
          await withActivity('Embedding notes for semantic search', () =>
            backfillEmbeddingsVisibly({
              generation,
              modelId,
              onProgress: (done, total) => {
                if (active && (done === total || done % PROGRESS_STEP === 0)) {
                  setSemanticIndexProgress({ done, total })
                }
              },
              isStale: () => !active,
            }),
          )
        } finally {
          setSemanticIndexProgress(null)
        }
      })
      .catch((cause) => {
        // A rejection here must not poison the queue (later change items
        // chain off this promise) nor masquerade as a per-change failure.
        console.error('embedding backfill failed:', cause)
      })

    const unlisten = subscribeIndexApplied((changes, appliedGeneration) => {
      if (!active || appliedGeneration !== generation) {
        return // torn down, or a delayed emit from a superseded index session
      }
      for (const change of changes) {
        if (!isNotePath(change.path)) {
          continue // asset-file changes ride the same batches — never embedded
        }
        queue.current = queue.current
          .then(() => {
            if (!active) {
              return
            }
            return change.kind === 'remove'
              ? embedRemove(change.path, generation)
              : embedNote({ path: change.path, generation, modelId }).then(() => {})
          })
          .catch((cause) => {
            console.error(`embedding sync failed for ${change.path}:`, cause)
          })
      }
    })

    return () => {
      active = false
      unlisten()
    }
  }, [enabled, ready, indexing, generation, root, modelId, dims])

  return null
}
