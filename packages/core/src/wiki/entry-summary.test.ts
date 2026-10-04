import { describe, expect, it } from 'vitest'
import { summarizeWikiEntry, wikiReviewState, type WikiEntrySummary } from './entry-summary.ts'

const ENTRY = [
  '---',
  'aliases: [Spaced Practice]',
  '---',
  '# Spacing Effect',
  '',
  '> Distributed practice beats massed practice',
  '> for long-term retention.',
  '',
  '## Summary',
  '',
  'Prose synthesis; markers outside the claims never count.',
  '',
  '```anchors',
  '@anchor: doi:10.0000/summary | valid_at: 2026-01-01',
  '```',
  '',
  '## Claims',
  '',
  '### [C1] Spacing improves retention',
  '',
  'Body.',
  '',
  '```anchors',
  '@anchor: doi:10.1037/0033-2909.132.3.354 | valid_at: 2026-01-02',
  '@anchor: url:https://example.org/spacing | valid_at: 2026-01-02 | readwise: 01abc',
  '@pass: reviewer | status: flagged | at: 2026-01-03',
  '@pass: reviewer | status: verified | at: 2026-01-05',
  '```',
  '',
  '@cite: [[Retrieval Practice#^c2]] | valid_at: 2026-01-02',
  '',
  '### [C2] The effect holds across ages',
  '',
  'Body.',
  '',
  '```anchors',
  '@anchor: DOI:10.1037/0033-2909.132.3.354 | valid_at: 2026-01-02',
  '@anchor: arxiv:2501.00001 | valid_at: 2026-01-02 | invalid_at: 2026-02-01',
  '@pass: reviewer | status: flagged | at: 2026-01-04',
  '```',
  '',
  '### [C3] Reviewed but unsourced',
  '',
  'Body.',
  '',
  '```python',
  '### [C9] not a claim',
  '@anchor: doi:10.0000/in-code | valid_at: 2026-01-02',
  '```',
  '',
  '```anchors',
  '@pass: reviewer | status: verified | at: 2026-01-02',
  '@anchor: isbn:9780000000000',
  '@cite: [[Retrieval Practice]] | valid_at: 2026-01-02',
  '```',
  '',
  '## Revision Log',
  '',
  '- 2026-01-05: Re-verified [C1].',
  '- **2026-01-02**: Initial draft.',
  '- 2025-12-31 predates the draft',
].join('\n')

describe('summarizeWikiEntry', () => {
  it('counts claims, their current sources and citations, and the latest revision', () => {
    expect(summarizeWikiEntry(ENTRY, '2026-03-01')).toEqual({
      // The primer quote is passed over for the first paragraph of prose.
      preview: 'Prose synthesis; markers outside the claims never count.',
      // [C9] sits in a python block, not under a claim heading.
      claims: 3,
      // [C3]'s only anchor is undated, so it never holds.
      unsourcedClaims: 1,
      // The DOI repeats in another case; the arXiv anchor was invalidated on 2026-02-01.
      sources: 2,
      verifiedClaims: 2,
      flaggedClaims: 1,
      lastRevised: '2026-01-05',
    } satisfies WikiEntrySummary)
  })

  it('reads markers as they stood on an earlier day', () => {
    const earlier = summarizeWikiEntry(ENTRY, '2026-01-04')

    // The arXiv anchor still held, and [C1]'s re-verification had not happened yet.
    expect(earlier.sources).toBe(3)
    expect(earlier.verifiedClaims).toBe(1)
    expect(earlier.flaggedClaims).toBe(2)
  })

  it('treats a note without a claims section as a guide with nothing to count', () => {
    const guide = summarizeWikiEntry(
      '# Reading Guide\n\n## Reading order\n\n- [[Anchoring]]\n',
      '2026-03-01',
    )

    expect(guide).toEqual({
      preview: null,
      claims: 0,
      unsourcedClaims: 0,
      sources: 0,
      verifiedClaims: 0,
      flaggedClaims: 0,
      lastRevised: null,
    } satisfies WikiEntrySummary)
  })

  it('counts a claim whose only anchor names no source as unsourced', () => {
    const entry = [
      '# Entry',
      '',
      '## Claims',
      '',
      '### [C1] A claim with a placeholder',
      '',
      '```anchors',
      '@anchor: doi: | valid_at: 2026-01-01',
      '```',
    ].join('\n')

    const summary = summarizeWikiEntry(entry, '2026-03-01')
    expect(summary.unsourcedClaims).toBe(1)
    expect(summary.sources).toBe(0)
  })

  it('skips a revision date that names no calendar day', () => {
    const entry = '# Entry\n\n## Revision Log\n\n- 2026-13-01: Typo.\n- 2026-02-01: Draft.\n'

    expect(summarizeWikiEntry(entry, '2026-03-01').lastRevised).toBe('2026-02-01')
  })

  it('reads CRLF line endings', () => {
    expect(summarizeWikiEntry(ENTRY.replaceAll('\n', '\r\n'), '2026-03-01').claims).toBe(3)
  })

  it('previews a translation past its note on the source and its primer, as plain text', () => {
    const copy = [
      '---',
      'title: "Anchoring (中文)"',
      '---',
      '',
      '# Anchoring',
      '',
      '> 本文为 [[Anchoring]] 的中文版本。',
      '',
      '> 主题概览:锚定。',
      '',
      '## Summary',
      '',
      '锚定指估计被拉向**初始参照值**,',
      '见 [[Framing Effect|框架效应]]。',
      '',
      'A second paragraph.',
    ].join('\n')

    expect(summarizeWikiEntry(copy, '2026-03-01').preview).toBe(
      '锚定指估计被拉向初始参照值, 见 Framing Effect 框架效应。',
    )
  })

  it('caps a long preview like an All Notes snippet', () => {
    const preview = summarizeWikiEntry(`# Long\n\n${'word '.repeat(60)}`, '2026-03-01').preview

    expect(preview).toMatch(/^word word .*…$/)
    expect(preview?.length).toBeLessThanOrEqual(121)
  })
})

describe('wikiReviewState', () => {
  const base: WikiEntrySummary = {
    preview: null,
    claims: 4,
    unsourcedClaims: 0,
    sources: 4,
    verifiedClaims: 0,
    flaggedClaims: 0,
    lastRevised: null,
  }

  it('ranks a flagged claim above any verification', () => {
    expect(wikiReviewState({ ...base, verifiedClaims: 3, flaggedClaims: 1 })).toBe('flagged')
  })

  it('separates fully verified, partly verified, and unreviewed entries', () => {
    expect(wikiReviewState({ ...base, verifiedClaims: 4 })).toBe('verified')
    expect(wikiReviewState({ ...base, verifiedClaims: 2 })).toBe('partial')
    expect(wikiReviewState(base)).toBe('unreviewed')
    expect(wikiReviewState({ ...base, claims: 0 })).toBe('unreviewed')
  })
})
