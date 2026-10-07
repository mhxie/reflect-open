import { useLayoutEffect, useRef, type ReactElement } from 'react'
import type { WikiAnchorsBlock } from '@reflect/core'
import { createWikiEvidence, type WikiEvidenceOptions } from './wiki-evidence.ts'

interface WikiEvidencePreviewProps {
  readonly block: WikiAnchorsBlock
  readonly raw: string
  readonly options: WikiEvidenceOptions
}

/** Mount the same evidence disclosure used by the live editor, without an edit action. */
export function WikiEvidencePreview({
  block,
  raw,
  options,
}: WikiEvidencePreviewProps): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = root.current
    if (container === null) return
    container.replaceChildren(createWikiEvidence(block, raw, options))
    return () => container.replaceChildren()
  }, [block, raw, options])
  return <div ref={root} />
}
