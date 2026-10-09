import { describe, expect, it } from 'vitest'
import { readWikiArticle } from './article-references.ts'

const DAY = '2026-10-06'
function citation(target: string, day = DAY): string {
  return `[[${target}|ref]]<!-- {"metadata":{"citation":{"valid_at":"${day}"}}} -->`
}
function claim(id: string, text: string): string {
  return `A <!-- claim:${id} -->${text}<!-- /claim:${id} -->`
}
function ledger(id: string, ...urls: string[]): string {
  return `\n\n\`\`\`anchors ${id}\n${urls.map((url) => `@anchor: url:${url} | valid_at: 2026-01-01`).join('\n')}\n\`\`\``
}

describe('article reference projection', () => {
  it('assigns first-appearance numbers and preserves separate locators for one URL', () => {
    const source =
      claim('c1', 'One [ref][early]. More [ref][late].') +
      '\n\n## References' +
      ledger('c1', 'https://example.org/paper') +
      '\n\n[early]: https://example.org/paper "Study 1, p. 2"\n[late]: https://example.org/paper "Study 2, p. 9"'
    const index = readWikiArticle(source, DAY)
    expect(
      index.references.map((reference) => [
        reference.number,
        reference.locator,
        reference.claimId,
        reference.compact,
      ]),
    ).toEqual([
      [1, 'Study 1, p. 2', 'c1', true],
      [1, 'Study 2, p. 9', 'c1', true],
    ])
    expect(index.bibliography).toHaveLength(1)
    expect(index.source).toBe(source)
  })

  it('sorts adjacent mixed references without swapping their occurrence metadata', () => {
    const source =
      claim(
        'c1',
        `First ${citation('Other#^c2', '2026-01-01')}. Next [ref][paper]. Mixed [ref][paper]${citation('Other#^c2', '2026-02-02')}`,
      ) +
      '\n\n## References' +
      ledger('c1', 'https://example.org/paper') +
      '\n\n[paper]: https://example.org/paper "p. 12"'
    const index = readWikiArticle(source, DAY)
    expect(
      index.groups
        .at(-1)
        ?.occurrences.map((reference) => [
          reference.number,
          reference.dates?.validAt ?? reference.locator,
        ]),
    ).toEqual([
      [1, '2026-02-02'],
      [2, 'p. 12'],
    ])
    expect(index.references.map((reference) => reference.number)).toEqual([1, 2, 2, 1])
  })

  it('keeps a note and its claim distinct, while resolved aliases share a target', () => {
    const source = `${citation('Other')} ${citation('Other#^c2')} ${citation('Alias#^c2')}`
    const index = readWikiArticle(source, DAY, {
      noteIdentity: (title) => (title === 'Other' || title === 'Alias' ? 'notes/other.md' : null),
    })
    expect(index.references.map((reference) => reference.number)).toEqual([1, 2, 2])
    expect(index.references.every((reference) => reference.claimId === null)).toBe(true)
  })

  it('numbers explicit references without borrowing evidence from another claim', () => {
    const source =
      claim('c1', 'One [ref][source].') +
      ' Outside [ref][source]. ' +
      claim('c4', 'Four [ref][source].') +
      '\n\n## References' +
      ledger('c1', 'https://example.org/paper') +
      ledger('c4', 'https://other.org/paper') +
      '\n\n[source]: https://example.org/paper "p. 2"'
    expect(
      readWikiArticle(source, DAY).references.map((reference) => [
        reference.claimId,
        reference.compact,
      ]),
    ).toEqual([
      ['c1', true],
      [null, true],
      ['c4', true],
    ])
  })

  it('keeps PDF locators, historical records and writer fields separate from numbering', () => {
    const records =
      '@anchor: arxiv:1234.56789 | valid_at: 2026-01-01 | title: Historical title | invalid_at: 2026-02-01'
    const source =
      claim('c1', 'Read [ref][paper].') +
      `\n\n## References\n\n\`\`\`anchors c1\n${records}\n\`\`\`` +
      '\n\n[paper]: https://arxiv.org/pdf/1234.56789v2#page=4 "Version 2, p. 4"'
    const index = readWikiArticle(source, DAY)
    expect(index.references[0]).toMatchObject({
      number: 1,
      claimId: 'c1',
      locator: 'Version 2, p. 4',
      compact: true,
      dates: null,
    })
    expect(index.ledgers[0]?.raw).toBe(records)
    expect(index.ledgers[0]?.block.unparsed).toEqual([])
    expect(index.ledgers[0]?.block.sources[0]).toMatchObject({
      current: false,
      invalidAt: '2026-02-01',
    })
    expect(index.source).toBe(source)
  })

  it('keeps malformed citation metadata visible and diagnostic', () => {
    const source = 'A [[Other#^c2|ref]]<!-- {"metadata":{"citation":{"valid_at":"bad"}}} -->'
    const index = readWikiArticle(source, DAY)
    expect(index.references[0]?.compact).toBe(false)
    expect(index.groups).toEqual([])
    expect(index.diagnostics).toHaveLength(1)
  })

  it('ignores references in code and ordinary topical wikilinks', () => {
    const source =
      '`[[Other|ref]]`\n\n```md\n[ref][paper]\n```\n\n[[Other]]\n\n[paper]: https://example.org'
    expect(readWikiArticle(source, DAY).references).toEqual([])
  })
})
