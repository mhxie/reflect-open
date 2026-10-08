import type { ReactElement } from 'react'
import type { WikiClaimStanding } from '@reflect/core'
import { cn } from '@/lib/utils.ts'

interface WikiTrustGlyphProps {
  readonly standing: WikiClaimStanding
  readonly className?: string
}

/**
 * A tier's shape, legible without color: filled (solid), ring (supported),
 * dashed ring (needs work, red when disputed), dotted ring (the text changed
 * since evaluation or has no verdict yet).
 */
export function WikiTrustGlyph({ standing, className }: WikiTrustGlyphProps): ReactElement {
  const verdict = standing.state === 'current' ? standing.verdict : null
  const disputed = verdict?.overlays.includes('disputed') === true
  return (
    <svg viewBox="0 0 12 12" aria-hidden className={cn('size-2.5 shrink-0', className)}>
      {verdict?.tier === 'solid' ? (
        <circle cx="6" cy="6" r="4.5" className="fill-trust-solid" />
      ) : (
        <circle
          cx="6"
          cy="6"
          r="4"
          fill="none"
          strokeWidth="1.5"
          strokeDasharray={
            verdict === null ? '0.5 2' : verdict.tier === 'needs-work' ? '2 1.6' : undefined
          }
          strokeLinecap={verdict === null ? 'round' : undefined}
          className={
            verdict === null
              ? 'stroke-text-muted'
              : disputed
                ? 'stroke-trust-disputed'
                : verdict.tier === 'needs-work'
                  ? 'stroke-trust-needs-work'
                  : 'stroke-trust-supported'
          }
        />
      )}
    </svg>
  )
}
