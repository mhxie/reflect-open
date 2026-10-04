/** The pin fields {@link comparePinPrecedence} ranks by. */
export interface PinRank {
  readonly isPinned: boolean
  readonly pinnedOrder: number | null
}

/**
 * Compare two notes by pin shelf precedence: pinned before unpinned, then
 * numbered pins (`pinned: <n>`, ascending) before bare `pinned: true`. Returns 0
 * when the two share a rank, leaving the caller's own tiebreak (recency, title)
 * to decide. This is the one JS expression of the order the sidebar's pinned list
 * encodes in SQL (`getPinnedNotes`), so the two can't drift.
 */
export function comparePinPrecedence(left: PinRank, right: PinRank): number {
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1 // pinned before unpinned
  }
  if (!left.isPinned) {
    return 0 // both unpinned — no pin-derived order
  }
  const { pinnedOrder: leftOrder } = left
  const { pinnedOrder: rightOrder } = right
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder
  }
  if ((leftOrder === null) !== (rightOrder === null)) {
    return leftOrder === null ? 1 : -1 // numbered pins before bare ones
  }
  return 0
}
