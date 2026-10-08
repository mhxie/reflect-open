/** What the editor showed for one claim when its saved file version was first seen. */
export interface SavedClaim {
  /** The claim's hash in the saved file. */
  readonly saved: string
  /** The editor's text for the claim while that file version was current. */
  readonly text: string
}

/**
 * Carry each claim's saved snapshot forward. A claim keeps its snapshot while
 * its saved hash is unchanged, so a refetch of the same file never adopts
 * unsaved text; it takes the editor's text when the file version is new, or
 * when the editor's own hash equals the file's (the editor shows the file,
 * as after a reload). Returns `previous` itself when nothing changed.
 */
export function nextSavedClaims(
  previous: ReadonlyMap<string, SavedClaim>,
  saved: ReadonlyMap<string, string>,
  texts: ReadonlyMap<string, string>,
  editorHashes: ReadonlyMap<string, string> | null,
): ReadonlyMap<string, SavedClaim> {
  const next = new Map<string, SavedClaim>()
  let same = true
  for (const [id, text] of texts) {
    const hash = saved.get(id)
    if (hash === undefined) continue
    const before = previous.get(id)
    const shown = editorHashes?.get(id) === hash
    const entry =
      before !== undefined && before.saved === hash && !(shown && before.text !== text)
        ? before
        : { saved: hash, text }
    if (entry !== before) same = false
    next.set(id, entry)
  }
  return same && next.size === previous.size ? previous : next
}

/**
 * Whether the editor holds unsaved text for a claim: it moved on from the
 * snapshot taken for the saved version, and does not hash to that version.
 */
export function hasUnsavedEdit(
  savedClaims: ReadonlyMap<string, SavedClaim>,
  id: string,
  text: string | undefined,
  editorHash: string | undefined,
): boolean {
  const entry = savedClaims.get(id)
  return entry !== undefined && entry.text !== text && editorHash !== entry.saved
}
