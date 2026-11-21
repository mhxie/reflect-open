/**
 * Pure geometry for the Attachments card flow: equal-width columns, each card
 * placed in the shortest column so far (leftmost on a tie), so the first cards
 * run left to right across the top and the columns stay balanced. Heights are
 * computed, not measured, which keeps the DOM in reading order (Tab and screen
 * readers follow it) while the cards sit in columns.
 */

/** One card's box, in px relative to the flow's top-left corner. */
export interface MasonryPosition {
  readonly column: number
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface MasonryLayout {
  readonly positions: readonly MasonryPosition[]
  /** Height of the whole flow — the tallest column. */
  readonly height: number
  readonly columnWidth: number
}

export interface MasonryOptions {
  /** The flow's content width. */
  readonly width: number
  /** Columns are added while each stays at least this wide. */
  readonly minColumnWidth: number
  /** Space between columns and between stacked cards. */
  readonly gap: number
}

/** How many columns fit `width`, and how wide each one is. */
export function masonryColumns({ width, minColumnWidth, gap }: MasonryOptions): {
  count: number
  columnWidth: number
} {
  const count = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)))
  return { count, columnWidth: Math.max(0, (width - gap * (count - 1)) / count) }
}

/**
 * Lay out `count` cards in order; `heightOf` gives a card's height at the
 * column width.
 */
export function layoutMasonry(
  count: number,
  heightOf: (index: number, columnWidth: number) => number,
  options: MasonryOptions,
): MasonryLayout {
  const { count: columnCount, columnWidth } = masonryColumns(options)
  const columnHeights = Array.from({ length: columnCount }, () => 0)
  const positions: MasonryPosition[] = []
  for (let index = 0; index < count; index++) {
    let column = 0
    for (let candidate = 1; candidate < columnCount; candidate++) {
      if ((columnHeights[candidate] ?? 0) < (columnHeights[column] ?? 0)) {
        column = candidate
      }
    }
    const top = columnHeights[column] ?? 0
    const height = heightOf(index, columnWidth)
    positions.push({
      column,
      left: column * (columnWidth + options.gap),
      top,
      width: columnWidth,
      height,
    })
    columnHeights[column] = top + height + options.gap
  }
  const tallest = Math.max(0, ...columnHeights)
  return { positions, height: count === 0 ? 0 : tallest - options.gap, columnWidth }
}

export type MasonryDirection = 'left' | 'right' | 'up' | 'down'

/**
 * The card an arrow key moves to from `index`: the one directly above or
 * below in the same column, or the one in the adjacent column nearest the
 * current card's vertical center. Null at an edge.
 */
export function masonryNeighbor(
  positions: readonly MasonryPosition[],
  index: number,
  direction: MasonryDirection,
): number | null {
  const current = positions[index]
  if (current === undefined) {
    return null
  }
  let best: number | null = null
  let bestDistance = Infinity
  const vertical = direction === 'up' || direction === 'down'
  const column = vertical ? current.column : current.column + (direction === 'left' ? -1 : 1)
  const center = current.top + current.height / 2
  for (const [candidate, position] of positions.entries()) {
    if (position.column !== column || candidate === index) {
      continue
    }
    const distance = !vertical
      ? Math.abs(position.top + position.height / 2 - center)
      : direction === 'up'
        ? current.top - position.top
        : position.top - current.top
    if ((!vertical || distance > 0) && distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  return best
}

/**
 * The cards whose boxes intersect the vertical band `[top, bottom)` (flow
 * coordinates), in reading order — what a virtualized flow mounts.
 */
export function masonryVisible(
  positions: readonly MasonryPosition[],
  top: number,
  bottom: number,
): number[] {
  const visible: number[] = []
  for (const [index, position] of positions.entries()) {
    if (position.top < bottom && position.top + position.height > top) {
      visible.push(index)
    }
  }
  return visible
}
