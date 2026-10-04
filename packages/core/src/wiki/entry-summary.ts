import { isIsoDate } from '@reflect/utils'
import { previewSnippet } from '../indexing/snippet.ts'
import { parseNote } from '../markdown/extract.ts'
import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { unescapeMarkdownText } from '../markdown/plain-text.ts'
import {
  parseWikiMarker,
  wikiMarkerDate,
  wikiAnchorNamesSource,
  wikiMarkerHolds,
  wikiSourceKey,
  type WikiMarker,
} from './anchors.ts'
import { wikiClaimNumber } from './claims.ts'

/**
 * What a wiki entry's markdown says about its claims and their evidence, read
 * the way the atelier wiki schema writes them. Only markers that hold on the
 * summary's day count (see `wikiMarkerHolds`), the trust engine's rule.
 */
export interface WikiEntrySummary {
  /**
   * The entry's first paragraph of prose as plain text, capped like an All
   * Notes snippet — past the title and the `>` quotes under it (a primer, a
   * translation's note on its source), headings, lists, and fenced blocks.
   * Null when the entry has none.
   */
  readonly preview: string | null
  /** Numbered claims under `## Claims`. */
  readonly claims: number
  /** Claims with no `@anchor` — Wikipedia's "citation needed". */
  readonly unsourcedClaims: number
  /** Distinct external sources (`@anchor` type and id) across all claims. */
  readonly sources: number
  /** Claims whose latest reviewer pass verified them. */
  readonly verifiedClaims: number
  /** Claims whose latest reviewer pass flagged them. */
  readonly flaggedClaims: number
  /** The newest date leading a `## Revision Log` item, or null. */
  readonly lastRevised: string | null
}

/**
 * Where an entry stands with its reviewer: any flagged claim outranks the
 * rest, then every claim verified, then some.
 */
export type WikiReviewState = 'flagged' | 'verified' | 'partial' | 'unreviewed'

/** The reviewer standing of a summarized entry. */
export function wikiReviewState(summary: WikiEntrySummary): WikiReviewState {
  if (summary.flaggedClaims > 0) {
    return 'flagged'
  }
  if (summary.claims > 0 && summary.verifiedClaims === summary.claims) {
    return 'verified'
  }
  return summary.verifiedClaims > 0 ? 'partial' : 'unreviewed'
}

const SECTION_HEADING_RE = /^##\s+(.*?)(?:\s+#+)?\s*$/
const HEADING_LINE_RE = /^(#{1,6})\s+(.*)$/
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/
const REVISION_DATE_RE = /^-\s+\**(\d{4}-\d{2}-\d{2})/
// Lines that open a block other than a paragraph: a heading, quote, list
// item, table row, thematic break, or HTML. A fence is matched on its own.
const NON_PARAGRAPH_RE = [
  /^ {0,3}#{1,6}(?:\s|$)/,
  /^ {0,3}>/,
  /^\s*(?:[-*+]|\d+[.)])(?:\s|$)/,
  /^\s*\|/,
  /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/,
  /^ {0,3}</,
]

interface Fence {
  readonly char: string
  readonly length: number
  readonly anchors: boolean
}

interface ReviewerPass {
  readonly at: string
  readonly status: string
}

function opensFence(line: string): Fence | null {
  const match = FENCE_OPEN_RE.exec(line)
  const marker = match?.[1]
  if (match === null || marker === undefined) {
    return null
  }
  const info = (match[2] ?? '').trim().split(/\s+/)[0] ?? ''
  return { char: marker.charAt(0), length: marker.length, anchors: info === 'anchors' }
}

function closesFence(line: string, fence: Fence): boolean {
  const marker = FENCE_CLOSE_RE.exec(line)?.[1]
  return marker !== undefined && marker.charAt(0) === fence.char && marker.length >= fence.length
}

/** Whether `line` (outside a fence) belongs to a paragraph of prose. */
function isProseLine(line: string): boolean {
  return (
    line.trim() !== '' &&
    opensFence(line) === null &&
    parseWikiMarker(line) === null &&
    !NON_PARAGRAPH_RE.some((pattern) => pattern.test(line))
  )
}

