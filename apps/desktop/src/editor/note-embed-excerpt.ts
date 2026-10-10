import GithubSlugger from 'github-slugger'

/** Characters of source Markdown a collapsed note embed renders. */
export const NOTE_EMBED_PREVIEW_CHARS = 4096

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t#]*$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

function lookupKey(text: string): string {
  return text.normalize('NFKC').trim().replaceAll(/\s+/g, ' ').toLowerCase()
}

/**
 * Whether a heading's display text is the one a `#fragment` names, by text or GitHub slug;
 * null for no fragment or a claim fragment. Call it on headings in document order.
 */
export function headingMatcher(fragment: string | null): ((text: string) => boolean) | null {
  if (fragment === null || fragment.startsWith('^')) return null
  let wanted = fragment.replace(/^#/, '')
  try {
    wanted = decodeURIComponent(wanted)
  } catch {
    // A literal percent sign is still a valid heading name.
  }
  const key = lookupKey(wanted)
  if (key === '') return null
  const slug = wanted.normalize('NFKC').toLowerCase()
  const slugger = new GithubSlugger()
  return (text) => slugger.slug(text) === slug || lookupKey(text) === key
}

/**
 * The Markdown a collapsed `![[Note#Heading]]` previews: the note's H1, then the named
 * section through its last subsection. A missing fragment, a claim fragment, or a heading
 * that is not found previews the start of the body, as an unfragmented embed does.
 */
export function noteEmbedExcerpt(body: string, fragment: string | null): string {
  const whole = body.slice(0, NOTE_EMBED_PREVIEW_CHARS)
  const matches = headingMatcher(fragment)
  if (matches === null) return whole
  const lines = body.split('\n')
  let fence: string | null = null
  let title: string | null = null
  let start = -1
  let level = 0
  let end = lines.length
  for (const [index, line] of lines.entries()) {
    const marker = FENCE.exec(line)?.[1]
    if (
      marker !== undefined &&
      (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))
    ) {
      fence = fence === null ? marker : null
      continue
    }
    const heading = fence === null ? HEADING.exec(line) : null
    if (heading === null) continue
    const depth = heading[1]!.length
    const text = heading[2]!
    if (start !== -1) {
      if (depth <= level) {
        end = index
        break
      }
      continue
    }
    if (depth === 1 && title === null) title = line
    if (matches(text)) {
      start = index
      level = depth
    }
  }
  if (start === -1) return whole
  const section = lines.slice(start, end).join('\n').trimEnd()
  const head = title !== null && title !== lines[start] ? `${title}\n\n` : ''
  return (head + section).slice(0, NOTE_EMBED_PREVIEW_CHARS)
}
