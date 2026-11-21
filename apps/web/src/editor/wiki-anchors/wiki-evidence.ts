import { isNodeOfType } from '@meowdown/core'
import type { Node as ProseMirrorNode } from '@prosekit/pm/model'
import {
  readWikiAnchorsBlock,
  readWikiCitationParagraph,
  readWikiSourceLinks,
  wikiCitationDescription,
  type WikiAnchorsBlock,
  type WikiCitation,
  type WikiSourceLinks,
} from '@reflect/core'

/** Read evidence from the source node without replacing or re-parsing the document. */
export function readWikiEvidenceNode(node: ProseMirrorNode, asOf: string): WikiAnchorsBlock | null {
  if (isNodeOfType(node, 'codeBlock') && node.attrs['language'] === 'anchors') {
    return readWikiAnchorsBlock(node.textContent, asOf)
  }
  return isNodeOfType(node, 'paragraph') ? readWikiCitationParagraph(node.textContent, asOf) : null
}

/** Match a prose paragraph only to the evidence block immediately following it. */
export function readWikiSourceLinkPair(
  paragraph: ProseMirrorNode | null | undefined,
  evidence: ProseMirrorNode | null | undefined,
  asOf: string,
): WikiSourceLinks | null {
  if (
    paragraph == null ||
    evidence == null ||
    !isNodeOfType(paragraph, 'paragraph') ||
    paragraph.content.size !== paragraph.textContent.length
  )
    return null
  const block = readWikiEvidenceNode(evidence, asOf)
  return block === null ? null : readWikiSourceLinks(paragraph.textContent, block)
}

