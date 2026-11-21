import type { ReactElement } from 'react'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'

interface WikiArticleDefinitionsProps {
  readonly source: string
  readonly options: WikiEvidenceOptions
}

/** The portable definition table remains available for deliberate source editing. */
export function WikiArticleDefinitions({
  source,
  options,
}: WikiArticleDefinitionsProps): ReactElement | null {
  if (!options.interactive) return null
  return (
    <details className="wiki-article-ledger" contentEditable={false}>
      <summary>Reference definitions</summary>
      <pre className="whitespace-pre-wrap break-words text-2xs">{source}</pre>
      {options.edit === undefined ? null : (
        <button
          type="button"
          className="text-xs text-text-muted hover:underline"
          onClick={options.edit}
        >
          Edit source
        </button>
      )}
    </details>
  )
}
