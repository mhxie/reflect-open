import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readWikiAnchorsBlock } from './anchors.ts'
import { wikiClaimTrust, wikiSourceOrigin, wikiTrustDistribution } from './trust.ts'

const tierSchema = z.enum(['solid', 'supported', 'needs-work'])
const fixtureSchema = z.object({
  cases: z.array(
    z.object({
      name: z.string(),
      asOf: z.string(),
      ledger: z.array(z.string()).nullable(),
      citedTiers: z.array(tierSchema),
      tier: tierSchema,
      overlays: z.array(z.enum(['disputed', 'edited'])),
    }),
  ),
})

const fixture = fixtureSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../../fixtures/wiki-claim-trust.json', import.meta.url), 'utf8'),
  ),
)

describe('wikiClaimTrust', () => {
  it.each(fixture.cases)('$name (shared fixture)', (testCase) => {
    const ledger =
      testCase.ledger === null
        ? null
        : readWikiAnchorsBlock(testCase.ledger.join('\n'), testCase.asOf)
    const trust = wikiClaimTrust({ ledger, citedTiers: testCase.citedTiers })
    expect({ tier: trust.tier, overlays: trust.overlays }).toEqual({
      tier: testCase.tier,
      overlays: testCase.overlays,
    })
  })

  it('explains a solid claim by its evidence and its adversarial review', () => {
    const ledger = readWikiAnchorsBlock(
      [
        '@anchor: arxiv:2409.19256 | valid_at: 2026-01-01',
        '@anchor: url:https://docs.example.org/a | valid_at: 2026-01-01',
        '@pass: challenger | status: verified | at: 2026-02-01',
      ].join('\n'),
      '2026-10-07',
    )
    expect(wikiClaimTrust({ ledger, citedTiers: [] }).reasons).toEqual([
      { kind: 'evidence', origins: 2, primary: 1 },
      { kind: 'adversarial-review', agent: 'challenger', at: '2026-02-01' },
    ])
  })

  it('explains a disputed, edited claim with both records', () => {
    const ledger = readWikiAnchorsBlock(
      [
        '@anchor: arxiv:2409.19256 | valid_at: 2026-01-01',
        '@pass: challenger | status: flagged | at: 2026-02-01',
        '@pass: editor | status: pending | at: 2026-03-01',
      ].join('\n'),
      '2026-10-07',
    )
    expect(wikiClaimTrust({ ledger, citedTiers: [] }).reasons).toEqual([
      { kind: 'evidence', origins: 1, primary: 1 },
      { kind: 'disputed', agent: 'challenger', status: 'flagged', at: '2026-02-01' },
      { kind: 'edited', at: '2026-03-01' },
    ])
  })
})

describe('wikiSourceOrigin', () => {
  it('names a DOI link by its DOI, whatever its case', () => {
    expect(wikiSourceOrigin({ type: 'url', id: 'https://doi.org/10.1145/ABC.123' })).toBe(
      wikiSourceOrigin({ type: 'doi', id: '10.1145/abc.123' }),
    )
  })

  it('keeps an unparseable URL as its own origin', () => {
    expect(wikiSourceOrigin({ type: 'url', id: 'not a url' })).toBe('url:not a url')
  })
})

describe('wikiTrustDistribution', () => {
  it('counts claims per tier', () => {
    expect(
      wikiTrustDistribution([{ tier: 'solid' }, { tier: 'needs-work' }, { tier: 'needs-work' }]),
    ).toEqual({ solid: 1, supported: 0, 'needs-work': 2 })
  })
})
