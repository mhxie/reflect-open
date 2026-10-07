import { LEZER_NODE_IDS, parseInline } from '@meowdown/markdown'
import { renderInlineText } from '../markdown/inline-text.ts'
import { parseInlineLink } from '../markdown/link-syntax.ts'
import type { WikiAnchorsBlock } from './anchors.ts'

/** A trailing source-link list that can be presented by the adjacent evidence block. */
export interface WikiSourceLinks {
  readonly from: number
  readonly to: number
  readonly block: WikiAnchorsBlock
}

/**
 * Fold only a complete link list after a sentence, with every destination
 * matching current evidence. Unmatched links and prose remain ordinary Markdown.
 * Offsets refer to the original paragraph; labels retain author/page locators.
 */
export function readWikiSourceLinks(text: string, block: WikiAnchorsBlock): WikiSourceLinks | null {
  if (block.unparsed.length > 0) return null
  const elements = parseInline(text)
  const last = elements.at(-1)
  if (last?.type !== LEZER_NODE_IDS.Link || !/^[ \t]*[.。]?[ \t]*$/.test(text.slice(last.to))) {
    return null
  }
  let first = elements.length - 1
  while (first > 0) {
    const previous = elements[first - 1]!
    const next = elements[first]!
    if (
      previous.type !== LEZER_NODE_IDS.Link ||
      !/^[ \t;,；]+$/.test(text.slice(previous.to, next.from))
    )
      break
    first--
  }
  const prefix = text.slice(0, elements[first]!.from)
  if (!/[.!?。！？][ \t]+$/.test(prefix)) return null
  const labels = new Map<string, string[]>()
  for (const element of elements.slice(first)) {
    if (element.children.some((child) => child.type === LEZER_NODE_IDS.LinkTitle)) return null
    const link = parseInlineLink(text.slice(element.from, element.to))
    if (
      link === null ||
      link.isImage ||
      !block.sources.some((source) => source.current && source.url === link.href)
    )
      return null
    const label = renderInlineText(link.text)
    if (label === '') return null
    const existing = labels.get(link.href) ?? []
    if (!existing.includes(label)) existing.push(label)
    labels.set(link.href, existing)
  }
  return {
    from: prefix.trimEnd().length,
    to: text.length,
    block: {
      ...block,
      sources: block.sources.map((source) => {
        const label =
          source.current && source.url !== null ? labels.get(source.url)?.join('; ') : undefined
        return label === undefined ? source : { ...source, label }
      }),
    },
  }
}
