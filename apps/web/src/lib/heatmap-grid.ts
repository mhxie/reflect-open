/** Cell edge and gap, px: fixed squares, so a wider sidebar shows more weeks. */
export const HEATMAP_CELL = 11
export const HEATMAP_GAP = 3
/** Width of the weekday label column, px. */
export const HEATMAP_LABEL_WIDTH = 24

/** Weeks shown before the first measurement, current week included. */
const DEFAULT_WEEK_COUNT = 13

/** How many week columns fit in `width` px beside the weekday labels (0 = unmeasured). */
export function weekColumnsFitting(width: number): number {
  if (width === 0) {
    return DEFAULT_WEEK_COUNT
  }
  return Math.max(
    1,
    Math.floor((width - HEATMAP_LABEL_WIDTH + HEATMAP_GAP) / (HEATMAP_CELL + HEATMAP_GAP)),
  )
}

/**
 * Where a key moves focus in the column-major day grid (index = column × 7 +
 * row), or null when the key doesn't move it. Arrows stay within their row or
 * column and stop at the edges; nothing moves past `lastIndex` (today).
 */
export function nextHeatmapIndex(key: string, index: number, lastIndex: number): number | null {
  const next = step(key, index, lastIndex)
  return next === null || next < 0 || next > lastIndex ? null : next
}

function step(key: string, index: number, lastIndex: number): number | null {
  const row = index % 7
  switch (key) {
    case 'Home':
      return 0
    case 'End':
      return lastIndex
    case 'ArrowUp':
      return row > 0 ? index - 1 : null
    case 'ArrowDown':
      return row < 6 ? index + 1 : null
    case 'ArrowLeft':
      return index - 7
    case 'ArrowRight':
      return index + 7
    default:
      return null
  }
}
