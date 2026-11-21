import type { WikiClaimLedger } from '@reflect/core'

/** A later review resolves an editor's pending record without deleting its history. */
export function wikiClaimPending(ledger: WikiClaimLedger): boolean {
  let last: { at: string; pending: boolean } | null = null
  for (const pass of ledger.block.passes) {
    if (!pass.current || pass.at === null || (pass.agent !== 'reviewer' && pass.agent !== 'editor'))
      continue
    if (last === null || pass.at >= last.at)
      last = { at: pass.at, pending: pass.agent === 'editor' && pass.status === 'pending' }
  }
  return last?.pending === true
}
