import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { parseBody } from '../markdown/grammar.ts'
import { readWikiCitationComment } from './anchors.ts'
import { readWikiClaimIndex } from './article.ts'
import { wikiMarkdownStructure } from './article-syntax.ts'

/** A source edit is returned only after the exact selection survives Markdown parsing. */
export type WikiClaimEdit =
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: true
      readonly source: string
      readonly id: string
      readonly from: number
      readonly to: number
    }

interface Insertion {
  readonly at: number
  readonly text: string
}

function validUnicodeBoundary(source: string, position: number): boolean {
  const before = source.charCodeAt(position - 1)
  const after = source.charCodeAt(position)
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}

function markerInsertion(source: string, position: number, marker: string): string {
  const start = source.lastIndexOf('\n', position - 1) + 1
  return source.slice(start, position).trim() === '' ? `${marker}\n\n` : marker
}

function originalOffset(position: number, insertions: readonly Insertion[]): number {
  let shift = 0
  for (const insertion of insertions) {
    const from = insertion.at + shift
    if (position < from) break
    if (position <= from + insertion.text.length) return insertion.at
    shift += insertion.text.length
  }
  return position - shift
}

function signature(source: string, insertions: readonly Insertion[] = []): string {
  return wikiMarkdownStructure(source, (position) => originalOffset(position, insertions))
}

function splitsSyntax(source: string, from: number, to: number): boolean {
  const { body, bodyOffset } = splitFrontmatter(source)
  let invalid = false
  parseBody(body).iterate({
    enter: (cursor) => {
      const start = cursor.from + bodyOffset
      let end = cursor.to + bodyOffset
      if (cursor.name === 'Wikilink') {
        const next = cursor.node.nextSibling
        if (
          next?.name === 'Comment' &&
          next.from === cursor.to &&
          readWikiCitationComment(body.slice(next.from, next.to)) !== null
        )
          end = next.to + bodyOffset
      }
      if (
        /^(?:Link|Image|Wikilink|WikiEmbed|InlineCode|InlineMath|Escape|Entity|URL|Comment|CommentBlock|CodeInfo|CodeText|LinkReference|FencedCode|CodeBlock)$/.test(
          cursor.name,
        ) ||
        cursor.name.endsWith('Mark')
      ) {
        if ((from > start && from < end) || (to > start && to < end)) invalid = true
      }
    },
  })
  return invalid
}

function appendLedger(source: string, id: string): string {
  const { body, bodyOffset } = splitFrontmatter(source)
  const headings: { title: string; from: number }[] = []
  parseBody(body).iterate({
    enter: (node) => {
      if (!/^ATXHeading[12]$/.test(node.name)) return
      const title = body
        .slice(node.from, node.to)
        .replace(/^#{1,2}\s+/, '')
        .replace(/\s+#+\s*$/, '')
        .trim()
      headings.push({
        title: node.name === 'ATXHeading2' ? title : '',
        from: node.from + bodyOffset,
      })
    },
  })
  const owner = headings.findIndex((heading) => /^(?:Evidence|References)$/.test(heading.title))
  const evidence = owner !== -1
  const revision = evidence
    ? (headings[owner + 1]?.from ?? source.length)
    : (headings.find((heading) => heading.title === 'Revision Log')?.from ?? source.length)
  const block = `${evidence ? '' : '## Evidence\n\n'}\`\`\`anchors ${id}\n\`\`\`\n`
  const prefix = source.slice(0, revision)
  const separator = prefix.endsWith('\n\n') ? '' : prefix.endsWith('\n') ? '\n' : '\n\n'
  return `${prefix}${separator}${block}${revision === source.length ? '' : `\n${source.slice(revision)}`}`
}

/**
 * Wrap exactly the selected prose, preserving every original character and all
 * preexisting formatting. Unsupported boundaries receive a diagnostic.
 */
export function planWikiClaim(
  source: string,
  from: number,
  to: number,
  asOf: string,
): WikiClaimEdit {
  return wrapClaim(source, from, to, asOf)
}

/** Move an existing pair deliberately; its ID and evidence records remain unchanged. */
export function planWikiClaimBoundary(
  source: string,
  id: string,
  from: number,
  to: number,
  asOf: string,
): WikiClaimEdit {
  const index = readWikiClaimIndex(source, asOf)
  const claim = index.claims.find((item) => item.id === id && item.kind === 'range')
  if (claim?.open == null || claim.close === null)
    return { ok: false, message: 'Select an existing valid claim to adjust its boundaries.' }
  const markers = [claim.open, claim.close]
  const offset = (position: number): number =>
    position -
    markers.reduce(
      (removed, marker) => removed + Math.max(0, Math.min(marker.to, position) - marker.from),
      0,
    )
  let candidate = source
  for (const marker of [...markers].reverse())
    candidate = candidate.slice(0, marker.from) + candidate.slice(marker.to)
  return wrapClaim(candidate, offset(from), offset(to), asOf, id)
}

function wrapClaim(
  source: string,
  from: number,
  to: number,
  asOf: string,
  existingId?: string,
): WikiClaimEdit {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to > source.length ||
    from >= to ||
    source.slice(from, to).trim() === ''
  )
    return { ok: false, message: 'Select nonempty prose to mark as a claim.' }
  if (
    !validUnicodeBoundary(source, from) ||
    !validUnicodeBoundary(source, to) ||
    splitsSyntax(source, from, to)
  )
    return {
      ok: false,
      message: 'Claim boundaries cannot split Markdown syntax, links, code, or citation metadata.',
    }
  const index = readWikiClaimIndex(source, asOf)
  if (
    index.claims.some((claim) => from < claim.to && to > claim.from) ||
    index.markers.some((marker) => from < marker.to && to > marker.from)
  )
    return {
      ok: false,
      message:
        'This selection overlaps an existing claim. Adjust its boundaries instead of creating a second owner.',
    }
  const numbers = [
    ...index.claims.map((claim) => claim.number),
    ...index.markers.flatMap((marker) => (marker.id === null ? [] : Number(marker.id.slice(1)))),
    ...index.ledgers.flatMap((ledger) =>
      ledger.owner === null ? [] : Number(ledger.owner.slice(1)),
    ),
  ]
  const next = Math.max(0, ...numbers) + 1
  if (!Number.isSafeInteger(next))
    return { ok: false, message: 'The next claim ID exceeds the supported integer range.' }
  const id = existingId ?? `c${next}`
  const insertions: Insertion[] = [
    { at: from, text: markerInsertion(source, from, `<!-- claim:${id} -->`) },
    { at: to, text: markerInsertion(source, to, `<!-- /claim:${id} -->`) },
  ]
  let candidate = source
  for (const insertion of [...insertions].reverse())
    candidate = candidate.slice(0, insertion.at) + insertion.text + candidate.slice(insertion.at)
  if (signature(source) !== signature(candidate, insertions))
    return {
      ok: false,
      message: 'These boundaries would change Markdown formatting. Select a different boundary.',
    }
  if (existingId === undefined) candidate = appendLedger(candidate, id)
  const proposed = readWikiClaimIndex(candidate, asOf)
  const claim = proposed.claims.find((item) => item.id === id)
  if (claim === undefined)
    return {
      ok: false,
      message:
        proposed.diagnostics.find((item) => item.claimId === id)?.message ??
        'This selection cannot form a valid claim range.',
    }
  return {
    ok: true,
    source: candidate,
    id,
    from: claim.from,
    to: claim.to,
  }
}