/**
 * Summarize a wiki entry's markdown as it stands on `asOf` (ISO
 * `YYYY-MM-DD`). Pure: the caller reads the file.
 */
export function summarizeWikiEntry(source: string, asOf: string): WikiEntrySummary {
  const lines = splitFrontmatter(source).body.split(/\r?\n/)

  let section: string | null = null
  let fence: Fence | null = null
  const previewLines: string[] = []
  let previewRead = false

  let claims = 0
  let unsourcedClaims = 0
  let verifiedClaims = 0
  let flaggedClaims = 0
  let lastRevised: string | null = null
  const sources = new Set<string>()

  // The open claim: its anchor count and latest reviewer pass.
  let claimAnchors: number | null = null
  let claimReview: ReviewerPass | null = null

  const closeClaim = (): void => {
    if (claimAnchors === null) {
      return
    }
    if (claimAnchors === 0) {
      unsourcedClaims += 1
    }
    if (claimReview?.status === 'verified') {
      verifiedClaims += 1
    } else if (claimReview?.status === 'flagged') {
      flaggedClaims += 1
    }
    claimAnchors = null
    claimReview = null
  }

  const applyMarker = (marker: WikiMarker): void => {
    if (claimAnchors === null || !wikiMarkerHolds(marker, asOf)) {
      return
    }
    switch (marker.kind) {
      case 'anchor':
        // A placeholder (`@anchor: doi:`) names no evidence.
        if (wikiAnchorNamesSource(marker.head)) {
          claimAnchors += 1
          sources.add(wikiSourceKey(marker.head))
        }
        return
      case 'pass': {
        const at = wikiMarkerDate(marker)
        const status = marker.fields.get('status')
        // Same-day passes keep file order: the later line is the newer verdict.
        if (marker.head === 'reviewer' && at !== undefined && status !== undefined) {
          if (claimReview === null || at >= claimReview.at) {
            claimReview = { at, status }
          }
        }
        return
      }
      case 'cite':
        return
    }
  }

  for (const line of lines) {
    if (fence !== null) {
      if (closesFence(line, fence)) {
        fence = null
      } else if (fence.anchors && section === 'Claims') {
        const marker = parseWikiMarker(line)
        if (marker !== null) {
          applyMarker(marker)
        }
      }
      continue
    }

    if (!previewRead) {
      if (isProseLine(line)) {
        previewLines.push(line)
      } else if (previewLines.length > 0) {
        previewRead = true
      }
    }

    const opened = opensFence(line)
    if (opened !== null) {
      fence = opened
      continue
    }

    const sectionHeading = SECTION_HEADING_RE.exec(line)
    if (sectionHeading !== null) {
      closeClaim()
      section = sectionHeading[1] ?? null
      continue
    }

    if (section === 'Claims') {
      const heading = HEADING_LINE_RE.exec(line)
      const level = heading?.[1]?.length ?? 0
      // `### \[C1\] …` reads as `[C1] …`, as the heading's text does.
      if (wikiClaimNumber(level, unescapeMarkdownText(heading?.[2] ?? '')) !== null) {
        closeClaim()
        claims += 1
        claimAnchors = 0
      }
    } else if (section === 'Revision Log') {
      const date = REVISION_DATE_RE.exec(line)?.[1]
      // A date that names no calendar day (`2026-13-01`) is not a revision.
      if (date !== undefined && isIsoDate(date) && (lastRevised === null || date > lastRevised)) {
        lastRevised = date
      }
    }
  }
  closeClaim()

  const preview =
    previewLines.length === 0
      ? ''
      : previewSnippet(parseNote({ path: '', source: previewLines.join('\n') }).displayText, '')
  return {
    preview: preview === '' ? null : preview,
    claims,
    unsourcedClaims,
    sources: sources.size,
    verifiedClaims,
    flaggedClaims,
    lastRevised,
  }
}
