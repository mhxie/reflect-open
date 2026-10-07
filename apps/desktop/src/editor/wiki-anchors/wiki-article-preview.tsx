import { cloneElement, Fragment, isValidElement, type ReactNode } from 'react'
import type { MarkdownBlockRenderContext } from '@meowdown/react'
import { findWikiClaim, type WikiClaimRange, type WikiReferenceGroup } from '@reflect/core'
import { WikiArticleEvidence } from './wiki-article-evidence.tsx'
import { WikiArticleBibliography } from './wiki-article-bibliography.tsx'
import { WikiArticleRevision } from './wiki-article-revision.tsx'
import { WikiArticleDefinitions } from './wiki-article-definitions.tsx'
import { wikiRevisionSection } from './wiki-revision-section.ts'
import { WikiReferenceGroupView } from './wiki-reference-group.tsx'
import { wikiEditorRange, type WikiArticleProjection } from './wiki-article-projection.ts'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'

interface Overlay {
  readonly from: number
  readonly to: number
  readonly group?: WikiReferenceGroup
}

interface ClaimSegment {
  readonly from: number
  readonly to: number
  readonly claim: WikiClaimRange
}

function renderedInline(
  context: MarkdownBlockRenderContext,
  projection: WikiArticleProjection,
  options: WikiEvidenceOptions,
  showRanges: boolean,
  clip?: { from: number; to: number },
): ReactNode | undefined {
  const { node, position, renderDefault, renderInlineRange } = context
  if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return
  if (node.content.size !== node.textContent.length) return clip === undefined ? undefined : null
  const start = position + 1
  const end = start + node.content.size
  const { index, map } = projection
  const overlays: Overlay[] = []
  const claims: ClaimSegment[] = []
  for (const marker of index.markers) {
    if (!marker.valid) continue
    const range = wikiEditorRange(map, marker)
    if (range !== null && range.from >= start && range.to <= end)
      overlays.push({ from: range.from - start, to: range.to - start })
  }
  for (const group of index.groups) {
    const range = wikiEditorRange(map, group)
    if (range !== null && range.from >= start && range.to <= end)
      overlays.push({ from: range.from - start, to: range.to - start, group })
  }
  for (const claim of index.claims) {
    if (claim.kind !== 'range') continue
    const range = wikiEditorRange(map, claim)
    if (range === null || range.from >= end || range.to <= start) continue
    claims.push({
      from: Math.max(start, range.from) - start,
      to: Math.min(end, range.to) - start,
      claim,
    })
  }
  if (overlays.length === 0 && claims.length === 0 && clip === undefined) return
  const clipFrom = clip === undefined ? 0 : Math.max(0, clip.from - start)
  const clipTo =
    clip === undefined ? node.content.size : Math.min(node.content.size, clip.to - start)
  const boundaries = [
    ...new Set([
      0,
      node.content.size,
      clipFrom,
      clipTo,
      ...overlays.flatMap((overlay) => [overlay.from, overlay.to]),
      ...claims.flatMap((claim) => [claim.from, claim.to]),
    ]),
  ].sort((left, right) => left - right)
  const children: ReactNode[] = []
  for (let offset = 0; offset < boundaries.length - 1; offset++) {
    const from = boundaries[offset]!
    const to = boundaries[offset + 1]!
    if (from === to || from < clipFrom || to > clipTo) continue
    const overlay = overlays.find((candidate) => from >= candidate.from && from < candidate.to)
    if (overlay !== undefined && (overlay.group === undefined || from !== overlay.from)) continue
    const child =
      overlay?.group === undefined ? (
        renderInlineRange(from, to)
      ) : (
        <WikiReferenceGroupView group={overlay.group} index={index} options={options} />
      )
    const claim = claims.find((candidate) => from >= candidate.from && from < candidate.to)
    children.push(
      claim === undefined ? (
        <Fragment key={from}>{child}</Fragment>
      ) : (
        <span
          key={from}
          data-wiki-claim={claim.claim.id}
          {...(showRanges ? { 'data-wiki-claim-visible': '' } : {})}
        >
          {showRanges && from === claim.from ? (
            <span className="wiki-claim-label">{claim.claim.id.toUpperCase()}</span>
          ) : null}
          {child}
        </span>
      ),
    )
  }
  const wrapper = renderDefault()
  // Preserve the default paragraph/heading wrapper, including heading demotion.
  // eslint-disable-next-line @eslint-react/no-clone-element
  return isValidElement(wrapper) ? cloneElement(wrapper, undefined, children) : children
}

