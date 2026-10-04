import { useSyncExternalStore } from 'react'

/**
 * How far the running embedding backfill has walked the graph's notes.
 * EmbeddingsSync, the only backfill runner, publishes it; the search settings
 * show it, so a model switch, which re-embeds every note, reads as progress
 * rather than silence.
 */
export interface SemanticIndexProgress {
  readonly done: number
  readonly total: number
}

let progress: SemanticIndexProgress | null = null
const listeners = new Set<() => void>()

/** Publish the backfill's position; `null` once it ends. */
export function setSemanticIndexProgress(next: SemanticIndexProgress | null): void {
  progress = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The running backfill's progress, or `null` when none runs. */
export function useSemanticIndexProgress(): SemanticIndexProgress | null {
  return useSyncExternalStore(subscribe, () => progress)
}
