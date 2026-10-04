/**
 * The marker lines of the atelier wiki schema, read for display and counting
 * alike: `@anchor` (an external source), `@pass` (a review), and `@cite` (a
 * citation of another entry), each a head followed by ` | `-separated
 * `key: value` fields — `@anchor: arxiv:2501.13956 | valid_at: 2026-04-06`.
 *
 * A marker holds over `[valid_at, invalid_at)`; a `@pass` dates itself with
 * `at`, and an undated marker never holds — the trust engine's rules.
 */

import { isIsoDate } from '@reflect/utils'

/** Which marker a line carries. */
export type WikiMarkerKind = 'anchor' | 'pass' | 'cite'

/** One parsed marker line. */
export interface WikiMarker {
  readonly kind: WikiMarkerKind
  /** The first field: `arxiv:2501.13956`, `reviewer`, or `[[Title#^c2]]`. */
  readonly head: string
  readonly fields: ReadonlyMap<string, string>
}

/** One external source of a claim, ready to show. */
export interface WikiSource {
  /** The anchor type, lowercased: `doi`, `arxiv`, `s2`, `isbn`, `url`, `gist`, … */
  readonly type: string
  readonly id: string
  /** A short name for the source: `arXiv 2501.13956`, `en.wikipedia.org`. */
  readonly label: string
  /** Where the source opens, or null when its id names no link. */
  readonly url: string | null
  /** The source's saved copy in Readwise Reader, when the anchor names one. */
  readonly readwiseUrl: string | null
  /** Whether the anchor holds on the day read (dated, and not invalidated). */
  readonly current: boolean
}

/** One recorded review of a claim. */
export interface WikiReviewPass {
  /** Who reviewed: `reviewer`, `scout`, `challenger`, … */
  readonly agent: string
  /** The verdict: `verified`, `flagged`, `inconclusive`, … */
  readonly status: string
  /** The review's date (`YYYY-MM-DD`), or null when unrecorded. */
  readonly at: string | null
  readonly current: boolean
}

/** What one fenced `anchors` block records about its claim. */
export interface WikiAnchorsBlock {
  readonly sources: readonly WikiSource[]
  readonly passes: readonly WikiReviewPass[]
}

const MARKER_RE = /^\s*@(anchor|pass|cite):\s*(.*)$/
const HTTP_URL_RE = /^https?:\/\//i

function isMarkerKind(value: string): value is WikiMarkerKind {
  return value === 'anchor' || value === 'pass' || value === 'cite'
}

/** The marker on `line`, or null when it carries none. */
export function parseWikiMarker(line: string): WikiMarker | null {
  const match = MARKER_RE.exec(line)
  const kind = match?.[1]
  if (match === null || kind === undefined || !isMarkerKind(kind)) {
    return null
  }
  const [head = '', ...pairs] = (match[2] ?? '').split(' | ')
  const fields = new Map<string, string>()
  for (const pair of pairs) {
    const colon = pair.indexOf(':')
    if (colon > 0) {
      fields.set(pair.slice(0, colon).trim(), pair.slice(colon + 1).trim())
    }
  }
  return { kind, head: head.trim(), fields }
}

/** The day a marker took effect: `valid_at`, or `at` for a `@pass`. */
export function wikiMarkerDate(marker: WikiMarker): string | undefined {
  return (
    marker.fields.get('valid_at') ?? (marker.kind === 'pass' ? marker.fields.get('at') : undefined)
  )
}

/** Whether `marker` holds on `asOf` (ISO `YYYY-MM-DD`). */
export function wikiMarkerHolds(marker: WikiMarker, asOf: string): boolean {
  const validAt = wikiMarkerDate(marker)
  if (validAt === undefined || !isIsoDate(validAt) || validAt > asOf) {
    return false
  }
  const invalidAt = marker.fields.get('invalid_at')
  return invalidAt === undefined || !isIsoDate(invalidAt) || invalidAt > asOf
}

