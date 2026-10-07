import { describe, expect, it } from 'vitest'
import { planWikiClaim, planWikiClaimBoundary } from './article-edit.ts'
import { readWikiClaimIndex } from './article.ts'

const DAY = '2026-10-06'

describe('claim authoring', () => {
  it('wraps a partial sentence without splitting the paragraph', () => {
    const source = 'Before selected words after.'
    const result = planWikiClaim(source, 7, 21, DAY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toContain(
      'Before <!-- claim:c1 -->selected words<!-- /claim:c1 --> after.',
    )
    expect(result.source).toContain('```anchors c1\n```')
  })

  it('puts a line-leading marker on its own line while retaining one paragraph', () => {
    const result = planWikiClaim('Whole paragraph.', 0, 16, DAY)
    expect(result.ok && result.source).toContain(
      '<!-- claim:c1 -->\n\nWhole paragraph.<!-- /claim:c1 -->',
    )
  })

  it('permits a precise range spanning several paragraphs', () => {
    const result = planWikiClaim('First paragraph.\n\nSecond paragraph.', 0, 35, DAY)
    expect(result.ok).toBe(true)
    if (result.ok) expect(readWikiClaimIndex(result.source, DAY).claims).toHaveLength(1)
  })

  it('refuses formatting-changing emphasis boundaries and split entities', () => {
    expect(planWikiClaim('foo*bar*baz', 4, 7, DAY).ok).toBe(false)
    expect(planWikiClaim('A &amp; B', 4, 7, DAY).ok).toBe(false)
    expect(planWikiClaim('A `code` B', 4, 7, DAY).ok).toBe(false)
    expect(planWikiClaim('A [link](https://example.org) B', 4, 7, DAY).ok).toBe(false)
  })

  it('preserves whole emphasis and complete citation units', () => {
    expect(planWikiClaim('A **strong words** end', 2, 18, DAY).ok).toBe(true)
    const citation = '[[Other#^c2|ref]]<!-- {"metadata":{"citation":{"valid_at":"2026-10-01"}}} -->'
    expect(planWikiClaim(`A ${citation} B`, 2, 2 + citation.length, DAY).ok).toBe(true)
    expect(planWikiClaim(`A ${citation} B`, 2, 2 + '[[Other#^c2|ref]]'.length, DAY).ok).toBe(false)
  })

  it('reserves deleted and malformed owners so a fresh assertion cannot reuse them', () => {
    const source = 'A new assertion.\n\n```anchors c9\n```'
    const result = planWikiClaim(source, 0, 16, DAY)
    expect(result.ok && result.id).toBe('c10')
  })

  it('refuses a new claim overlapping an existing range', () => {
    const source = 'A <!-- claim:c1 -->old assertion<!-- /claim:c1 -->.'
    expect(planWikiClaim(source, 22, 25, DAY).ok).toBe(false)
  })

  it('adjusts an existing range deliberately without changing its evidence or ID', () => {
    const source =
      'A <!-- claim:c4 -->old assertion<!-- /claim:c4 --> with a qualification.\n\n## Evidence\n\n```anchors c4\n@anchor: url:https://example.org | valid_at: 2020-01-02\n```\n'
    const result = planWikiClaimBoundary(
      source,
      'c4',
      source.indexOf('old assertion'),
      source.indexOf('\n\n##'),
      DAY,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const index = readWikiClaimIndex(result.source, DAY)
    expect(index.claims.map((claim) => claim.id)).toEqual(['c4'])
    expect(index.source.slice(index.claims[0]!.from, index.claims[0]!.to)).toBe(
      'old assertion with a qualification.',
    )
    expect(index.ledgers[0]?.raw).toContain(
      '@anchor: url:https://example.org | valid_at: 2020-01-02',
    )
    expect(index.diagnostics).toEqual([])
  })

  it('inserts a new ledger inside Evidence when another section follows it', () => {
    const source =
      'An assertion.\n\n## Evidence\n\nReference notes.\n\n## Further reading\n\nOther notes.\n'
    const result = planWikiClaim(source, 0, 13, DAY)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(readWikiClaimIndex(result.source, DAY).diagnostics).toEqual([])
    expect(result.source.indexOf('```anchors c1')).toBeLessThan(
      result.source.indexOf('## Further reading'),
    )
  })
})
