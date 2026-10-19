import type { IndexFileProgress } from './index-lifecycle-service.ts'

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

/**
 * Whether a pass is doing enough real work over a large graph to show its
 * progress: the gate every progress surface (the mobile pill, the activity
 * tray) shares.
 */
export function isIndexProgressWorthShowing(progress: IndexFileProgress | null): boolean {
  return progress !== null && progress.total >= MIN_TOTAL && progress.worked >= MIN_WORKED
}