/** Anchor types whose ids ignore case: DOIs, arXiv ids, ISBNs, Semantic Scholar ids. */
const CASE_INSENSITIVE_TYPES = new Set(['doi', 'arxiv', 'isbn', 's2'])

/** An anchor head's type (lowercased; empty when it names none) and id: `doi:10.1/x`. */
function splitAnchorHead(head: string): { readonly type: string; readonly id: string } {
  const colon = head.indexOf(':')
  return colon > 0
    ? { type: head.slice(0, colon).trim().toLowerCase(), id: head.slice(colon + 1).trim() }
    : { type: '', id: head }
}

/** Whether an anchor head names a source at all: `doi:` alone names none. */
export function wikiAnchorNamesSource(head: string): boolean {
  return splitAnchorHead(head).id !== ''
}

/**
 * The identity of an anchor's source, for counting distinct sources: the
 * same DOI in another case is one source, while URLs that differ only in
 * their path's case stay two.
 */
export function wikiSourceKey(head: string): string {
  const { type, id } = splitAnchorHead(head)
  if (CASE_INSENSITIVE_TYPES.has(type)) {
    return `${type}:${id.toLowerCase()}`
  }
  if (HTTP_URL_RE.test(id)) {
    try {
      return `${type}:${new URL(id).href}`
    } catch {
      return `${type}:${id}`
    }
  }
  return `${type}:${id}`
}

/** Where an anchor of `type` with `id` opens, or null when the id names no link. */
export function wikiSourceUrl(type: string, id: string): string | null {
  switch (type.toLowerCase()) {
    case 'doi':
      return `https://doi.org/${id}`
    case 'arxiv':
      return `https://arxiv.org/abs/${id}`
    case 's2':
      return `https://www.semanticscholar.org/paper/${id}`
    case 'isbn':
      return `https://openlibrary.org/isbn/${id.replaceAll(/[^\dx]/gi, '')}`
    default:
      return HTTP_URL_RE.test(id) ? id : null
  }
}

/** A short name for an anchor: its type and id, or a link's host. */
export function wikiSourceLabel(type: string, id: string): string {
  switch (type.toLowerCase()) {
    case 'doi':
      return `DOI ${id}`
    case 'arxiv':
      return `arXiv ${id}`
    case 's2':
      return 'Semantic Scholar'
    case 'isbn':
      return `ISBN ${id}`
    default:
      try {
        return new URL(id).hostname.replace(/^www\./, '')
      } catch {
        return id
      }
  }
}

/**
 * The sources and reviews one fenced `anchors` block records, as of `asOf`
 * (ISO `YYYY-MM-DD`). Sources and passes that no longer hold stay listed,
 * marked not current, so an invalidated anchor reads as struck rather than
 * vanishing. `@cite` lines carry no source and are skipped.
 */
export function readWikiAnchorsBlock(text: string, asOf: string): WikiAnchorsBlock {
  const sources: WikiSource[] = []
  const passes: WikiReviewPass[] = []
  for (const line of text.split(/\r?\n/)) {
    const marker = parseWikiMarker(line)
    if (marker === null) {
      continue
    }
    const current = wikiMarkerHolds(marker, asOf)
    if (marker.kind === 'anchor' && wikiAnchorNamesSource(marker.head)) {
      const { type, id } = splitAnchorHead(marker.head)
      const readwise = marker.fields.get('readwise')
      sources.push({
        type,
        id,
        label: wikiSourceLabel(type, id),
        url: wikiSourceUrl(type, id),
        readwiseUrl:
          readwise === undefined || readwise === ''
            ? null
            : `https://read.readwise.io/read/${readwise}`,
        current,
      })
    } else if (marker.kind === 'pass') {
      passes.push({
        agent: marker.head,
        status: marker.fields.get('status') ?? '',
        at: wikiMarkerDate(marker) ?? null,
        current,
      })
    }
  }
  return { sources, passes }
}
