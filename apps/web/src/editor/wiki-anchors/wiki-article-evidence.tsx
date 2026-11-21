import type { ReactElement } from 'react'
import type { WikiClaimLedger } from '@reflect/core'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'
import { wikiClaimPending } from './wiki-article-pending.ts'

interface WikiArticleEvidenceProps {
  readonly ledger: WikiClaimLedger
  readonly options: WikiEvidenceOptions
}

/** Source-backed administrative records stay available below the article. */
export function WikiArticleEvidence({ ledger, options }: WikiArticleEvidenceProps): ReactElement {
  const label = `Evidence${ledger.owner === null ? '' : ` · ${ledger.owner.toUpperCase()}`}${wikiClaimPending(ledger) ? ' · Text changed; review pending' : ''}`
  if (!options.interactive)
    return <span className="wiki-article-ledger text-text-muted">{label}</span>
  return (
    <details
      className="wiki-article-ledger"
      contentEditable={false}
      data-wiki-article-ledger={ledger.owner ?? ''}
    >
      <summary>{label}</summary>
      {ledger.block.unparsed.length > 0 ? (
        <p className="text-text-muted">Some records need attention.</p>
      ) : null}
      <pre className="whitespace-pre-wrap break-words text-2xs">
        {ledger.raw || 'No evidence records.'}
      </pre>
      {options.edit === undefined ? null : (
        <button
          type="button"
          onClick={options.edit}
          className="text-xs text-text-muted underline-offset-2 hover:underline"
        >
          Edit source
        </button>
      )}
    </details>
  )
}