/** Project exact source ranges inside the default block layout. */
export function renderWikiArticleBlock(
  context: MarkdownBlockRenderContext,
  projection: WikiArticleProjection,
  options: WikiEvidenceOptions,
  showRanges = false,
  claimFragment?: string,
): ReactNode | undefined {
  const { node, doc, position, renderDefault } = context
  const { index } = projection
  if (claimFragment !== undefined) {
    const claim = findWikiClaim(index, claimFragment)
    const range = claim === null ? null : wikiEditorRange(projection.map, claim)
    if (range === null || position + node.nodeSize <= range.from || position >= range.to)
      return null
    return renderedInline(context, projection, options, showRanges, range)
  }
  if (!index.article) return
  const definition = index.definitions.find(
    (span) => wikiEditorRange(projection.map, span)?.from === position + 1,
  )
  if (definition !== undefined)
    return definition === index.definitions[0] ? (
      <WikiArticleDefinitions
        source={index.definitions.map((span) => index.source.slice(span.from, span.to)).join('\n')}
        options={options}
      />
    ) : null
  const revision = wikiRevisionSection(doc)
  if (revision !== null && position >= revision.from && position < revision.to)
    return position === revision.from ? (
      <WikiArticleRevision markdown={revision.markdown} options={options} />
    ) : null
  const owner =
    node.type.name === 'codeBlock'
      ? /^anchors (c[1-9]\d*)$/.exec(String(node.attrs['language']))?.[1]
      : undefined
  const ledger =
    owner === undefined
      ? undefined
      : index.ledgers.find((item) => item.valid && item.owner === owner)
  let rendered =
    ledger === undefined ? (
      renderedInline(context, projection, options, showRanges)
    ) : (
      <WikiArticleEvidence ledger={ledger} options={options} />
    )
  let bibliographyAt: number | null = null
  doc.descendants((candidate, candidatePosition) => {
    if (bibliographyAt !== null) return false
    if (
      candidate.type.name === 'heading' &&
      candidate.attrs['level'] === 2 &&
      /^(?:Evidence|References)$/.test(candidate.textContent)
    )
      bibliographyAt = candidatePosition
    return true
  })
  if (bibliographyAt === null) {
    doc.descendants((candidate, candidatePosition) => {
      if (bibliographyAt !== null) return false
      const id =
        candidate.type.name === 'codeBlock'
          ? /^anchors (c[1-9]\d*)$/.exec(String(candidate.attrs['language']))?.[1]
          : undefined
      if (id !== undefined && index.ledgers.some((item) => item.valid && item.owner === id))
        bibliographyAt = candidatePosition
      return true
    })
  }
  if (index.article && position === bibliographyAt && index.bibliography.length > 0)
    rendered = (
      <>
        {rendered ?? renderDefault()}
        <WikiArticleBibliography index={index} options={options} />
      </>
    )
  if (position === 0 && index.diagnostics.length > 0)
    rendered = (
      <>
        <details className="wiki-article-diagnostics" open>
          <summary>Claim ownership needs attention</summary>
          <ul>
            {index.diagnostics.map((diagnostic, ordinal) => (
              <li key={ordinal}>{diagnostic.message}</li>
            ))}
          </ul>
        </details>
        {rendered ?? renderDefault()}
      </>
    )
  return rendered
}
