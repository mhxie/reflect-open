import { z } from 'zod'
import { isTagName } from '../markdown/extract.ts'
import { foldTag } from '../markdown/keys.ts'

/** A menu action that changes a pinned filter's display position. */
export type PinnedTagMove = 'top' | 'up' | 'down' | 'bottom'

/** Parse a typed tag using the same grammar and folding as the note index. */
export function normalizePinnedTag(input: unknown): string | null {
  const parsed = z.string().safeParse(input)
  if (!parsed.success) {
    return null
  }
  const tag = foldTag(parsed.data.trim().replace(/^#+/, '').trim())
  return isTagName(tag) ? tag : null
}

/** Normalize stored pins, retaining their first occurrence and display order. */
export function normalizePinnedTags(input: unknown): string[] {
  const parsed = z.array(z.string()).safeParse(input)
  if (!parsed.success) {
    return []
  }
  const tags = new Set<string>()
  for (const value of parsed.data) {
    const tag = normalizePinnedTag(value)
    if (tag !== null) {
      tags.add(tag)
    }
  }
  return [...tags]
}

/** Append a valid, previously unpinned tag, including tags with no indexed notes. */
export function pinFilterTag(tags: readonly string[], input: unknown): string[] {
  const normalized = normalizePinnedTags(tags)
  const tag = normalizePinnedTag(input)
  return tag === null || normalized.includes(tag) ? normalized : [...normalized, tag]
}

/** Remove a filter preference without changing any note's tags. */
export function unpinFilterTag(tags: readonly string[], input: unknown): string[] {
  const tag = normalizePinnedTag(input)
  return normalizePinnedTags(tags).filter((existing) => existing !== tag)
}

function moveToIndex(tags: string[], source: number, target: number): string[] {
  const tag = tags[source]
  if (tag === undefined || target < 0 || target >= tags.length || source === target) {
    return tags
  }
  tags.splice(source, 1)
  tags.splice(target, 0, tag)
  return tags
}

/** Move a pinned filter through one of the row's explicit ordering actions. */
export function movePinnedFilterTag(
  tags: readonly string[],
  input: unknown,
  move: PinnedTagMove,
): string[] {
  const normalized = normalizePinnedTags(tags)
  const tag = normalizePinnedTag(input)
  const source = tag === null ? -1 : normalized.indexOf(tag)
  const target =
    move === 'top'
      ? 0
      : move === 'bottom'
        ? normalized.length - 1
        : move === 'up'
          ? source - 1
          : source + 1
  return moveToIndex(normalized, source, target)
}

/** Preview or drop a sortable filter at another pinned filter's position. */
export function orderPinnedFilterTags(
  tags: readonly string[],
  input: unknown,
  over: unknown,
): string[] {
  const normalized = normalizePinnedTags(tags)
  const tag = normalizePinnedTag(input)
  const overTag = normalizePinnedTag(over)
  return moveToIndex(
    normalized,
    tag === null ? -1 : normalized.indexOf(tag),
    overTag === null ? -1 : normalized.indexOf(overTag),
  )
}

/** Compare the exact order of two canonical pin lists. */
export function pinnedTagOrdersEqual(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((tag, index) => tag === second[index])
}

/**
 * Commit a complete drag order only while its original preference list is current.
 * Reject malformed permutations so a stale drag cannot remove or resurrect pins.
 */
export function reorderPinnedFilterTags(
  current: readonly string[],
  original: readonly string[],
  next: readonly string[],
): string[] {
  const normalized = normalizePinnedTags(current)
  const before = normalizePinnedTags(original)
  const after = normalizePinnedTags(next)
  if (
    !pinnedTagOrdersEqual(normalized, before) ||
    before.length !== original.length ||
    after.length !== next.length ||
    after.length !== normalized.length ||
    after.some((tag) => !normalized.includes(tag))
  ) {
    return normalized
  }
  return after
}
