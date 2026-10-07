import { describe, expect, it } from 'vitest'
import {
  parseWikiMarker,
  readWikiAnchorsBlock,
  readWikiCitationComment,
  readWikiCitationMetadata,
  readWikiCitationParagraph,
  wikiMarkerHolds,
  wikiSourceKey,
  wikiSourceLabel,
  wikiSourceUrl,
} from './anchors.ts'

describe('parseWikiMarker', () => {
  it('reads the head and the pipe-separated fields of a marker line', () => {
    const marker = parseWikiMarker(
      '  @anchor: url:https://example.org/a?b=1 | valid_at: 2026-01-02 | readwise: 01abc',
    )

    expect(marker?.kind).toBe('anchor')
    expect(marker?.head).toBe('url:https://example.org/a?b=1')
    expect(Object.fromEntries(marker?.fields ?? [])).toEqual({
      valid_at: '2026-01-02',
      readwise: '01abc',
    })
  })

  it('ignores lines that carry no marker', () => {
    expect(parseWikiMarker('# a comment')).toBeNull()
    expect(parseWikiMarker('@note: not a marker kind')).toBeNull()
  })
})

describe('wikiMarkerHolds', () => {
  const marker = (line: string) => parseWikiMarker(line)!

  it('holds from valid_at until invalid_at, and a pass dates itself with at', () => {
    const anchor = marker('@anchor: doi:10.1/x | valid_at: 2026-01-02 | invalid_at: 2026-02-01')
    expect(wikiMarkerHolds(anchor, '2026-01-01')).toBe(false)
    expect(wikiMarkerHolds(anchor, '2026-01-02')).toBe(true)
    expect(wikiMarkerHolds(anchor, '2026-02-01')).toBe(false)
    expect(
      wikiMarkerHolds(marker('@pass: reviewer | status: verified | at: 2026-01-03'), '2026-01-03'),
    ).toBe(true)
  })

  it('never holds undated, or dated on a day the calendar lacks', () => {
    expect(wikiMarkerHolds(marker('@anchor: isbn:9780262035613'), '2030-01-01')).toBe(false)
    expect(
      wikiMarkerHolds(marker('@pass: reviewer | status: verified | at: 2026-02-31'), '2026-03-01'),
    ).toBe(false)
  })
})

describe('wikiSourceUrl / wikiSourceLabel', () => {
  it('links each anchor type and names it briefly', () => {
    expect(wikiSourceUrl('doi', '10.1126/science.185.4157.1124')).toBe(
      'https://doi.org/10.1126/science.185.4157.1124',
    )
    expect(wikiSourceUrl('arxiv', '2501.13956')).toBe('https://arxiv.org/abs/2501.13956')
    expect(wikiSourceUrl('s2', 'abc')).toBe('https://www.semanticscholar.org/paper/abc')
    expect(wikiSourceUrl('isbn', '978-0-262-03561-3')).toBe(
      'https://openlibrary.org/isbn/9780262035613',
    )
    expect(wikiSourceUrl('url', 'https://en.wikipedia.org/wiki/X')).toBe(
      'https://en.wikipedia.org/wiki/X',
    )
    expect(wikiSourceUrl('url', 'not a link')).toBeNull()

    expect(wikiSourceLabel('arxiv', '2501.13956')).toBe('arXiv 2501.13956')
    expect(wikiSourceLabel('url', 'https://www.example.org/a')).toBe('example.org')
    expect(wikiSourceLabel('gist', 'https://gist.github.com/karpathy/1')).toBe('gist.github.com')
  })
})

describe('readWikiAnchorsBlock', () => {
  it('lists the sources and reviews of a block, keeping lapsed ones marked', () => {
    const block = readWikiAnchorsBlock(
      [
        '@anchor: arxiv:2501.13956 | valid_at: 2026-01-02 | invalid_at: 2026-02-01',
        '@anchor: url:https://en.wikipedia.org/wiki/Anchoring_effect | valid_at: 2026-01-02 | readwise: 01kk',
        '@pass: reviewer | status: flagged | at: 2026-01-03',
        '@cite: [[Related Concept]] | valid_at: 2026-01-02',
      ].join('\n'),
      '2026-03-01',
    )

    expect(block).toEqual({
      sources: [
        {
          type: 'arxiv',
          id: '2501.13956',
          label: 'arXiv 2501.13956',
          url: 'https://arxiv.org/abs/2501.13956',
          readwiseUrl: null,
          current: false,
          validAt: '2026-01-02',
          invalidAt: '2026-02-01',
        },
        {
          type: 'url',
          id: 'https://en.wikipedia.org/wiki/Anchoring_effect',
          label: 'en.wikipedia.org',
          url: 'https://en.wikipedia.org/wiki/Anchoring_effect',
          readwiseUrl: 'https://read.readwise.io/read/01kk',
          current: true,
          validAt: '2026-01-02',
          invalidAt: null,
        },
      ],
      passes: [{ agent: 'reviewer', status: 'flagged', at: '2026-01-03', current: true }],
      citations: [
        {
          target: 'Related Concept',
          label: 'Related Concept',
          validAt: '2026-01-02',
          current: true,
        },
      ],
      unparsed: [],
    })
  })
})

