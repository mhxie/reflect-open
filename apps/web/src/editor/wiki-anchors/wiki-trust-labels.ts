import type { WikiClaimStanding } from '@reflect/core'

/** The words for a claim's standing, as the trust card and marks read it aloud. */
export function wikiStandingLabel(standing: WikiClaimStanding): string {
  if (standing.state === 'unevaluated') return 'Not evaluated'
  if (standing.state === 'changed') return 'Changed since evaluation'
  const { tier, overlays } = standing.verdict
  if (overlays.includes('disputed')) return 'Disputed'
  return tier === 'solid' ? 'Solid' : tier === 'supported' ? 'Supported' : 'Needs work'
}

/**
 * The `data-wiki-trust` value styling a claim and its marks: the tier when
 * the verdict is current, `pending` otherwise.
 */
export function wikiStandingStyle(standing: WikiClaimStanding): string {
  if (standing.state !== 'current') return 'pending'
  return standing.verdict.overlays.includes('disputed') ? 'disputed' : standing.verdict.tier
}
