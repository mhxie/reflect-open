import type { SyntaxNode } from '@meowdown/markdown'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { parseBody } from '../markdown/grammar.ts'
import { unescapeMarkdownText } from '../markdown/plain-text.ts'
import { readWikiAnchorsBlock, readWikiCitationComment, type WikiAnchorsBlock } from './anchors.ts'
import { wikiClaimNumber } from './claims.ts'
import {
  isWikiBibliographyHeading,
  isWikiRevisionHeading,
  wikiClaimFormattingPreserved,
  wikiLedgerOwner,
} from './article-syntax.ts'

/** Half-open offsets into the unchanged source, in JavaScript UTF-16 and UTF-8 bytes. */
export interface WikiSourceSpan {
  readonly from: number
  readonly to: number
  readonly byteFrom: number
  readonly byteTo: number
}

/** A reserved source token; only valid paired markers may be hidden. */
export interface WikiClaimMarker extends WikiSourceSpan {
  readonly id: string | null
  readonly closing: boolean
  readonly raw: string
  readonly valid: boolean
}

/** Explicit ownership errors stay visible and never extend a neighboring claim. */
export interface WikiArticleDiagnostic extends WikiSourceSpan {
  readonly message: string
  readonly claimId: string | null
}

/** One stable claim's exact prose range, independent of paragraph boundaries. */
export interface WikiClaimRange extends WikiSourceSpan {
  readonly id: string
  readonly number: number
  readonly kind: 'range' | 'legacy'
  readonly heading: string | null
  readonly open: WikiSourceSpan | null
  readonly close: WikiSourceSpan | null
}

/** A source-backed ledger. Invalid ownership leaves the original block exposed. */
export interface WikiClaimLedger extends WikiSourceSpan {
  readonly owner: string | null
  readonly raw: string
  readonly block: WikiAnchorsBlock
  readonly valid: boolean
}

interface SourceHeading {
  readonly from: number
  readonly to: number
  readonly level: number
  readonly text: string
}

/** Parsed claim structure reused by references, summaries, editing, and navigation. */
export interface WikiClaimIndex {
  readonly source: string
  readonly claims: readonly WikiClaimRange[]
  readonly markers: readonly WikiClaimMarker[]
  readonly ledgers: readonly WikiClaimLedger[]
  readonly diagnostics: readonly WikiArticleDiagnostic[]
  readonly article: boolean
}

const MARKER = /^<!--[ \t]*(\/?)claim:(c[1-9]\d*)[ \t]*-->$/
const RESERVED_MARKER = /^<!--\s*\/?claim\s*:/

/** UTF-16 boundaries map to bytes without normalizing line endings or Unicode. */
export function wikiSourceSpan(source: string, from: number, to: number): WikiSourceSpan {
  const encoder = new TextEncoder()
  return {
    from,
    to,
    byteFrom: encoder.encode(source.slice(0, from)).length,
    byteTo: encoder.encode(source.slice(0, to)).length,
  }
}

/** Convert an interchange byte boundary; a split UTF-8 sequence is not a source position. */
export function wikiByteOffsetToSource(source: string, byteOffset: number): number | null {
  if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) return null
  let bytes = 0
  let units = 0
  const encoder = new TextEncoder()
  for (const character of source) {
    if (bytes === byteOffset) return units
    bytes += encoder.encode(character).length
    units += character.length
    if (bytes > byteOffset) return null
  }
  return bytes === byteOffset ? units : null
}

