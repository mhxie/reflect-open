import { getTextblockDisplayText, isNodeOfType, markdownToDoc } from '@meowdown/core'
import { splitFrontmatter, wikiClaimHeadingText } from '@reflect/core'
import GithubSlugger from 'github-slugger'

function lookupKey(text: string): string {
  return text.normalize('NFKC').trim().replaceAll(/\s+/g, ' ').toLowerCase()
}

/** Scroll and focus the heading a text, slug, or wiki claim fragment names in a preview. */
export function revealPreviewHeading(root: HTMLElement, source: string, fragment: string): boolean {
  const target = wikiClaimHeadingText(source, fragment) ?? fragment.replace(/^#/, '')
  let decoded = target
  try {
    decoded = decodeURIComponent(target)
  } catch {
    // A literal percent sign is still a valid heading name.
  }
  const key = lookupKey(decoded)
  if (key === '') return false
  const slugger = new GithubSlugger()
  let index = -1
  let ordinal = 0
  markdownToDoc(splitFrontmatter(source).body).descendants((node) => {
    if (index !== -1) return false
    if (!isNodeOfType(node, 'heading')) return true
    const text = getTextblockDisplayText(node)
    const slug = slugger.slug(text)
    if (lookupKey(text) === key || slug === decoded.normalize('NFKC').toLowerCase()) {
      index = ordinal
    }
    ordinal += 1
    return true
  })
  const headings = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter(
    (heading) => {
      const embeddedReader = heading.closest('.md-note-embed-reader')
      return embeddedReader === null || !root.contains(embeddedReader)
    },
  )
  const heading = headings[index]
  if (heading === undefined) return false
  heading.tabIndex = -1
  heading.scrollIntoView({ block: 'start' })
  heading.focus({ preventScroll: true })
  return true
}
