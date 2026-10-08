import { useState, type ReactElement } from 'react'
import type { WikiClaimStanding, WikiSourceStanding } from '@reflect/core'
import { openUrlSync } from '@/lib/open-url.ts'
import { cn } from '@/lib/utils.ts'
import { wikiStandingLabel, wikiStandingStyle } from './wiki-trust-labels.ts'

/** What the trust card shows about one claim, and the one action it offers. */
export interface WikiClaimTrust {
  readonly claimId: string
  /** The claim's text, whitespace collapsed and shortened, so the card names what it judges. */
  readonly excerpt: string
  readonly standing: WikiClaimStanding
  /** Standings of the sources the verdict names, in the verdict's order. */
  readonly sources: readonly (WikiSourceStanding & { readonly key: string })[]
  /** The harness's trust threshold on the weight scale, when it published one. */
  readonly sourceThreshold: number | null
  /** The reader already questioned this claim today. */
  readonly questionedToday: boolean
  /** Record the reader's doubt, reporting whether it was written; absent where the note cannot be edited. */
  readonly question?: () => boolean
}

interface WikiClaimTrustCardProps {
  readonly trust: WikiClaimTrust
  /** Whether the note accepts the question record now. */
  readonly editable: boolean
}

interface SourceRowProps {
  readonly source: WikiClaimTrust['sources'][number]
  readonly threshold: number | null
}

/** A web address from the report; anything else stays plain text. */
function webUrl(url: string | null): string | null {
  return url !== null && /^https?:\/\//i.test(url) ? url : null
}

function SourceRow({ source, threshold }: SourceRowProps): ReactElement {
  const url = webUrl(source.url)
  return (
    <li className="space-y-0.5">
      <div className="flex items-center gap-2">
        {url === null ? (
          <span className="min-w-0 flex-1 truncate text-text-secondary">{source.label}</span>
        ) : (
          <button
            type="button"
            onClick={() => openUrlSync(url)}
            title={url}
            className="min-w-0 flex-1 truncate text-left text-text-secondary underline decoration-border-strong underline-offset-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
          >
            {source.label}
          </button>
        )}
        <span aria-hidden className="relative h-1 w-10 rounded-full bg-border">
          <span
            className={cn(
              'block h-full rounded-full',
              source.trusted ? 'bg-trust-solid' : 'bg-trust-supported',
            )}
            style={{ width: `${Math.round(source.weight * 100)}%` }}
          />
          {threshold === null ? null : (
            <span
              className="absolute -top-0.5 h-2 w-px bg-text-secondary"
              style={{ left: `${Math.round(threshold * 100)}%` }}
            />
          )}
        </span>
        <span className="w-8 text-right text-text-secondary tabular-nums">
          {source.weight.toFixed(2)}
          <span className="sr-only">
            {source.trusted ? ', trusted' : ', below the trust threshold'}
          </span>
        </span>
      </div>
      {source.reasons.length > 0 ? (
        <p className="text-text-secondary">
          {source.reasons.map((reason) => reason.text).join(' · ')}
        </p>
      ) : null}
    </li>
  )
}

/**
 * The harness's verdict on one claim, read aloud: tier, why, what would
 * raise it, and the sources it rests on with their weights. Reflect adds
 * nothing of its own beyond saying when the text changed since evaluation.
 */
export function WikiClaimTrustCard({ trust, editable }: WikiClaimTrustCardProps): ReactElement {
  const { standing, question } = trust
  const verdict = standing.state === 'unevaluated' ? null : standing.verdict
  // Set on a written press, before the ledger reparses, so a double press records once.
  const [asked, setAsked] = useState<'recorded' | 'refused' | null>(null)
  return (
    <section aria-label={`Claim ${trust.claimId.toUpperCase()} trust`} className="space-y-2">
      <header className="space-y-1">
        <p className="flex items-center gap-1.5 text-text">
          <span
            aria-hidden
            className="wiki-trust-glyph"
            data-wiki-trust={wikiStandingStyle(standing)}
          />
          <span className="font-medium">{wikiStandingLabel(standing)}</span>
          {verdict?.overlays.includes('edited') === true && standing.state === 'current' ? (
            <span className="text-text-secondary">· edited since review</span>
          ) : null}
        </p>
        {trust.excerpt === '' ? null : (
          <p className="line-clamp-2 text-text-secondary">{trust.excerpt}</p>
        )}
      </header>
      {standing.state === 'changed' ? (
        <p className="text-text-secondary">
          Edited since it was evaluated on {standing.verdict.evaluatedAt}.
        </p>
      ) : null}
      {standing.state === 'unevaluated' ? (
        <p className="text-text-secondary">Not evaluated yet.</p>
      ) : null}
      {standing.state === 'current' && standing.verdict.reasons.length > 0 ? (
        <ul className="space-y-0.5 text-text-secondary">
          {standing.verdict.reasons.map((reason, ordinal) => (
            <li key={ordinal}>{reason.text}</li>
          ))}
        </ul>
      ) : null}
      {standing.state === 'current' && standing.verdict.next !== null ? (
        <p className="text-text-secondary">{standing.verdict.next}</p>
      ) : null}
      {trust.sources.length > 0 ? (
        <ul className="space-y-1.5">
          {trust.sources.map((source) => (
            <SourceRow key={source.key} source={source} threshold={trust.sourceThreshold} />
          ))}
        </ul>
      ) : null}
      {question === undefined || !editable ? null : trust.questionedToday ||
        asked === 'recorded' ? (
        <p className="text-text-secondary">You questioned this claim today.</p>
      ) : asked === 'refused' ? (
        <p className="text-text-secondary">
          Fix this claim’s entry in the Evidence section first; the problem is listed there.
        </p>
      ) : (
        <button
          type="button"
          onClick={() => {
            setAsked(question() ? 'recorded' : 'refused')
          }}
          title="Flags the claim in its evidence for your agent to review; ⌘Z undoes it"
          className="rounded-md border border-border-strong px-2 py-1 font-medium text-text-secondary shadow-input transition-colors duration-100 hover:bg-surface-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
        >
          Question this claim
        </button>
      )}
    </section>
  )
}
