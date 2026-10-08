import type { ReactElement } from 'react'
import type { WikiClaimStanding, WikiSourceStanding } from '@reflect/core'
import { cn } from '@/lib/utils.ts'
import { WikiTrustGlyph } from './wiki-trust-glyph.tsx'
import { wikiStandingLabel } from './wiki-trust-labels.ts'

/** What the trust card shows about one claim, and the one action it offers. */
export interface WikiClaimTrust {
  readonly claimId: string
  readonly standing: WikiClaimStanding
  /** Standings of the sources the verdict names, in the verdict's order. */
  readonly sources: readonly (WikiSourceStanding & { readonly key: string })[]
  /** The day the reader questioned the claim, when that record is still open. */
  readonly questionedAt: string | null
  /** Record the reader's doubt; absent where the note cannot be edited. */
  readonly question?: () => void
}

interface WikiClaimTrustCardProps {
  readonly trust: WikiClaimTrust
}

/**
 * The harness's verdict on one claim, read aloud: tier, why, what would
 * raise it, and the sources it rests on with their weights. Reflect adds
 * nothing of its own beyond saying when the text changed since evaluation.
 */
export function WikiClaimTrustCard({ trust }: WikiClaimTrustCardProps): ReactElement {
  const { standing } = trust
  const verdict = standing.state === 'unevaluated' ? null : standing.verdict
  return (
    <section aria-label={`Claim ${trust.claimId.toUpperCase()} trust`} className="space-y-2">
      <header className="flex items-center gap-1.5 text-text">
        <WikiTrustGlyph standing={standing} />
        <span className="font-medium">{wikiStandingLabel(standing)}</span>
        {verdict?.overlays.includes('edited') === true && standing.state === 'current' ? (
          <span className="text-text-muted">· edited since review</span>
        ) : null}
      </header>
      {standing.state === 'changed' ? (
        <p className="text-text-muted">
          The text changed after your harness evaluated it on {standing.verdict.evaluatedAt}.
        </p>
      ) : null}
      {standing.state === 'unevaluated' ? (
        <p className="text-text-muted">Your harness has not evaluated this claim yet.</p>
      ) : null}
      {standing.state === 'current' && standing.verdict.reasons.length > 0 ? (
        <ul className="space-y-0.5 text-text-secondary">
          {standing.verdict.reasons.map((reason, ordinal) => (
            <li key={ordinal}>{reason.text}</li>
          ))}
        </ul>
      ) : null}
      {standing.state === 'current' && standing.verdict.next !== null ? (
        <p className="text-text-muted">{standing.verdict.next}</p>
      ) : null}
      {trust.sources.length > 0 ? (
        <ul className="space-y-1">
          {trust.sources.map((source) => (
            <li key={source.key} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-text-secondary">{source.label}</span>
              <span
                aria-hidden
                className="h-1 w-10 overflow-hidden rounded-full bg-border"
                title={`Weight ${source.weight.toFixed(2)}`}
              >
                <span
                  className={cn(
                    'block h-full rounded-full',
                    source.trusted ? 'bg-trust-solid' : 'bg-trust-supported',
                  )}
                  style={{ width: `${Math.round(source.weight * 100)}%` }}
                />
              </span>
              <span className="w-14 text-right text-text-muted tabular-nums">
                {source.weight.toFixed(2)}
                <span className="sr-only">{source.trusted ? ', trusted' : ', not trusted'}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {trust.questionedAt !== null ? (
        <p className="text-text-muted">You questioned this claim on {trust.questionedAt}.</p>
      ) : trust.question === undefined ? null : (
        <button
          type="button"
          onClick={trust.question}
          className="rounded-md border border-border-strong px-2 py-1 font-medium text-text-secondary shadow-input transition-colors duration-100 hover:bg-surface-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          Question this claim
        </button>
      )}
    </section>
  )
}
