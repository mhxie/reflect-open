import { isMap, parseDocument, type Document } from 'yaml'
import { loadFrontmatterBlock } from './frontmatter-load.ts'
import { classifyFrontmatterBlock, type FrontmatterPrivacy } from './frontmatter-privacy.ts'
import { frontmatterSchema, type Frontmatter } from './model.ts'

/**
 * YAML frontmatter handling (Plan 03). Markdown is the source of truth and files
 * may be edited outside Reflect, so parsing is **tolerant**: broken or non-object
 * YAML degrades to "no frontmatter" + a warning, never an unreadable note. The
 * known subset is typed via {@link frontmatterSchema}; unknown keys pass through.
 * Privacy is the one exception to tolerance: it fails closed (see
 * `frontmatter-privacy.ts`), so a block that can't be read counts as private.
 */

const BYTE_ORDER_MARK = '\u{FEFF}'

/** Result of carving a leading `---` block off the source. */
export interface FrontmatterSplit {
  /** YAML text between the fences, or `null` when there's no frontmatter block. */
  raw: string | null
  /** Everything after the block: its closing fence and the one blank line that may follow it. */
  body: string
  /** Character offset of `body` within the original source. */
  bodyOffset: number
}

const OPEN_FENCE = /^---[ \t]*\r?\n/
/**
 * A closing `---` line, at the block start (empty frontmatter) or after a
 * newline, plus the blank line separating the block from the body. That line
 * belongs to the block: read as body it would be an empty first paragraph.
 */
const CLOSE_FENCE = /(?:^|\r?\n)---[ \t]*(?:\r?\n(?:[ \t]*\r?\n)?|$)/

/** Carve a leading YAML frontmatter block off `source`, preserving offsets. */
export function splitFrontmatter(source: string): FrontmatterSplit {
  const open = OPEN_FENCE.exec(source)
  if (!open || open.index !== 0) {
    return { raw: null, body: source, bodyOffset: 0 }
  }
  const afterOpen = open[0].length
  const rest = source.slice(afterOpen)
  const close = CLOSE_FENCE.exec(rest)
  if (!close) {
    // Unterminated fence — treat the whole file as body (tolerant).
    return { raw: null, body: source, bodyOffset: 0 }
  }
  const raw = rest.slice(0, close.index)
  const bodyOffset = afterOpen + close.index + close[0].length
  return { raw, body: source.slice(bodyOffset), bodyOffset }
}

/** Parsed frontmatter plus an optional non-fatal warning. */
export interface ParsedFrontmatter {
  /** The typed fields; `data.private` is `privacy`'s withheld bit. */
  data: Frontmatter
  warning?: string
  /** The block's privacy (a leading byte-order mark is {@link frontmatterPrivacy}'s to judge). */
  privacy: FrontmatterPrivacy
}

const PUBLIC: FrontmatterPrivacy = { kind: 'public' }

function emptyFrontmatter(): Frontmatter {
  return frontmatterSchema.parse({})
}

/**
 * Parse the YAML text from {@link splitFrontmatter}. Never throws: a block that
 * doesn't load (malformed, not a mapping, several documents, over a budget)
 * yields defaults + a warning so the note stays readable. `data.private` is
 * true when the block classifies as private *or* unreadable.
 */
export function parseFrontmatter(raw: string | null): ParsedFrontmatter {
  if (raw === null || raw.trim() === '') {
    return { data: emptyFrontmatter(), privacy: PUBLIC }
  }
  const load = loadFrontmatterBlock(raw)
  const privacy = classifyFrontmatterBlock(raw, load)
  const isPrivate = privacy.kind !== 'public'
  if (!load.loaded) {
    return { data: { ...emptyFrontmatter(), private: isPrivate }, warning: load.warning, privacy }
  }
  // The schema is built to tolerate bad known fields (`.catch`) and preserve
  // unknown keys (`.passthrough`), so this won't throw for an object input.
  return { data: { ...frontmatterSchema.parse(load.value), private: isPrivate }, privacy }
}

/**
 * A note's frontmatter privacy from its full source. Like
 * {@link parseFrontmatter}, plus the one rule that needs the whole file: a
 * block hidden behind a leading byte-order mark is classified as usual, but
 * `private` becomes `unreadable` — the app sees no frontmatter there, so it
 * could neither show the lock nor toggle it.
 */
export function frontmatterPrivacy(source: string): FrontmatterPrivacy {
  const behindMark = source.startsWith(BYTE_ORDER_MARK)
  const { raw } = splitFrontmatter(behindMark ? source.slice(BYTE_ORDER_MARK.length) : source)
  if (raw === null || raw.trim() === '') {
    return PUBLIC
  }
  const privacy = classifyFrontmatterBlock(raw, loadFrontmatterBlock(raw))
  return behindMark && privacy.kind === 'private'
    ? { kind: 'unreadable', reason: 'bomBeforeFence' }
    : privacy
}

/**
 * Apply `patch` to a note's frontmatter, returning the new source. Minimal-diff:
 * the body is preserved byte-for-byte and only the frontmatter region is
 * rewritten via the YAML `Document` API, which keeps key order, comments, and
 * unknown keys. A `undefined` value deletes the key. Creates a block if none
 * exists (and the patch sets something), and removes the block entirely when
 * deleting its last key — a note whose only metadata was a toggled flag returns
 * to having no frontmatter at all, not an empty `---` husk. A written block
 * uses the document's line ending and always ends with its blank separator
 * line, so a body that opens with a blank line keeps it.
 */
export function upsertFrontmatter(source: string, patch: Record<string, unknown>): string {
  // An empty patch is a no-op — never re-serialize (which could disturb comments,
  // spacing, or key order in an existing block).
  if (Object.keys(patch).length === 0) {
    return source
  }

  // A block behind a leading byte-order mark is invisible to the split: a new
  // block in front of it would leave the old one, `private` and all, as body.
  if (source.startsWith(BYTE_ORDER_MARK) && splitFrontmatter(source.slice(1)).raw !== null) {
    throw new Error('refusing to update frontmatter behind a byte-order mark')
  }
  const { raw, body } = splitFrontmatter(source)
  const doc = parseDocument(raw ?? '')
  // Reading tolerates malformed YAML (it degrades to a warning), but *writing*
  // must not: re-serializing a partial parse would drop the bytes the parser
  // couldn't model. Refuse rather than silently corrupt the note's frontmatter.
  if (doc.errors.length > 0) {
    throw new Error(`refusing to update invalid YAML frontmatter: ${doc.errors[0]!.message}`)
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      doc.set(key, value)
    } else if (doc.has(key)) {
      doc.delete(key)
    }
  }
  if (isEmptyDocument(doc)) {
    return body
  }
  const block = `---\n${ensureTrailingNewline(String(doc))}---\n\n`
  return block + body
}

/**
 * True when the patched document holds nothing worth a block: no keys and no
 * document-level comments (a commented block is kept — dropping it would lose
 * bytes the user wrote).
 */
function isEmptyDocument(doc: Document): boolean {
  const noKeys = doc.contents === null || (isMap(doc.contents) && doc.contents.items.length === 0)
  return noKeys && doc.commentBefore == null && doc.comment == null
}

/** Guard against a YAML serializer that omits the trailing newline before `---`. */
function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}
