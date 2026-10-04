import { parseNote, splitFrontmatter } from '../markdown/index.ts'
import { isUnsegmented } from '../indexing/cjk.ts'
import { hashContent } from '../indexing/hash.ts'
import {
  MAX_ASSET_TEXT_CHARS,
  type AssetDescriptionBody,
} from '../indexing/asset-description-text.ts'

/**
 * Sentence-aware note chunking (Plan 09). Sections split on headings, then
 * sentences accumulate toward a target size — small enough that a chunk is
 * about one idea, large enough that the embedding has context. Offsets are
 * whole-file positions (the same base the index uses for links), and each
 * chunk carries a content hash so unchanged chunks are never re-embedded.
 */

export interface NoteChunk {
  /** Nearest enclosing heading's text, if any. */
  heading: string | null
  posFrom: number
  posTo: number
  text: string
  contentHash: string
}

/**
 * Chunk sizes are in approximate model tokens, not characters: a Han, kana or
 * Hangul character is about one token, other text about one per four
 * characters, so a thousand characters of Chinese would overrun the 512-token
 * window the embedding models read while the same span of English fits twice.
 */
/** Accumulate sentences up to this many tokens before starting a new chunk. */
const TARGET_TOKENS = 300
/** No chunk runs past this (the window less room for the title context). */
const MAX_TOKENS = 450
/** A trailing chunk smaller than this merges into its predecessor. */
const MIN_TOKENS = 50

/** Approximate model tokens in `text` (see the size note above). */
export function approxTokens(text: string): number {
  let unsegmented = 0
  let other = 0
  for (const char of text) {
    if (isUnsegmented(char)) {
      unsegmented += 1
    } else if (char.trim() !== '') {
      other += 1
    }
  }
  return unsegmented + Math.ceil(other / 4)
}

/**
 * Sentence-ish boundaries: end punctuation + space, a CJK sentence end (no
 * space follows one), or a line break — list items and short lines are units
 * too. A span still over {@link MAX_TOKENS} (an unpunctuated wall of text) is
 * cut by size, at the last space before the limit when there is one.
 */
function sentenceSpans(text: string, base: number): Array<{ from: number; to: number }> {
  const spans: Array<{ from: number; to: number }> = []
  let start = 0
  const breaks = /[.!?][)"'”]?\s+|[。！？；…]+[」』”’）)]*|\n+/g
  const push = (from: number, to: number): void => {
    for (const piece of splitBySize(text, from, to)) {
      spans.push({ from: base + piece.from, to: base + piece.to })
    }
  }
  for (const match of text.matchAll(breaks)) {
    const end = match.index + match[0].length
    push(start, end)
    start = end
  }
  if (start < text.length) {
    push(start, text.length)
  }
  return spans
}

/** `text[from, to)` in pieces of at most {@link MAX_TOKENS}. */
function splitBySize(text: string, from: number, to: number): Array<{ from: number; to: number }> {
  if (approxTokens(text.slice(from, to)) <= MAX_TOKENS) {
    return [{ from, to }]
  }
  const pieces: Array<{ from: number; to: number }> = []
  let pieceFrom = from
  let tokens = 0
  let pending = 0 // characters toward the next token of space-delimited text
  let lastSpace = -1
  let at = from
  while (at < to) {
    const char = String.fromCodePoint(text.codePointAt(at)!)
    if (isUnsegmented(char)) {
      tokens += 1
    } else if (char.trim() === '') {
      lastSpace = at
    } else if (++pending === 4) {
      tokens += 1
      pending = 0
    }
    at += char.length
    if (tokens >= MAX_TOKENS) {
      const cut = lastSpace > pieceFrom ? lastSpace + 1 : at
      pieces.push({ from: pieceFrom, to: cut })
      pieceFrom = cut
      tokens = approxTokens(text.slice(cut, at))
      pending = 0
      lastSpace = -1
    }
  }
  if (pieceFrom < to) {
    pieces.push({ from: pieceFrom, to })
  }
  return pieces
}

interface Section {
  heading: string | null
  from: number
  to: number
}

/**
 * Accumulate one run of text into chunks: sentence spans gather toward
 * {@link TARGET_TOKENS} without passing {@link MAX_TOKENS}; offsets are
 * `base`-relative into the enclosing document. No runt-tail merging here —
 * each caller owns its own merge rule (the note merges only its final chunk,
 * asset bodies merge per body).
 */
