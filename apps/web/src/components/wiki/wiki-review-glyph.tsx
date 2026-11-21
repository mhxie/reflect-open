import type { ReactElement } from 'react'
import { CircleCheck, CircleDashed, Flag } from 'lucide-react'
import { wikiReviewState, type WikiEntrySummary } from '@reflect/core'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

interface WikiReviewGlyphProps {
  summary: WikiEntrySummary
}

interface ProgressRingProps {
  /** The verified share of the claims, 0 to 1. */
  fraction: number
}

const RING_RADIUS = 5
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/** A ring filled to the verified share of an entry's claims. */
function ProgressRing({ fraction }: ProgressRingProps): ReactElement {
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-3.5 -rotate-90">
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-current text-text-muted/40"
      />
      <circle
        cx="7"
        cy="7"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        strokeDasharray={`${fraction * RING_LENGTH} ${RING_LENGTH}`}
        className="stroke-current text-green-600 dark:text-green-400"
      />
    </svg>
  )
}

/** Where the reviewer stands on an entry's claims, in words. */
function reviewLabel(summary: WikiEntrySummary): string {
  const verified = `${summary.verifiedClaims} of ${summary.claims} claims verified`
  switch (wikiReviewState(summary)) {
    case 'verified':
      return summary.claims === 1
        ? 'Its claim is verified'
        : `All ${summary.claims} claims verified`
    case 'partial':
      return verified
    case 'flagged':
      return `${summary.flaggedClaims} flagged · ${verified}`
    case 'unreviewed':
      return 'No claims verified yet'
  }
}

/**
 * An entry's reviewer standing at a glance: a check once every claim is
 * verified, a ring filled to the verified share, an amber flag when any claim
 * is flagged, a dashed circle before any verification. The numbers are its
 * tooltip and accessible name.
 */
export function WikiReviewGlyph({ summary }: WikiReviewGlyphProps): ReactElement {
  const label = reviewLabel(summary)
  let glyph: ReactElement
  switch (wikiReviewState(summary)) {
    case 'verified':
      glyph = <CircleCheck aria-hidden className="size-3.5 text-green-600 dark:text-green-400" />
      break
    case 'partial':
      glyph = <ProgressRing fraction={summary.verifiedClaims / summary.claims} />
      break
    case 'flagged':
      glyph = <Flag aria-hidden className="size-3.5 text-amber-700 dark:text-amber-300" />
      break
    case 'unreviewed':
      glyph = <CircleDashed aria-hidden className="size-3.5 text-text-muted" />
      break
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span role="img" aria-label={label} className="flex size-4 items-center justify-center">
            {glyph}
          </span>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
