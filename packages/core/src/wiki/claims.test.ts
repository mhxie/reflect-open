import { describe, expect, it } from 'vitest'
import { wikiClaimHeadingText, wikiClaimNumber } from './claims.ts'
import { summarizeWikiEntry } from './entry-summary.ts'

const ENTRY = [
  '# Anchoring',
  '',
  '## Summary',
  '',
  '```markdown',
  '### [C2] Not a heading inside a code block',
  '```',
  '',
  '## Claims',
  '',
  '### [C1] Anchoring pulls estimates toward a start value',
  '',
  '### [C2] The canonical demonstration used a random anchor',
  '',
  '#### [C3] A sub-heading, not a claim',
  '',
  '### [C10] A tenth claim',
].join('\n')

describe('wikiClaimNumber', () => {
  it('reads level-3 headings led by a bracketed number', () => {
    expect(wikiClaimNumber(3, '[C12] Spacing improves retention')).toBe(12)
    expect(wikiClaimNumber(2, '[C12] Spacing improves retention')).toBeNull()
    expect(wikiClaimNumber(3, 'Spacing improves retention [C12]')).toBeNull()
  })
})

describe('wikiClaimHeadingText', () => {
  it('maps a claim fragment to its numbered claim heading', () => {
    expect(wikiClaimHeadingText(ENTRY, '^c2')).toBe(
      '[C2] The canonical demonstration used a random anchor',
    )
    expect(wikiClaimHeadingText(ENTRY, '#^C10')).toBe('[C10] A tenth claim')
    expect(wikiClaimHeadingText(ENTRY, '%5Ec1')).toBe(
      '[C1] Anchoring pulls estimates toward a start value',
    )
  })

  it('names nothing for other fragments or a claim the entry lacks', () => {
    expect(wikiClaimHeadingText(ENTRY, 'summary')).toBeNull()
    expect(wikiClaimHeadingText(ENTRY, '^abc123')).toBeNull()
    expect(wikiClaimHeadingText(ENTRY, '^c4')).toBeNull()
  })

  it('agrees with the claim count on which headings are claims', () => {
    // A level-4 [C3] neither counts nor resolves.
    expect(wikiClaimHeadingText(ENTRY, '^c3')).toBeNull()
    expect(summarizeWikiEntry(ENTRY, '2026-03-01').claims).toBe(3)

    // An escaped `\[C4\]` reads as [C4] for both.
    const escaped = `${ENTRY}\n\n### \\[C4\\] An escaped claim\n`
    expect(wikiClaimHeadingText(escaped, '^c4')).toBe('[C4] An escaped claim')
    expect(summarizeWikiEntry(escaped, '2026-03-01').claims).toBe(4)
  })
})
