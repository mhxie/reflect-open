/**
 * Pure gist-publishing content helpers: the filename a note publishes under.
 * The body hash that drives the "Republish" nudge is `noteBodyHash`
 * (`body-hash.ts`), shared with the indexer so publish-time and index-time
 * staleness never disagree.
 */

/**
 * The gist filename for a note title: `<title>.md`, so the gist renders as
 * markdown under a human name (dailies' titles are already their ISO date).
 * Path separators would read as structure that isn't there — they fold to
 * dashes — and an empty or whitespace title falls back to `Untitled`.
 */
export function gistFilename(title: string): string {
  const safe = title.replaceAll(/[/\\]/g, '-').trim()
  return `${safe === '' ? 'Untitled' : safe}.md`
}
