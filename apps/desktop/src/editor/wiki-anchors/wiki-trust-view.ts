import type { WikiTrustDisplay } from '@reflect/core'
import type { WikiClaimTrust } from './wiki-claim-trust-card.tsx'

/**
 * What the article plugin needs to draw trust: the reading style and each
 * claim's verdict, already matched to its current text. The bridge builds it
 * from the harness's report; the plugin only draws it.
 */
export interface WikiTrustView {
  readonly display: Exclude<WikiTrustDisplay, 'off'>
  readonly claim: (claimId: string) => WikiClaimTrust | null
}