async function chunkRun(text: string, base: number, heading: string | null): Promise<NoteChunk[]> {
  const chunks: NoteChunk[] = []
  let chunkFrom = -1
  let chunkTo = -1
  let chunkTokens = 0
  const flush = async (): Promise<void> => {
    if (chunkFrom === -1) {
      return
    }
    const chunkText = text.slice(chunkFrom - base, chunkTo - base)
    if (chunkText.trim() === '') {
      chunkFrom = -1
      return
    }
    chunks.push({
      heading,
      posFrom: chunkFrom,
      posTo: chunkTo,
      text: chunkText,
      contentHash: await hashContent(chunkText),
    })
    chunkFrom = -1
  }
  for (const span of sentenceSpans(text, base)) {
    const spanTokens = approxTokens(text.slice(span.from - base, span.to - base))
    if (chunkFrom !== -1 && chunkTokens + spanTokens > MAX_TOKENS) {
      await flush()
    }
    if (chunkFrom === -1) {
      chunkFrom = span.from
      chunkTokens = 0
    }
    chunkTo = span.to
    chunkTokens += spanTokens
    if (chunkTokens >= TARGET_TOKENS) {
      await flush()
    }
  }
  await flush()
  return chunks
}

/**
 * Merge the final chunk into its predecessor when it is a runt (smaller than
 * {@link MIN_TOKENS}) under the same heading — a tail that reads better (and
 * embeds better) merged, unless the merge would overrun {@link MAX_TOKENS}.
 * `sliceText` re-slices the merged span from the source the positions index
 * into.
 */
async function mergeRuntTail(
  chunks: NoteChunk[],
  sliceText: (from: number, to: number) => string,
): Promise<NoteChunk[]> {
  if (chunks.length < 2) {
    return chunks
  }
  const last = chunks[chunks.length - 1]!
  const prev = chunks[chunks.length - 2]!
  const lastTokens = approxTokens(last.text)
  if (
    lastTokens >= MIN_TOKENS ||
    prev.heading !== last.heading ||
    approxTokens(prev.text) + lastTokens > MAX_TOKENS
  ) {
    return chunks
  }
  const text = sliceText(prev.posFrom, last.posTo)
  return [
    ...chunks.slice(0, -2),
    {
      heading: prev.heading,
      posFrom: prev.posFrom,
      posTo: last.posTo,
      text,
      contentHash: await hashContent(text),
    },
  ]
}

/**
 * Chunk a note's source into embedding units. Pure; empty input → [].
 * Pass `parsed` when the caller already parsed the note (the embedding
 * pipeline does, for the asset list) to avoid a second parse.
 */
export async function chunkNote(
  path: string,
  source: string,
  parsed = parseNote({ path, source }),
): Promise<NoteChunk[]> {
  const headings = parsed.headings

  // Sections: the run before the first heading, then one per heading (each
  // extending to the next heading or end of file).
  const sections: Section[] = []
  const bodyStart = splitFrontmatter(source).bodyOffset
  const firstHeadingAt = headings.length > 0 ? headings[0]!.from : source.length
  if (firstHeadingAt > bodyStart) {
    sections.push({ heading: null, from: bodyStart, to: firstHeadingAt })
  }
  for (const [i, heading] of headings.entries()) {
    const to = i + 1 < headings.length ? headings[i + 1]!.from : source.length
    sections.push({ heading: heading.text, from: heading.from, to })
  }

  const chunks: NoteChunk[] = []
  for (const section of sections) {
    const text = source.slice(section.from, section.to)
    if (text.trim() === '') {
      continue
    }
    chunks.push(...(await chunkRun(text, section.from, section.heading)))
  }

  // Only the note's final chunk merges — mid-note section tails keep their
  // historical shape, so existing chunk hashes (and the re-embed skip) hold.
  return await mergeRuntTail(chunks, (from, to) => source.slice(from, to))
}

/** `assets/graphs/q4.png` → `q4.png` — the chunk heading for an asset body. */
function assetBasename(assetPath: string): string {
  return assetPath.split('/').pop() ?? assetPath
}

/**
 * Chunk a note's asset-description bodies (Plan 20 → semantic leg) into
 * embedding units attributed to the referencing note. Each body chunks like a
 * section whose heading is the asset's filename — light provenance for
 * snippets. Positions are synthetic: they start at `baseOffset` (past the end
 * of the note source, which has exclusive claim to real offsets) and advance
 * as if the bodies were appended to the note, so asset chunks order after
 * note chunks everywhere positions sort (vector pairing, related-notes
 * seeds). The combined text is capped at {@link MAX_ASSET_TEXT_CHARS},
 * mirroring the FTS fold.
 */
export async function chunkAssetDescriptions(
  bodies: readonly AssetDescriptionBody[],
  baseOffset: number,
): Promise<NoteChunk[]> {
  const chunks: NoteChunk[] = []
  let offset = baseOffset
  let budget = MAX_ASSET_TEXT_CHARS
  for (const { assetPath, body } of bodies) {
    if (chunks.length > 0) {
      budget -= 2 // the joiner counts against the FTS fold's slice — mirror it
    }
    if (budget <= 0) {
      break
    }
    const text = body.slice(0, budget)
    budget -= text.length
    const heading = assetBasename(assetPath)
    const bodyChunks = await mergeRuntTail(await chunkRun(text, offset, heading), (from, to) =>
      text.slice(from - offset, to - offset),
    )
    chunks.push(...bodyChunks)
    offset += text.length + 2 // as if joined by the FTS fold's blank line
  }
  return chunks
}
