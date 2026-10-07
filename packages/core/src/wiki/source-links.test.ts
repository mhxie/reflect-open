import { expect, it } from 'vitest'
import { readWikiAnchorsBlock } from './anchors.ts'
import { readWikiSourceLinks } from './source-links.ts'

const raw = [
  '@anchor: url:https://example.org/old | valid_at: 2020-01-01 | invalid_at: 2020-02-01',
  '@anchor: url:https://example.org/a | valid_at: 2020-01-01',
  '@anchor: url:https://example.org/b | valid_at: 2020-01-01',
].join('\n')
const block = readWikiAnchorsBlock(raw, '2026-01-01')

it('groups exact current sources and preserves author/page labels and the original records', () => {
  const text =
    'A supported claim. [Author A, pp1–2](https://example.org/a); [Author B, p3](https://example.org/b).'
  const cluster = readWikiSourceLinks(text, block)
  expect(cluster).not.toBeNull()
  expect(text.slice(0, cluster!.from)).toBe('A supported claim.')
  expect(cluster!.to).toBe(text.length)
  expect(cluster!.block.sources.map((source) => source.label)).toEqual([
    'example.org',
    'Author A, pp1–2',
    'Author B, p3',
  ])
  expect(block.sources.every((source) => source.label === 'example.org')).toBe(true)
  expect(cluster!.block.sources[0]).toBe(block.sources[0])
})

it.each([
  'Read [Author A](https://example.org/a).',
  'Claim. [Author A](https://example.org/a) disagrees.',
  'Claim. [Old source](https://example.org/old).',
  'Claim. [Author A](https://example.org/a); [Unmatched](https://example.org/unknown).',
  'Claim. `[Author A](https://example.org/a)`.',
  'Claim. *[Author A](https://example.org/a)*.',
  'Claim. ![Image](https://example.org/a).',
  'Claim. [[Topic]].',
  'Claim. [Author A][source].',
  'Claim. [Author A](https://example.org/a#page=2).',
  'Claim. [Report](https://example.org/a "pp. 12–14; preliminary result").',
])('keeps ambiguous or unmatched source text visible: %s', (text) => {
  expect(readWikiSourceLinks(text, block)).toBeNull()
})

it('keeps all locators when one source is cited twice', () => {
  const cluster = readWikiSourceLinks(
    'Claim. [p1](https://example.org/a); [p2](https://example.org/a).',
    block,
  )
  expect(cluster?.block.sources[1]?.label).toBe('p1; p2')
})
