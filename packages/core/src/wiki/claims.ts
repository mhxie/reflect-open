import { parseNote } from '../markdown/extract.ts'

const CLAIM_TEXT_RE = /^\[C(\d+)\]/
const CLAIM_FRAGMENT_RE = /^\^c(\d+)$/i

/**
 * The number of the claim a heading opens, or null: the atelier schema writes
 * each claim as a level-3 heading led by its bracketed number, `### [C3] …`.
 */
export function wikiClaimNumber(level: number, text: string): number | null {
  const digits = level === 3 ? CLAIM_TEXT_RE.exec(text)?.[1] : undefined
  return digits === undefined ? null : Number(digits)
}

/** A link fragment without its `#`, percent-decoded when it is a valid escape. */
function decodeFragment(fragment: string): string {
  const source = fragment.startsWith('#') ? fragment.slice(1) : fragment
  try {
    return decodeURIComponent(source).trim()
  } catch {
    return source.trim()
  }
}

/**
 * The heading a wiki claim link's fragment names in `source` — `^c3`
 * (`[[Entry#^c3]]`) names the `### [C3] …` heading — as its text, or null for
 * any other fragment and when the entry has no such claim.
 */
export function wikiClaimHeadingText(source: string, fragment: string): string | null {
  const digits = CLAIM_FRAGMENT_RE.exec(decodeFragment(fragment))?.[1]
  if (digits === undefined) {
    return null
  }
  const number = Number(digits)
  const heading = parseNote({ path: '', source }).headings.find(
    (candidate) => wikiClaimNumber(candidate.level, candidate.text) === number,
  )
  return heading?.text ?? null
}
