import {
  foldTag,
  type AttachmentLibraryEntry,
  type NoteAttachmentType,
  type NoteTagFacet,
} from '@reflect/core'

/** What the Attachments library is narrowed to; either part may be null. */
export interface AttachmentFilter {
  readonly type: NoteAttachmentType | null
  /** Files linked from a note carrying this tag (case-insensitive). */
  readonly tag: string | null
}

/** Does a note linking to `entry` carry the tag with folded key `tagKey`? */
function linkedWithTag(entry: AttachmentLibraryEntry, tagKey: string): boolean {
  return entry.notes.some((note) => note.tags.some((tag) => foldTag(tag) === tagKey))
}

/**
 * The entries matching both the type and the tag. Tags match on the folded
 * key, like the All Notes tag filter and the `#tag` search token.
 */
export function filterAttachments(
  entries: readonly AttachmentLibraryEntry[],
  { type, tag }: AttachmentFilter,
): readonly AttachmentLibraryEntry[] {
  const tagKey = tag === null ? null : foldTag(tag)
  if (type === null && tagKey === null) {
    return entries
  }
  return entries.filter(
    (entry) =>
      (type === null || entry.type === type) && (tagKey === null || linkedWithTag(entry, tagKey)),
  )
}

/**
 * The tags of the notes linking to `entries`, each with how many of those
 * files it reaches, ordered on the folded key. `#Trip` and `#trip` are one
 * facet, shown in the first casing seen.
 */
export function attachmentTagFacets(entries: readonly AttachmentLibraryEntry[]): NoteTagFacet[] {
  const facets = new Map<string, NoteTagFacet>()
  for (const entry of entries) {
    const counted = new Set<string>()
    for (const tag of entry.notes.flatMap((note) => note.tags)) {
      const key = foldTag(tag)
      if (counted.has(key)) {
        continue
      }
      counted.add(key)
      const facet = facets.get(key)
      if (facet === undefined) {
        facets.set(key, { tag, count: 1 })
      } else {
        facet.count += 1
      }
    }
  }
  return [...facets.keys()].sort().flatMap((key) => facets.get(key) ?? [])
}