function headingText(source: string): string {
  return unescapeMarkdownText(
    source
      .split(/\r?\n/, 1)[0]!
      .replace(/^#{1,6}[ \t]*/, '')
      .replace(/[ \t]+#+[ \t]*$/, '')
      .trim(),
  )
}

function portableMarker(source: string, from: number, to: number): boolean {
  const lineStart = source.lastIndexOf('\n', from - 1) + 1
  if (source.slice(lineStart, from).trim() !== '') return true
  const following = source.slice(to)
  return (
    /^[ \t]*(?:\r?\n[ \t]*)?(?:$|\r?\n)/.test(following) &&
    (following.trim() === '' || /^[ \t]*\r?\n[ \t]*\r?\n/.test(following))
  )
}

/**
 * Whether a claim range with an endpoint inside a GFM table spans more than
 * one cell: an unescaped pipe (ignoring the alias pipe inside a wiki link) or
 * a line break between its endpoints. A range inside one cell stays valid.
 */
function crossesTableCell(
  source: string,
  from: number,
  to: number,
  tables: readonly { from: number; to: number }[],
): boolean {
  const touches = tables.some(
    (table) => (from >= table.from && from < table.to) || (to > table.from && to <= table.to),
  )
  if (!touches) return false
  return /(?<!\\)\||\n/.test(source.slice(from, to).replaceAll(/\[\[[^\]]*\]\]/g, ''))
}

function codeInfo(node: SyntaxNode, body: string): string {
  const info = node.getChild('CodeInfo')
  return info === null ? '' : body.slice(info.from, info.to).trim()
}

/**
 * Read exact Markdown comment tokens and explicit ledgers. Code examples and
 * larger comments are opaque; an invalid pair never owns any surrounding prose.
 */
export function readWikiClaimIndex(source: string, asOf: string): WikiClaimIndex {
  const { body, bodyOffset } = splitFrontmatter(source)
  const markers: WikiClaimMarker[] = []
  const ledgers: WikiClaimLedger[] = []
  const headings: SourceHeading[] = []
  const diagnostics: WikiArticleDiagnostic[] = []
  const opaque: { from: number; to: number }[] = []
  const closedLedgers = new Set<number>()
  const legacyLedgers = new Set<number>()
  const citationUnits: { from: number; to: number }[] = []
  const tables: { from: number; to: number }[] = []
  const span = (from: number, to: number): WikiSourceSpan => wikiSourceSpan(source, from, to)
  const diagnostic = (from: number, to: number, message: string, claimId: string | null): void => {
    diagnostics.push({ ...span(from, to), message, claimId })
  }
  parseBody(body).iterate({
    enter: (cursor) => {
      const node = cursor.node
      const from = cursor.from + bodyOffset
      const to = cursor.to + bodyOffset
      const raw = source.slice(from, to)
      if (cursor.name === 'Table') tables.push({ from, to })
      if (cursor.name === 'Wikilink' && /\|ref\]\]$/.test(raw)) {
        let end = cursor.to
        let next = node.nextSibling
        while (next?.name === 'Comment' && next.from === end) {
          const comment = body.slice(next.from, next.to)
          if (readWikiCitationComment(comment) !== null) {
            citationUnits.push({ from, to: next.to + bodyOffset })
            break
          }
          if (!MARKER.test(comment)) break
          end = next.to
          next = next.nextSibling
        }
      }
      if (cursor.name === 'FencedCode') {
        opaque.push({ from, to })
        const info = codeInfo(node, body)
        if (!/^anchors(?:\s|$)/.test(info)) return false
        const owner = wikiLedgerOwner(info)
        const code = node.getChild('CodeText')
        const content = code === null ? '' : body.slice(code.from, code.to)
        ledgers.push({
          ...span(from, to),
          owner,
          raw: content,
          block: readWikiAnchorsBlock(content, asOf),
          valid: false,
        })
        if (node.getChildren('CodeMark').length >= 2) closedLedgers.add(from)
        else if (owner !== null)
          diagnostic(from, to, `${owner} has an unterminated evidence fence.`, owner)
        if (info === 'anchors') legacyLedgers.add(from)
        if (info !== 'anchors' && owner === null) {
          diagnostic(
            from,
            to,
            'Evidence ownership must be anchors cN with a positive claim ID.',
            null,
          )
        }
        return false
      }
      if (cursor.name === 'CodeBlock' || cursor.name === 'InlineCode' || cursor.name === 'Escape') {
        opaque.push({ from, to })
        return false
      }
      const level = /^(?:ATX|Setext)Heading([1-6])$/.exec(cursor.name)?.[1]
      if (level !== undefined)
        headings.push({ from, to, level: Number(level), text: headingText(raw) })
      if (cursor.name !== 'Comment' && cursor.name !== 'CommentBlock') return
      opaque.push({ from, to })
      if (!RESERVED_MARKER.test(raw)) return false
      const match = MARKER.exec(raw)
      const id = match?.[2] ?? null
      let withinLink = false
      let withinHeading = false
      for (let parent = node.parent; parent !== null; parent = parent.parent) {
        if (/^(?:Link|Image|Autolink|Wikilink|WikiLink|WikiEmbed)$/.test(parent.name))
          withinLink = true
        if (/^(?:ATX|Setext)Heading/.test(parent.name)) withinHeading = true
      }
      const valid = id !== null && !withinLink && !withinHeading && portableMarker(source, from, to)
      markers.push({ ...span(from, to), id, closing: match?.[1] === '/', raw, valid })
      if (!valid) {
        diagnostic(
          from,
          to,
          id === null
            ? 'Malformed claim marker.'
            : withinLink
              ? 'Claim boundaries cannot split a link.'
              : withinHeading
                ? 'Claim boundaries belong in prose, not in headings.'
                : 'A line-leading claim marker needs a blank line before the next prose.',
          id,
        )
      }
      return false
    },
  })
  for (const match of source.matchAll(/<!--[ \t]*\/?claim[ \t]*:/g)) {
    const from = match.index
    if (from < bodyOffset || opaque.some((range) => from >= range.from && from < range.to)) continue
    const lineEnd = source.indexOf('\n', from)
    const raw = source.slice(from, lineEnd === -1 ? source.length : lineEnd)
    markers.push({
      ...span(from, from + raw.length),
      id: null,
      closing: /^<!--[ \t]*\//.test(raw),
      raw,
      valid: false,
    })
    diagnostic(from, from + raw.length, 'Unterminated or malformed claim marker.', null)
  }

  const claims: WikiClaimRange[] = []
  const invalidIds = new Set<string>()
  const ids = new Set(markers.flatMap((marker) => (marker.id === null ? [] : marker.id)))
  for (const id of ids) {
    const own = markers.filter((marker) => marker.id === id)
    const open = own.filter((marker) => !marker.closing)
    const close = own.filter((marker) => marker.closing)
    const first = open[0]
    const last = close[0]
    if (
      own.some((marker) => !marker.valid) ||
      open.length !== 1 ||
      close.length !== 1 ||
      first === undefined ||
      last === undefined ||
      first.to >= last.from ||
      source.slice(first.to, last.from).trim() === ''
    ) {
      invalidIds.add(id)
      const marker = own[0]!
      diagnostic(
        marker.from,
        own.at(-1)!.to,
        `${id} needs exactly one opening marker, one later closing marker, and nonempty text.`,
        id,
      )
      continue
    }
    if (!wikiClaimFormattingPreserved(source, [first, last])) {
      invalidIds.add(id)
      diagnostic(first.from, last.to, `${id} changes Markdown formatting at its boundaries.`, id)
      continue
    }
    if (
      citationUnits.some(
        (unit) =>
          unit.from < last.from &&
          unit.to > first.to &&
          (unit.from < first.to || unit.to > last.from),
      )
    ) {
      invalidIds.add(id)
      diagnostic(first.from, last.to, `${id} splits a citation from its date metadata.`, id)
      continue
    }
    if (crossesTableCell(source, first.to, last.from, tables)) {
      invalidIds.add(id)
      diagnostic(first.from, last.to, `${id} crosses a table cell.`, id)
      continue
    }
    claims.push({
      ...span(first.to, last.from),
      id,
      number: Number(id.slice(1)),
      kind: 'range',
      heading: null,
      open: first,
      close: last,
    })
  }
  for (let index = 0; index < claims.length; index++) {
    const claim = claims[index]!
    for (const other of claims.slice(index + 1)) {
      if (claim.from < other.to && other.from < claim.to) {
        invalidIds.add(claim.id)
        invalidIds.add(other.id)
        diagnostic(
          Math.min(claim.from, other.from),
          Math.max(claim.to, other.to),
          `${claim.id} and ${other.id} overlap; claim ranges cannot nest or cross.`,
          claim.id,
        )
      }
    }
    const administrative = headings.some((heading, headingIndex) => {
      if (!isWikiBibliographyHeading(heading.text) && !isWikiRevisionHeading(heading.text))
        return false
      const end =
        headings.slice(headingIndex + 1).find((next) => next.level <= heading.level)?.from ??
        source.length
      return heading.from < claim.to && end > claim.from
    })
    if (
      ledgers.some((ledger) => ledger.from < claim.to && ledger.to > claim.from) ||
      administrative
    ) {
      invalidIds.add(claim.id)
      diagnostic(
        claim.from,
        claim.to,
        `${claim.id} includes administrative evidence or revision records.`,
        claim.id,
      )
    }
  }

  let section = ''
  for (const [index, heading] of headings.entries()) {
    if (heading.level === 2) section = heading.text
    const number = section === 'Claims' ? wikiClaimNumber(heading.level, heading.text) : null
    if (number === null || number < 1) continue
    const id = `c${number}`
    const end = headings.slice(index + 1).find((next) => next.level <= 3)?.from ?? source.length
    if (ids.has(id) || claims.some((claim) => claim.id === id)) {
      invalidIds.add(id)
      diagnostic(
        heading.from,
        end,
        `${id} is defined more than once or mixes heading and range ownership.`,
        id,
      )
    }
    claims.push({
      ...span(heading.to, end),
      id,
      number,
      kind: 'legacy',
      heading: heading.text,
      open: span(heading.from, heading.to),
      close: null,
    })
  }
  for (const [index, claim] of claims.entries()) {
    for (const other of claims.slice(index + 1)) {
      if (claim.kind === other.kind || claim.from >= other.to || other.from >= claim.to) continue
      invalidIds.add(claim.id)
      invalidIds.add(other.id)
      diagnostic(
        Math.min(claim.from, other.from),
        Math.max(claim.to, other.to),
        `${claim.id} and ${other.id} mix overlapping range and heading ownership.`,
        claim.id,
      )
    }
  }

  const resolvedLedgers = ledgers.map((ledger): WikiClaimLedger => {
    if (ledger.owner === null) {
      if (!legacyLedgers.has(ledger.from)) return ledger
      const legacy = claims.find(
        (claim) =>
          claim.kind === 'legacy' &&
          !invalidIds.has(claim.id) &&
          ledger.from >= claim.from &&
          ledger.to <= claim.to,
      )
      return legacy === undefined ? ledger : { ...ledger, owner: legacy.id, valid: true }
    }
    const own = ledgers.filter((other) => other.owner === ledger.owner)
    const claim = claims.find(
      (candidate) => candidate.id === ledger.owner && !invalidIds.has(candidate.id),
    )
    const section = headings.findLast(
      (heading) => heading.level <= 2 && heading.from < ledger.from,
    )?.text
    const inEvidence = section === 'Evidence' || section === 'References'
    if (
      own.length !== 1 ||
      claim === undefined ||
      claim.kind !== 'range' ||
      !closedLedgers.has(ledger.from) ||
      !inEvidence
    ) {
      if (closedLedgers.has(ledger.from))
        diagnostic(
          ledger.from,
          ledger.to,
          own.length !== 1
            ? `${ledger.owner} has duplicate evidence ledgers.`
            : !inEvidence
              ? `${ledger.owner} evidence belongs under References or Evidence.`
              : `${ledger.owner} has no valid matching range.`,
          ledger.owner,
        )
      return ledger
    }
    return { ...ledger, valid: true }
  })
  return {
    source,
    claims: claims
      .filter((claim) => !invalidIds.has(claim.id))
      .sort((left, right) => left.from - right.from),
    markers: markers.map((marker) => ({
      ...marker,
      valid: marker.valid && marker.id !== null && !invalidIds.has(marker.id),
    })),
    ledgers: resolvedLedgers,
    diagnostics,
    article: markers.length > 0 || ledgers.some((ledger) => ledger.owner !== null),
  }
}

/** Decode a stable claim fragment, independently from ordinary heading lookup. */
export function wikiClaimId(fragment: string): string | null {
  let decoded = fragment.replace(/^#/, '')
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    /* A literal percent is not a claim ID. */
  }
  return /^\^c[1-9]\d*$/i.test(decoded) ? decoded.slice(1).toLowerCase() : null
}

/** Exact stable target; callers must not fall back to the whole note when this is absent. */
export function findWikiClaim(index: WikiClaimIndex, fragment: string): WikiClaimRange | null {
  const id = wikiClaimId(fragment)
  return id === null ? null : (index.claims.find((claim) => claim.id === id) ?? null)
}
