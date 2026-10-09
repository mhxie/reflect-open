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
import { z } from 'zod'

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
  readonly validAt: string | null
  readonly invalidAt: string | null
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
  /** Source note or session explaining the review. */
  readonly ref?: string
}

/** Dates attached to an ordinary wiki link that is explicitly marked as evidence. */
export interface WikiCitationDates {
  readonly validAt: string
  readonly invalidAt?: string
}

/** A note/claim reference; its target remains an ordinary renameable wiki link. */
export interface WikiCitation extends WikiCitationDates {
  readonly target: string
  readonly label: string
  readonly current: boolean
}

/** Evidence targets name a note, optionally one stable positive-numbered wiki claim. */
export function isWikiCitationTarget(target: string): boolean {
  const match = /^([^#[\]\r\n|]+)(?:#\^c[1-9]\d*)?$/.exec(target)
  return match !== null && (match[1]?.trim() ?? '') !== ''
}

/** What one fenced `anchors` block records about its claim. */
export interface WikiAnchorsBlock {
  readonly sources: readonly WikiSource[]
  readonly passes: readonly WikiReviewPass[]
  readonly citations: readonly WikiCitation[]
  /** Lines that must remain discoverable rather than disappearing behind a successful parse. */
  readonly unparsed: readonly string[]
}

const MARKER_RE = /^\s*@(anchor|pass|cite):\s*(.*)$/
const HTTP_URL_RE = /^https?:\/\//i
const citationSchema = z
  .strictObject({
    valid_at: z.string().refine(isIsoDate),
    invalid_at: z.string().refine(isIsoDate).optional(),
  })
  .refine((dates) => dates.invalid_at === undefined || dates.invalid_at > dates.valid_at)
const citationMetadataSchema = z.object({ citation: citationSchema })

const WEIGHT_RE = /^\d+(?:\.\d+)?$/
const ANCHOR_KINDS = new Set(['primary', 'secondary'])

/**
 * Whether an `@anchor` or `@pass` line is malformed. As in the trust engine,
 * fields the schema does not name (a writer's `title` or `locator`) pass and
 * a field needs only a colon; a repeated key, invalid dates, `weight`, or
 * anchor `kind` fail. `@cite` lines keep their strict fields.
 */
function markerNeedsAttention(marker: WikiMarker, line: string, asOf: string): boolean {
  const seen = new Set<string>()
  for (const pair of line.split(' | ').slice(1)) {
    const colon = pair.indexOf(':')
    if (colon === -1) return true
    const key = pair.slice(0, colon).trim()
    if (seen.has(key)) return true
    seen.add(key)
  }
  const date = wikiMarkerDate(marker)
  const invalidAt = marker.fields.get('invalid_at')
  const weight = marker.fields.get('weight')
  const kind = marker.kind === 'anchor' ? marker.fields.get('kind') : undefined
  return (
    date === undefined ||
    !isIsoDate(date) ||
    date > asOf ||
    (invalidAt !== undefined && (!isIsoDate(invalidAt) || invalidAt <= date)) ||
    (weight !== undefined && !WEIGHT_RE.test(weight)) ||
    (kind !== undefined && !ANCHOR_KINDS.has(kind)) ||
    (marker.kind === 'pass' && (marker.head === '' || !marker.fields.get('status')))
  )
}

/** Validate citation magic-comment metadata without inferring or changing its dates. */
export function readWikiCitationMetadata(metadata: unknown): WikiCitationDates | null {
  const parsed = citationMetadataSchema.safeParse(metadata)
  if (!parsed.success) return null
  const { valid_at: validAt, invalid_at: invalidAt } = parsed.data.citation
  return { validAt, ...(invalidAt === undefined ? {} : { invalidAt }) }
}

/** Read a same-line citation comment for non-editor consumers of Markdown source. */
export function readWikiCitationComment(comment: string): WikiCitationDates | null {
  if (/[\r\n]/.test(comment)) return null
  const json = /^<!--\s*(\{[\s\S]*\})\s*-->$/.exec(comment)?.[1]
  if (json === undefined) return null
  try {
    const parsed = z.object({ metadata: citationMetadataSchema }).safeParse(JSON.parse(json))
    return parsed.success ? readWikiCitationMetadata(parsed.data.metadata) : null
  } catch {
    return null
  }
}

/** Human-readable dates shared by inline reference tooltips and evidence disclosures. */
export function wikiCitationDescription(dates: WikiCitationDates): string {
  return `Evidence recorded ${dates.validAt}${dates.invalidAt === undefined ? '' : `; invalidated ${dates.invalidAt}`}`
}

function readCitationLine(line: string, asOf: string): WikiCitation | null {
  const match = /^\s*@cite:\s*\[\[([^\]\r\n[]+)\]\]((?:\s+\|\s+.*)?)\s*$/.exec(line)
  if (match === null) return null
  const inner = match[1] ?? ''
  const pipe = inner.indexOf('|')
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim()
  if (!isWikiCitationTarget(target)) return null
  const fields: Record<string, string> = {}
  for (const part of (match[2] ?? '').split(/\s+\|\s+/)) {
    if (part.trim() === '') continue
    const pair = /^([a-z_]+):\s*(\S+)\s*$/.exec(part.trim())
    const key = pair?.[1]
    const value = pair?.[2]
    if (key === undefined || value === undefined || key in fields) return null
    fields[key] = value
  }
  const dates = readWikiCitationMetadata({ citation: fields })
  if (dates === null) return null
  return {
    target,
    label: target,
    ...dates,
    current: dates.validAt <= asOf && (dates.invalidAt === undefined || dates.invalidAt > asOf),
  }
}

/**
 * Fold only a paragraph made entirely of valid legacy citation lines. Mixed
 * prose, incomplete metadata, and unknown fields retain their normal editor.
 */
export function readWikiCitationParagraph(text: string, asOf: string): WikiAnchorsBlock | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return null
  const citations: WikiCitation[] = []
  for (const line of lines) {
    const citation = readCitationLine(line, asOf)
    if (citation === null || citation.validAt > asOf) return null
    citations.push(citation)
  }
  return { sources: [], passes: [], citations, unparsed: [] }
}

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
 * marked not current, for the evidence history disclosure. Blank lines and `#`
 * comment lines carry nothing; unknown or malformed lines are retained for the
 * evidence disclosure.
 */
export function readWikiAnchorsBlock(text: string, asOf: string): WikiAnchorsBlock {
  const sources: WikiSource[] = []
  const passes: WikiReviewPass[] = []
  const citations: WikiCitation[] = []
  const unparsed: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const marker = parseWikiMarker(line)
    if (marker === null) {
      unparsed.push(line)
      continue
    }
    const current = wikiMarkerHolds(marker, asOf)
    const needsAttention = marker.kind !== 'cite' && markerNeedsAttention(marker, line, asOf)
    if (needsAttention) unparsed.push(line)
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
        validAt: marker.fields.get('valid_at') ?? null,
        invalidAt: marker.fields.get('invalid_at') ?? null,
      })
    } else if (marker.kind === 'pass') {
      const ref = marker.fields.get('ref')
      passes.push({
        agent: marker.head,
        status: marker.fields.get('status') ?? '',
        at: wikiMarkerDate(marker) ?? null,
        current,
        ...(ref === undefined ? {} : { ref }),
      })
    } else if (marker.kind === 'cite') {
      const citation = readCitationLine(line, asOf)
      if (citation === null) unparsed.push(line)
      else citations.push(citation)
    } else {
      if (!needsAttention) unparsed.push(line)
    }
  }
  return { sources, passes, citations, unparsed }
}
