import type { WikiEntry } from './list.ts'

/**
 * `entry` as the Wiki screen lists it in the language whose folder is
 * `folder`: the entry's copy there stands in for its source copy — path,
 * title, modification time, preview, and revision day — so the row reads,
 * sorts, and opens in that language, while its topic, translations, inbound
 * links, tags, and claim counts stay the entry's own. Returned as is for the
 * source language (`folder` null) and when the entry has no copy in `folder`.
 */
export function wikiEntryIn(entry: WikiEntry, folder: string | null): WikiEntry {
  const copy = folder === null ? undefined : entry.translations.get(folder)
  return copy === undefined ? entry : { ...entry, ...copy }
}