describe('wiki citation evidence', () => {
  it('accepts and preserves a review reference without flagging valid evidence', () => {
    const block = readWikiAnchorsBlock(
      '@pass: reviewer | status: verified | at: 2026-01-02 | ref: Review Note',
      '2026-03-01',
    )
    expect(block.unparsed).toEqual([])
    expect(block.passes[0]).toMatchObject({ current: true, ref: 'Review Note' })
  })

  it('requires a same-line metadata comment, including its surrounding whitespace', () => {
    const json = '{"metadata":{"citation":{"valid_at":"2026-01-02"}}}'
    expect(readWikiCitationComment(`<!-- ${json} -->`)).toEqual({ validAt: '2026-01-02' })
    for (const newline of ['\n', '\r', '\r\n']) {
      expect(readWikiCitationComment(`<!--${newline}${json} -->`)).toBeNull()
      expect(readWikiCitationComment(`<!-- ${json}${newline}-->`)).toBeNull()
      expect(readWikiCitationComment(`<!-- ${json.replace(':', `:${newline}`)} -->`)).toBeNull()
    }
  })

  it('validates explicit dates and preserves generic metadata siblings', () => {
    expect(
      readWikiCitationMetadata({
        citation: { valid_at: '2026-01-02', invalid_at: '2026-02-01' },
        other: 1,
      }),
    ).toEqual({ validAt: '2026-01-02', invalidAt: '2026-02-01' })
    for (const citation of [
      {},
      { valid_at: '2026-02-31' },
      { valid_at: 20260102 },
      { valid_at: '2026-01-02', unknown: true },
      { valid_at: '2026-01-02', invalid_at: '2026-01-02' },
    ]) {
      expect(readWikiCitationMetadata({ citation })).toBeNull()
    }
  })

  it('folds complete cite-only paragraphs while keeping stable note and claim targets', () => {
    const block = readWikiCitationParagraph(
      [
        '@cite: [[First#^c2|label]] | valid_at: 2026-01-02',
        '@cite: [[Second | another label]] | valid_at: 2026-01-02 | invalid_at: 2026-02-01',
      ].join('\n'),
      '2026-03-01',
    )
    expect(block?.citations).toEqual([
      { target: 'First#^c2', label: 'First#^c2', validAt: '2026-01-02', current: true },
      {
        target: 'Second',
        label: 'Second',
        validAt: '2026-01-02',
        invalidAt: '2026-02-01',
        current: false,
      },
    ])
  })

  it('does not fold malformed, future-dated, or mixed-prose citation paragraphs', () => {
    for (const text of [
      '',
      '@cite: [[Topic]]',
      '@cite: [[Topic]] | valid_at: 2026-02-31',
      '@cite: [[Topic]] | valid_at: 2027-01-02',
      '@cite: [[Topic]] | valid_at: 2026-01-02 | reason: a qualification',
      '@cite: [[Topic]] | valid_at: 2026-01-02\nThis qualification matters.',
      '@cite: [[Topic]] | valid_at: 2026-01-02 | valid_at: 2026-01-03',
    ]) {
      expect(readWikiCitationParagraph(text, '2026-03-01')).toBeNull()
    }
  })

  it('retains unrecognized and malformed anchor lines for visible inspection', () => {
    const raw = [
      'Some qualification',
      '@anchor: doi:',
      '@pass: reviewer | status: verified | at: wrong',
    ]
    expect(readWikiAnchorsBlock(raw.join('\n'), '2026-03-01').unparsed).toEqual(raw)
  })
})

describe('readWikiAnchorsBlock placeholders', () => {
  it('lists no source for an anchor without an id', () => {
    expect(
      readWikiAnchorsBlock('@anchor: doi: | valid_at: 2026-01-01', '2026-03-01').sources,
    ).toEqual([])
  })
})

describe('wikiSourceKey', () => {
  it('merges ids that ignore case and keeps a URL path as written', () => {
    expect(wikiSourceKey('DOI:10.1037/ABC')).toBe(wikiSourceKey('doi:10.1037/abc'))
    expect(wikiSourceKey('url:https://Example.org/Paper')).toBe(
      wikiSourceKey('url:https://example.org/Paper'),
    )
    expect(wikiSourceKey('url:https://example.org/Paper')).not.toBe(
      wikiSourceKey('url:https://example.org/paper'),
    )
  })
})
