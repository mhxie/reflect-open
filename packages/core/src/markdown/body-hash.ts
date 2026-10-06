/**
 * Hash of a note body (frontmatter excluded) — what frontmatter blocks that
 * describe the body record, so the indexer can tell when the body moved on:
 * the `gist` block (the "Republish" nudge) and the `aiSummary` block (a
 * summary of an older body is stale). Staleness is deliberately a *content*
 * comparison: writing either block bumps or rewrites the file, so any
 * time-based check would flag a note as changed the instant it was recorded.
 *
 * FNV-1a over UTF-8, two 32-bit passes with different seeds folded into 16
 * hex chars. Synchronous on purpose — it runs inside the index projection
 * (`buildIndexedNote`, a pure sync function) — and not cryptographic: it
 * detects the user's own edits, nothing adversarial.
 */
export function noteBodyHash(body: string): string {
  const bytes = new TextEncoder().encode(body)
  return fnv1a32(bytes, 0x811c9dc5) + fnv1a32(bytes, 0x811c9dc5 ^ 0x5bd1e995)
}

function fnv1a32(bytes: Uint8Array, seed: number): string {
  let hash = seed >>> 0
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
