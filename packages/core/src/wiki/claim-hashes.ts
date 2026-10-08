import { readWikiClaimIndex } from './article.ts'
import { wikiClaimTextSha256 } from './trust-report.ts'

/**
 * Each valid range claim's text hash in `source`, by claim id: the key a
 * harness's verdict is tied to (see `wikiClaimTextSha256`). Legacy
 * `### [Cn]` claims carry their own ledger inside their range, so a recorded
 * question would change their text; they are left out of trust.
 */
export async function wikiClaimTextHashes(
  source: string,
  asOf: string,
): Promise<Map<string, string>> {
  // Reflect reads notes with LF line endings; a raw file is held the same way.
  const text = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const claims = readWikiClaimIndex(text, asOf).claims.filter((claim) => claim.kind === 'range')
  const hashes = await Promise.all(
    claims.map(
      async (claim) =>
        [claim.id, await wikiClaimTextSha256(text.slice(claim.from, claim.to))] as const,
    ),
  )
  return new Map(hashes)
}