export interface WikiEvidenceOptions {
  readonly interactive: boolean
  readonly openUrl?: (url: string, event: MouseEvent) => void
  readonly openWikiLink?: (options: {
    target: string
    openInNewWindow: boolean
    peek?: boolean
  }) => void
  readonly edit?: () => void
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

function reference(label: string, description: string): HTMLSpanElement {
  const node = element('span', 'meowdown-reference')
  node.setAttribute('aria-label', label)
  node.setAttribute('aria-description', description)
  node.title = `${label}\n${description}`
  node.append(element('span', 'sr-only', label))
  return node
}

function externalLink(
  url: string | null,
  label: string,
  options: WikiEvidenceOptions,
  child?: HTMLElement,
): HTMLElement {
  if (url === null || !options.interactive) return child ?? element('span', '', label)
  const link = element(
    'a',
    'rounded text-text-secondary hover:text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
  )
  link.href = url
  link.setAttribute('aria-label', label)
  if (child !== undefined) {
    link.title = child.title
    link.setAttribute('aria-description', child.getAttribute('aria-description') ?? '')
  }
  link.append(child ?? label)
  link.addEventListener('click', (event) => {
    if (options.openUrl !== undefined) {
      event.preventDefault()
      options.openUrl(url, event)
    }
  })
  return link
}

function citationLink(
  citation: WikiCitation,
  options: WikiEvidenceOptions,
  numbered: boolean,
): HTMLElement {
  const description = wikiCitationDescription(citation)
  const label = citation.label
  const child = numbered ? reference(label, description) : element('span', '', label)
  if (!options.interactive || options.openWikiLink === undefined) return child
  const link = element(
    'button',
    'rounded text-text-secondary hover:text-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
  )
  link.type = 'button'
  link.dataset.wikiTarget = citation.target
  link.setAttribute('aria-label', `Open ${label}`)
  link.setAttribute('aria-description', description)
  link.title = `${label}\n${description}`
  link.append(child)
  link.addEventListener('click', (event) => {
    event.preventDefault()
    options.openWikiLink?.({
      target: citation.target,
      openInNewWindow: event.metaKey || event.ctrlKey,
      ...(event.altKey ? { peek: true } : {}),
    })
  })
  return link
}

/**
 * One evidence presentation shared by editor widgets and read-only previews.
 * Native details preserves keyboard disclosure without an overlay or a write.
 */
export function createWikiEvidence(
  block: WikiAnchorsBlock,
  raw: string,
  options: WikiEvidenceOptions,
): HTMLElement {
  const root = element('div', 'my-1 font-sans text-[12px] leading-5 text-text-secondary')
  root.contentEditable = 'false'
  root.dataset.wikiAnchors = ''
  const row = element('div', 'wiki-evidence-row flex flex-wrap items-baseline gap-1.5')
  root.append(row)
  for (const source of block.sources) {
    if (!source.current) continue
    const description = `${source.validAt === null ? 'Evidence date missing' : `Evidence recorded ${source.validAt}`}${source.invalidAt === null ? '' : `; invalidated ${source.invalidAt}`}`
    row.append(
      externalLink(source.url, source.label, options, reference(source.label, description)),
    )
  }
  for (const citation of block.citations) {
    if (citation.current) row.append(citationLink(citation, options, true))
  }
  const flagged = block.passes.some((pass) => pass.status === 'flagged' && pass.current)
  if (flagged) row.append(element('span', 'text-amber-700 dark:text-amber-300', 'Flagged review'))
  if (block.unparsed.length > 0) {
    row.append(element('span', 'text-amber-700 dark:text-amber-300', 'Check evidence'))
  }
  if (
    !block.sources.some((source) => source.current) &&
    !block.citations.some((citation) => citation.current) &&
    !flagged &&
    block.unparsed.length === 0
  ) {
    row.append(
      element(
        'span',
        'text-text-muted',
        block.sources.length + block.citations.length > 0
          ? 'No current sources'
          : block.passes.length > 0
            ? 'Review recorded'
            : 'No sources',
      ),
    )
  }
  if (!options.interactive) return root

  const details = element('details', 'wiki-evidence-details')
  const summary = element('summary', 'cursor-pointer text-text-muted hover:text-text', 'Details')
  summary.setAttribute('aria-label', 'Evidence details')
  details.append(summary)
  row.append(details)
  const body = element('div', 'space-y-1 border-l border-border pl-3 text-text-secondary')
  details.append(body)
  for (const source of block.sources) {
    const line = element('div', '')
    line.append(externalLink(source.url, source.label, options))
    line.append(` · Evidence recorded ${source.validAt ?? 'unknown'}`)
    if (source.invalidAt !== null) line.append(` · Invalidated ${source.invalidAt}`)
    if (!source.current) line.append(' · Inactive')
    if (source.readwiseUrl !== null) {
      line.append(' · ', externalLink(source.readwiseUrl, 'Readwise', options))
    }
    body.append(line)
  }
  for (const citation of block.citations) {
    const line = element('div', '')
    line.append(citationLink(citation, options, false), ` · ${wikiCitationDescription(citation)}`)
    if (!citation.current) line.append(' · Inactive')
    body.append(line)
  }
  for (const pass of block.passes) {
    body.append(
      element(
        'div',
        pass.status === 'flagged' && pass.current ? 'text-amber-700 dark:text-amber-300' : '',
        `${pass.agent}: ${pass.status || 'review'}${pass.at === null ? '' : ` · ${pass.at}`}${pass.current ? '' : ' · Inactive'}${pass.ref === undefined ? '' : ` · ${pass.ref}`}`,
      ),
    )
  }
  if (block.unparsed.length > 0) {
    body.append(
      element(
        'div',
        'text-amber-700 dark:text-amber-300',
        'Some evidence could not be interpreted.',
      ),
    )
    body.append(
      element(
        'pre',
        'whitespace-pre-wrap break-words font-mono text-[11px]',
        block.unparsed.join('\n'),
      ),
    )
  }
  const source = element('details', '')
  source.append(element('summary', 'cursor-pointer text-text-muted', 'Source Markdown'))
  source.append(element('pre', 'whitespace-pre-wrap break-words font-mono text-[11px]', raw))
  body.append(source)
  if (options.edit !== undefined) {
    const edit = element(
      'button',
      'rounded px-1 text-text-muted hover:bg-surface-hover hover:text-text',
      'Edit metadata',
    )
    edit.type = 'button'
    edit.addEventListener('click', (event) => {
      event.preventDefault()
      options.edit?.()
    })
    body.append(edit)
  }
  return root
}
