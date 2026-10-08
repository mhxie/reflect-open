import { describe, expect, it } from 'vitest'
import {
  findWikiClaim,
  readWikiClaimIndex,
  wikiByteOffsetToSource,
  wikiSourceSpan,
} from './article.ts'
import { summarizeWikiEntry } from './entry-summary.ts'

const DAY = '2026-10-06'
function pair(id: string, text: string): string {
  return `<!-- claim:${id} -->${text}<!-- /claim:${id} -->`
}
function ledger(id: string, text = ''): string {
  return `\n\n\`\`\`anchors ${id}\n${text}\n\`\`\``
}

describe('article claim ranges', () => {
  it('resolves separate intra-sentence claims in one paragraph and a range across paragraphs', () => {
    const source = `First ${pair('c4', '甲😀')} and ${pair('c1', 'second\n\nthird')} end.`
    const index = readWikiClaimIndex(source, DAY)
    expect(index.claims.map((claim) => [claim.id, source.slice(claim.from, claim.to)])).toEqual([
      ['c4', '甲😀'],
      ['c1', 'second\n\nthird'],
    ])
    expect(findWikiClaim(index, '#%5Ec4')?.id).toBe('c4')
    expect(findWikiClaim(index, '^c2')).toBeNull()
    for (const claim of index.claims) {
      expect(wikiByteOffsetToSource(source, claim.byteFrom)).toBe(claim.from)
      expect(wikiByteOffsetToSource(source, claim.byteTo)).toBe(claim.to)
    }
    expect(wikiByteOffsetToSource('😀', 1)).toBeNull()
  })

  it('keeps unchanged Unicode and CRLF interchange positions', () => {
    const source = `---\r\ntitle: 中文\r\n---\r\n\r\nA ${pair('c2', '中文😀')} B\r\n`
    const claim = readWikiClaimIndex(source, DAY).claims[0]!
    expect(
      new TextDecoder().decode(
        new TextEncoder().encode(source).slice(claim.byteFrom, claim.byteTo),
      ),
    ).toBe('中文😀')
    expect(wikiSourceSpan('中😀', 1, 3)).toEqual({ from: 1, to: 3, byteFrom: 3, byteTo: 7 })
  })

  it.each([
    'A <!-- claim:c1 -->unfinished',
    'A <!-- /claim:c1 -->then <!-- claim:c1 -->',
    `A ${pair('c1', '')}`,
    `A ${pair('c1', 'first')} ${pair('c1', 'second')}`,
    'A <!-- claim:c1 -->one <!-- claim:c2 -->two<!-- /claim:c1 --> three<!-- /claim:c2 -->',
    'A <!-- claim:c1 -->one <!-- claim:c2 -->two<!-- /claim:c2 --> three<!-- /claim:c1 -->',
  ])('rejects invalid ownership without extending another range: %s', (source) => {
    const index = readWikiClaimIndex(source, DAY)
    expect(index.claims).toEqual([])
    expect(index.diagnostics.length).toBeGreaterThan(0)
    expect(index.markers.every((marker) => !marker.valid)).toBe(true)
  })

  it('requires portable blank lines after line-leading markers', () => {
    expect(readWikiClaimIndex('<!-- claim:c1 -->\nText<!-- /claim:c1 -->', DAY).claims).toEqual([])
    expect(
      readWikiClaimIndex('<!-- claim:c1 -->\n\nText<!-- /claim:c1 -->', DAY).claims,
    ).toHaveLength(1)
  })

  it('keeps a range touching a table within one cell', () => {
    const table = (row: string): string => `Intro.\n\n| a | b |\n| --- | --- |\n${row}\n\nAfter.\n`
    const across = readWikiClaimIndex(table('| <!-- claim:c1 -->x | y<!-- /claim:c1 --> |'), DAY)
    expect(across.claims).toEqual([])
    expect(across.diagnostics.map((item) => item.message)).toEqual(['c1 crosses a table cell.'])

    // One cell, an escaped pipe, and a wiki link's alias pipe all stay in the cell.
    for (const cell of [
      pair('c1', 'x'),
      pair('c1', String.raw`x \| y`),
      pair('c1', '[[Note|alias]] x'),
    ]) {
      const index = readWikiClaimIndex(table(`| ${cell} | y |`), DAY)
      expect(index.diagnostics).toEqual([])
      expect(index.claims).toHaveLength(1)
    }

    // A range entering the table from the prose above crosses a row.
    expect(
      readWikiClaimIndex(
        'Intro <!-- claim:c1 -->text.\n\n| a | b |\n| --- | --- |\n| x<!-- /claim:c1 --> | y |\n',
        DAY,
      ).claims,
    ).toEqual([])
  })

  it('ignores examples in code and larger comments', () => {
    const source =
      '`<!-- claim:c1 -->`\n\n```md\n<!-- claim:c2 -->\n```\n\n<!-- Example: <!-- claim:c3 --> -->'
    expect(readWikiClaimIndex(source, DAY).markers).toEqual([])
  })

  it('rejects boundaries inside links and claims within administrative sections', () => {
    expect(
      readWikiClaimIndex(`[a ${pair('c1', 'word')}](https://example.org)`, DAY).claims,
    ).toEqual([])
    expect(
      readWikiClaimIndex(`## Revision Log\n\nA ${pair('c1', 'old revision')}`, DAY).claims,
    ).toEqual([])
    expect(
      readWikiClaimIndex(`A <!-- claim:c1 -->body\n\n## Evidence\n\nledger<!-- /claim:c1 -->`, DAY)
        .claims,
    ).toEqual([])
  })

  it('attaches only explicitly owned ledgers and rejects duplicates and orphans', () => {
    const source = `A ${pair('c4', 'four')} then ${pair('c1', 'one')}\n\n## References${ledger('c1')}${ledger('c4')}`
    expect(
      readWikiClaimIndex(source, DAY).ledgers.map((block) => [block.owner, block.valid]),
    ).toEqual([
      ['c1', true],
      ['c4', true],
    ])
    const invalid = readWikiClaimIndex(source + ledger('c1') + ledger('c9'), DAY)
    expect(invalid.ledgers.filter((block) => block.valid).map((block) => block.owner)).toEqual([
      'c4',
    ])
    expect(invalid.diagnostics).toHaveLength(3)
  })

  it('keeps legacy claims while refusing mixed ownership of one ID', () => {
    const source =
      '# Example\n\n## Claims\n\n### [C1] Old claim\n\nBody\n\n```anchors\n@anchor: doi:10/example | valid_at: 2026-01-01\n```'
    const index = readWikiClaimIndex(source, DAY)
    expect(index.claims[0]?.kind).toBe('legacy')
    expect(index.ledgers[0]?.owner).toBe('c1')
    expect(
      readWikiClaimIndex(`${source}\n\n## More\n\nA ${pair('c1', 'new')}`, DAY).claims,
    ).toEqual([])
  })

  it('derives article summary evidence by owner instead of section order', () => {
    const source = `# Concept\n\nOpening prose.\n\nA ${pair('c4', 'four')} and ${pair('c1', 'one')}\n\n## Evidence${ledger('c1', '@anchor: url:https://example.org | valid_at: 2026-01-01\n@pass: reviewer | status: verified | at: 2026-01-02')}${ledger('c4')}`
    expect(summarizeWikiEntry(source, DAY)).toMatchObject({
      claims: 2,
      sources: 1,
      unsourcedClaims: 1,
      verifiedClaims: 1,
    })
  })

  it('accepts only prose endpoints whose comments preserve formatting', () => {
    expect(
      readWikiClaimIndex('## Heading <!-- claim:c1 -->bad<!-- /claim:c1 -->', DAY).claims,
    ).toEqual([])
    expect(
      readWikiClaimIndex('a*<!-- claim:c1 -->formatting<!-- /claim:c1 -->*b', DAY).claims,
    ).toEqual([])
    expect(readWikiClaimIndex('A <!--claim:c1-->good<!--/claim:c1-->.', DAY).claims).toHaveLength(1)
  })

  it('diagnoses incomplete tokens and overlapping legacy ownership', () => {
    const invalid = readWikiClaimIndex(`A ${pair('c1', 'good')} after <!-- claim:c2`, DAY)
    expect(
      invalid.diagnostics.some((diagnostic) => diagnostic.message.includes('Unterminated')),
    ).toBe(true)
    const overlap = readWikiClaimIndex(
      'A <!-- claim:c1 -->A\n\n## Claims\n\n### [C2] B\n\nB<!-- /claim:c1 -->',
      DAY,
    )
    expect(overlap.claims).toEqual([])
  })

  it('requires a closed owned ledger in an administrative section', () => {
    expect(
      readWikiClaimIndex(`A ${pair('c1', 'body')}${ledger('c1')}`, DAY).ledgers[0]?.valid,
    ).toBe(false)
    expect(
      readWikiClaimIndex(
        `A ${pair('c1', 'body')}\n\n## References\n\n\`\`\`anchors c1\n@anchor: url:https://example.org | valid_at: 2026-01-01`,
        DAY,
      ).ledgers[0]?.valid,
    ).toBe(false)
  })

  it('rejects a boundary between a native citation and its adjacent metadata', () => {
    const source =
      'A <!-- claim:c1 -->Body [[Other#^c2|ref]]<!-- /claim:c1 --><!-- {"metadata":{"citation":{"valid_at":"2026-01-01"}}} -->'
    expect(readWikiClaimIndex(source, DAY).claims).toEqual([])
  })
})
