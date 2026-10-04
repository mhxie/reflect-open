/**
 * Live progress of the active index pass, published outside the graph
 * context on purpose: progress ticks arrive several times a second during a
 * first index, and pushing them through `GraphProvider` state would re-render
 * every `useGraph` consumer per tick — exactly when the thread is busiest.
 * The status pill subscribes here alone via `useSyncExternalStore`.
 */

/** How far the running pass has advanced through the file listing. */
export interface IndexProgress {
  /** Files the pass has moved past (skipped or indexed). */
  readonly done: number
  /** Files in the listing. */
  readonly total: number
  /**
   * Files the pass has actually read so far (not skipped read-free). The
   * pill gates on this: a routine pass skips everything (`worked` stays 0)
   * and must never surface, no matter how large the graph.
   */
  readonly worked: number
}

let current: IndexProgress | null = null
const listeners = new Set<() => void>()

/** Publish the running pass's progress; `null` clears it (pass finished). */
export function setIndexProgress(progress: IndexProgress | null): void {
  if (
    progress?.done === current?.done &&
    progress?.total === current?.total &&
    progress?.worked === current?.worked
  ) {
    return
  }
  current = progress
  for (const listener of listeners) {
    listener()
  }
}

/**
 * Below this listing size a pass finishes before progress is worth showing —
 * surfacing it would just flash on every open.
 */
const MIN_TOTAL = 100

/**
 * Files the pass must have actually *read* before progress shows. A pass runs
 * on every open and every resume, and even a healthy one sweeps the whole
 * listing (`done` counts skips) — so graph size alone would surface it every
 * time. Real reads are what make a pass long: a first index crosses this
 * within its first second; a skip-everything repeat pass stays at zero.
 */
const MIN_WORKED = 100

/** Whether a pass is doing enough real work over a large graph to show its progress. */
export function isIndexProgressWorthShowing(progress: IndexProgress | null): boolean {
  return progress !== null && progress.total >= MIN_TOTAL && progress.worked >= MIN_WORKED
}

/** The current pass's progress, or `null` when no pass is running. */
export function getIndexProgress(): IndexProgress | null {
  return current
}

/** Subscribe to progress updates (for `useSyncExternalStore`). */
export function subscribeIndexProgress(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
