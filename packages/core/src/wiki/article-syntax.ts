import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { parseBody } from '../markdown/grammar.ts'

const LEDGER_OWNER = /^anchors (c[1-9]\d*)$/
const BIBLIOGRAPHY_HEADING = /^(?:Evidence|References)$/i
const REVISION_HEADING = /^Revision Log$/i

/**
 * The claim a fenced block's info string assigns its evidence ledger to:
 * `anchors c3` → `c3`; null for any other fence.
 */
export function wikiLedgerOwner(info: string): string | null {
  return LEDGER_OWNER.exec(info)?.[1] ?? null
}

/** Whether an H2's text opens the article's bibliography (`Evidence` or `References`). */
export function isWikiBibliographyHeading(text: string): boolean {
  return BIBLIOGRAPHY_HEADING.test(text.trim())
}

/** Whether an H2's text opens the article's `Revision Log`. */
export function isWikiRevisionHeading(text: string): boolean {
  return REVISION_HEADING.test(text.trim())
}

/** The ledger line recording that an editor has yet to review a claim as of `asOf`. */
export function wikiPendingPass(asOf: string): string {
  return `@pass: editor | status: pending | at: ${asOf}`
}

/** Markdown syntax nodes with comment tokens omitted, in source coordinates. */
function wikiMarkdownNodes(source: string): [string, number, number][] {
  const { body, bodyOffset } = splitFrontmatter(source)
  const nodes: [string, number, number][] = []
  parseBody(body).iterate({
    enter: (node) => {
      if (node.name === 'Comment' || node.name === 'CommentBlock') return false
      if (node.name !== 'Document')
        nodes.push([node.name, node.from + bodyOffset, node.to + bodyOffset])
    },
  })
  return nodes
}

function projectedStructure(
  nodes: readonly [string, number, number][],
  project: (position: number) => number,
): string {
  return JSON.stringify(nodes.map(([name, from, to]) => [name, project(from), project(to)]))
}

/** Markdown structure with comment tokens omitted, projected into one source coordinate space. */
export function wikiMarkdownStructure(
  source: string,
  project: (position: number) => number = (position) => position,
): string {
  return projectedStructure(wikiMarkdownNodes(source), project)
}

/**
 * Whether removing a set of markers from `source` leaves the prose's
 * formatting and block structure intact, for any number of sets: the marked
 * source is parsed once, each set's unmarked text once.
 */
export function wikiClaimFormattingCheck(
  source: string,
): (markers: readonly { from: number; to: number }[]) => boolean {
  const marked = wikiMarkdownNodes(source)
  return (markers) => {
    const ordered = [...markers].sort((left, right) => left.from - right.from)
    let unmarked = source
    for (const marker of [...ordered].reverse())
      unmarked = unmarked.slice(0, marker.from) + unmarked.slice(marker.to)
    const project = (position: number): number =>
      position -
      ordered.reduce(
        (removed, marker) => removed + Math.max(0, Math.min(position, marker.to) - marker.from),
        0,
      )
    return projectedStructure(marked, project) === wikiMarkdownStructure(unmarked)
  }
}
