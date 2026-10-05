import { previewSnippet } from '../indexing/snippet.ts'
import { noteBodyHash } from './body-hash.ts'
import { loadFrontmatterBlock } from './frontmatter-load.ts'
import { splitFrontmatter } from './frontmatter.ts'
import { aiSummaryFrontmatterSchema, type Frontmatter } from './model.ts'

/**
 * The `aiSummary` frontmatter block's read side: whether it still describes
 * the body, and whether the block is Reflect's to rewrite. The block is
 * written by the background summary pass (`actions/note-summaries.ts`).
 */

/** Longest summary a row preview carries; longer text is clipped with an ellipsis. */
export const AI_SUMMARY_MAX_CHARS = 200

/** The frontmatter key the summary block lives under. */
export const AI_SUMMARY_KEY = 'aiSummary'

/**
 * The note's summary as a one-line preview when its block summarizes exactly
 * `body` (the note's body, frontmatter excluded), else `null` — a summary of
 * an older body is stale, and an empty one says nothing.
 */
export function freshAiSummary(frontmatter: Frontmatter, body: string): string | null {
  const summary = frontmatter.aiSummary
  if (summary === undefined || summary.hash !== noteBodyHash(body)) {
    return null
  }
  const preview = previewSnippet(summary.text, '', AI_SUMMARY_MAX_CHARS)
  return preview === '' ? null : preview
}

/**
 * Who owns the note's `aiSummary` key: `none` when it is absent, `managed`
 * when it holds a summary block of Reflect's shape, `foreign` when it holds
 * anything else — or when the frontmatter can't be loaded at all, since a
 * write would then have to rewrite bytes it can't read. Only `none` and
 * `managed` may be written.
 */
export function aiSummaryOwner(source: string): 'none' | 'managed' | 'foreign' {
  const { raw } = splitFrontmatter(source)
  if (raw === null || raw.trim() === '') {
    return 'none'
  }
  const load = loadFrontmatterBlock(raw)
  if (!load.loaded || typeof load.value !== 'object' || load.value === null) {
    return 'foreign'
  }
  if (!Object.hasOwn(load.value, AI_SUMMARY_KEY)) {
    return 'none'
  }
  const value: unknown = Reflect.get(load.value, AI_SUMMARY_KEY)
  return aiSummaryFrontmatterSchema.safeParse(value).success ? 'managed' : 'foreign'
}
