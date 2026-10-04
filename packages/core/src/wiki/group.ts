import type { WikiEntry } from './list.ts'

/** One topic's entries on the Wiki screen. */
export interface WikiTopicGroup {
  /** The topic folder, or null for entries at the wiki root. */
  readonly topic: string | null
  readonly entries: readonly WikiEntry[]
}

/** What the Wiki screen's header counts. */
export interface WikiTotals {
  /** Entries with claims (guides and unread entries excluded). */
  readonly entries: number
  readonly claims: number
}

/**
 * Whether an entry is a guide — a hub such as a topic's `index.md` that
 * routes readers without making claims of its own.
 */
export function isWikiGuide(entry: WikiEntry): boolean {
  return entry.summary !== null && entry.summary.claims === 0
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

function compareTopics(left: string | null, right: string | null): number {
  if (left === null || right === null) {
    return left === right ? 0 : left === null ? -1 : 1
  }
  return collator.compare(left, right)
}

/**
 * A topic's key where a plain string is needed (the folded-topics setting,
 * React keys): the topic folder, or the empty string for the wiki root.
 */
export function wikiTopicKey(topic: string | null): string {
  return topic ?? ''
}

/** Guides first; a stable sort keeps the given order otherwise. */
function guidesFirst(left: WikiEntry, right: WikiEntry): number {
  return Number(isWikiGuide(right)) - Number(isWikiGuide(left))
}

/**
 * Group entries for display: root entries first, then topics A–Z. Within a
 * topic, guides lead and the rest keep the order they arrive in, so a sort
 * applied beforehand holds inside every group.
 */
export function groupWikiEntries(entries: readonly WikiEntry[]): WikiTopicGroup[] {
  const byTopic = new Map<string | null, WikiEntry[]>()
  for (const entry of entries) {
    const group = byTopic.get(entry.topic)
    if (group === undefined) {
      byTopic.set(entry.topic, [entry])
    } else {
      group.push(entry)
    }
  }
  return [...byTopic]
    .sort(([left], [right]) => compareTopics(left, right))
    .map(([topic, group]) => ({ topic, entries: [...group].sort(guidesFirst) }))
}

/** The header's counts over `entries`. */
export function wikiTotals(entries: readonly WikiEntry[]): WikiTotals {
  let count = 0
  let claims = 0
  for (const entry of entries) {
    if (entry.summary !== null && entry.summary.claims > 0) {
      count += 1
      claims += entry.summary.claims
    }
  }
  return { entries: count, claims }
}
