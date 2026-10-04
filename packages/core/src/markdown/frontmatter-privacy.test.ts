import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseNote } from './extract.ts'
import { lineScanPrivate, type FrontmatterPrivacy } from './frontmatter-privacy.ts'
import { frontmatterPrivacy } from './frontmatter.ts'

/**
 * The TS side of the shared privacy corpus (`fixtures/frontmatter-privacy.json`).
 * The Rust classifier (`crates/frontmatter/tests/corpus.rs`) asserts the same
 * cases, so the two implementations can't drift apart.
 */

const corpusFile = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'fixtures',
  'frontmatter-privacy.json',
)

const expectationSchema = z.object({
  privacy: z.enum(['public', 'private', 'unreadable']),
  reason: z
    .enum([
      'parseFailed',
      'notAMapping',
      'multipleDocuments',
      'aliasBudget',
      'tooLarge',
      'unrecognizedValue',
      'bomBeforeFence',
    ])
    .optional(),
})

const corpusSchema = z.object({
  cases: z.array(
    expectationSchema.extend({
      name: z.string(),
      source: z.string(),
      rust: expectationSchema.optional(),
      ts: expectationSchema.optional(),
      why: z.string().optional(),
    }),
  ),
})

type CorpusCase = z.infer<typeof corpusSchema>['cases'][number]

const corpus = corpusSchema.parse(JSON.parse(readFileSync(corpusFile, 'utf8')))

/** One side's expectation for a case: its override when the case has one. */
function expectation(entry: CorpusCase, side: 'rust' | 'ts'): FrontmatterPrivacy {
  const { privacy, reason } = entry[side] ?? entry
  if (privacy !== 'unreadable') {
    return { kind: privacy }
  }
  if (reason === undefined) {
    throw new Error(`${entry.name}: an unreadable expectation needs a reason`)
  }
  return { kind: 'unreadable', reason }
}

describe('frontmatter privacy corpus (shared with the Rust classifier)', () => {
  it('has the cases the spec pins', () => {
    expect(corpus.cases.length).toBeGreaterThan(50)
  })

  it.each(corpus.cases.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const want = expectation(entry, 'ts')
    expect(frontmatterPrivacy(entry.source)).toEqual(want)
    // Every consumer reads the withheld bit off the parsed note.
    const parsed = parseNote({ path: 'notes/case.md', source: entry.source })
    expect(parsed.frontmatterPrivacy).toEqual(want)
    expect(parsed.frontmatter.private).toBe(want.kind !== 'public')
  })

  it('never lets the two sides disagree on whether a note is withheld', () => {
    for (const entry of corpus.cases) {
      const withheld = (side: 'rust' | 'ts'): boolean => expectation(entry, side).kind !== 'public'
      expect(withheld('ts'), entry.name).toBe(withheld('rust'))
      if (entry.rust !== undefined || entry.ts !== undefined) {
        expect(entry.why, `${entry.name}: an override needs a why`).toMatch(/\S/)
      }
    }
  })
})

describe('one-sided parser divergences', () => {
  // Where the two YAML parsers disagree on whether a block loads, the sides
  // disagree on withholding it, so the shared corpus can't list the case; each
  // side pins its own verdict (`fixtures/parity/README.txt`).
  it('pins the TS verdict where the parsers disagree on loading a block', () => {
    // saphyr rejects a tab after ':' and withholds this block; yaml reads `false`.
    expect(frontmatterPrivacy('---\nprivate:\tfalse\n---\n')).toEqual({ kind: 'public' })
    // yaml's YAML 1.1 mode calls `yes` and `true` the same key; saphyr doesn't.
    expect(
      frontmatterPrivacy('---\n%YAML 1.1\n--- #c\nyes: 1\ntrue: 2\nprivate: false\n---\n'),
    ).toEqual({ kind: 'unreadable', reason: 'parseFailed' })
  })
})

describe('frontmatter privacy budgets', () => {
  it('never parses a block over 256 KiB, reading it by line scan alone', () => {
    const padding = '# padding\n'.repeat(26_215)
    const block = (text: string): string => `---\n${text}\n${padding}---\nbody\n`
    expect(frontmatterPrivacy(block('private: false'))).toEqual({
      kind: 'unreadable',
      reason: 'tooLarge',
    })
    expect(frontmatterPrivacy(block('private: true'))).toEqual({ kind: 'private' })
    expect(frontmatterPrivacy(block('title: x'))).toEqual({ kind: 'public' })
  })

  it('counts UTF-8 bytes, not UTF-16 code units, toward the 256 KiB limit', () => {
    // 100,000 three-byte characters: 300,000 bytes, though only 100,000 units.
    const wide = `private: false\nnote: "${'あ'.repeat(100_000)}"`
    expect(frontmatterPrivacy(`---\n${wide}\n---\n`)).toEqual({
      kind: 'unreadable',
      reason: 'tooLarge',
    })
  })
})

describe('lineScanPrivate', () => {
  it('reads column-0 private lines with a truthy value', () => {
    for (const line of [
      'private: true',
      'private:\ttrue',
      'private:true',
      'private : yes',
      '"private": on',
      "'private': 1",
      '!x private: !!bool yes',
      '&k private: &v TRUE # locked',
      'private: 1.0',
      'private: 0x1',
      'private: "true" # c',
    ]) {
      expect(lineScanPrivate(line), line).toBe(true)
    }
  })

  it('ignores indented, commented, falsy, and unrecognized lines', () => {
    for (const line of [
      ' private: true',
      '# private: true',
      '- private: true',
      '{private: true}',
      'private: false',
      'private: y',
      'private: "1.0"',
      'private: *t',
      'private: #true',
      'privateer: true',
      String.raw`private: "tr\x75e"`,
      'private: !!bool',
    ]) {
      expect(lineScanPrivate(line), line).toBe(false)
    }
    expect(lineScanPrivate('title: x\r\nprivate: true\r\n')).toBe(true)
    expect(lineScanPrivate('title: x\rprivate: true')).toBe(true)
  })
})
