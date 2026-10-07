import { describe, expect, it } from 'vitest'
import { repointPathWikiLinks, retitleWikiLinks } from './retitle.ts'

/** Repoint only: the shape the pre-stable-display rewrite always used. */
function repointOnly(fromKey: string, to: string) {
  return { repoint: { fromKey, to }, display: null, subjectTargetKeys: new Set<string>() }
}

describe('retitleWikiLinks', () => {
  it('rewrites matching targets, preserves displays, skips code and non-matches', () => {
    const source = '[[Foo]] and [[foo|bar]] and `[[Foo]]` and [[Other]]'
    expect(retitleWikiLinks(source, repointOnly('foo', 'Baz'))).toBe(
      '[[Baz]] and [[Baz|bar]] and `[[Foo]]` and [[Other]]',
    )
  })

  it('is a byte-identical no-op when nothing matches', () => {
    const source = 'see [[Alpha]] and [[Beta]]'
    expect(retitleWikiLinks(source, repointOnly('gamma', 'Delta'))).toBe(source)
  })

  it('matches on the trimmed, case-folded target', () => {
    const source = '[[ Foo ]] and [[Foo]] and [[ foo|bar]]'
    expect(retitleWikiLinks(source, repointOnly('foo', 'Baz'))).toBe(
      '[[Baz]] and [[Baz]] and [[Baz|bar]]',
    )
  })

  it('rejects a destination target containing wiki-link syntax', () => {
    expect(() => retitleWikiLinks('[[Foo]]', repointOnly('foo', 'A|B'))).toThrow(
      /invalid wiki-link target/i,
    )
  })

  it('syncs only a display that exactly mirrors the old title', () => {
    const source = '[[stable|Old Title]] [[stable|Mum]] [[stable|old title]] [[stable]]'
    expect(
      retitleWikiLinks(source, {
        repoint: null,
        display: { from: 'Old Title', to: 'New Title' },
        subjectTargetKeys: new Set(['stable']),
      }),
    ).toBe('[[stable|New Title]] [[stable|Mum]] [[stable|old title]] [[stable]]')
  })

  it('leaves a mirroring display alone when its target is not the subject', () => {
    const source = '[[other|Old Title]]'
    expect(
      retitleWikiLinks(source, {
        repoint: null,
        display: { from: 'Old Title', to: 'New Title' },
        subjectTargetKeys: new Set(['stable']),
      }),
    ).toBe(source)
  })

  it('leaves every display alone when the new one is not writable', () => {
    const source = '[[stable|Old Title]]'
    expect(
      retitleWikiLinks(source, {
        repoint: null,
        display: null,
        subjectTargetKeys: new Set(['stable']),
      }),
    ).toBe(source)
  })

  it('repoints a target and syncs a stable display in one pass', () => {
    expect(
      retitleWikiLinks('[[Old Title]] and [[stable|Old Title]]\n', {
        repoint: { fromKey: 'old title', to: 'New Title' },
        display: { from: 'Old Title', to: 'New Title' },
        subjectTargetKeys: new Set(['old title', 'stable']),
      }),
    ).toBe('[[New Title]] and [[stable|New Title]]\n')
  })

  it('keeps an untouched target byte-identical when only the display changes', () => {
    expect(
      retitleWikiLinks('[[stable\\_addr|Old Title]]\n', {
        repoint: null,
        display: { from: 'Old Title', to: 'New Title' },
        subjectTargetKeys: new Set(['stable_addr']),
      }),
    ).toBe('[[stable\\_addr|New Title]]\n')
  })

  it('keeps display padding when only the target changes', () => {
    expect(retitleWikiLinks('[[Foo| bar ]]', repointOnly('foo', 'Baz'))).toBe('[[Baz| bar ]]')
  })

  it('renames a citation note target while preserving claim, ref alias, and metadata bytes', () => {
    const metadata = '<!-- {"metadata":{"citation":{"valid_at":"2026-01-02"}}} -->'
    const source = `[[Foo#^c2|ref]]${metadata}\n\n@cite: [[Foo#^c3]] | valid_at: 2026-01-02`
    expect(retitleWikiLinks(source, repointOnly('foo', 'Baz'))).toBe(
      `[[Baz#^c2|ref]]${metadata}\n\n@cite: [[Baz#^c3]] | valid_at: 2026-01-02`,
    )
  })

  it('does not create or remove a citation role while syncing a renamed title display', () => {
    const metadata = '<!-- {"metadata":{"citation":{"valid_at":"2020-01-02"}}} -->'
    for (const { from, to } of [
      { from: 'ref', to: 'New Title' },
      { from: 'Old Title', to: 'ref' },
    ]) {
      const source = `[[stable#^c2|${from}]]${metadata}`
      expect(
        retitleWikiLinks(source, {
          repoint: null,
          display: { from, to },
          subjectTargetKeys: new Set(['stable#^c2']),
        }),
      ).toBe(source)
    }
    expect(
      retitleWikiLinks(`[[ref#^c2|ref]]${metadata}`, {
        repoint: { fromKey: 'ref', to: 'New Title' },
        display: { from: 'ref', to: 'New Title' },
        subjectTargetKeys: new Set(['ref#^c2']),
      }),
    ).toBe(`[[New Title#^c2|ref]]${metadata}`)
    expect(
      retitleWikiLinks(`[[stable#^c2|Old Title]] ${metadata}`, {
        repoint: null,
        display: { from: 'Old Title', to: 'ref' },
        subjectTargetKeys: new Set(['stable#^c2']),
      }),
    ).toBe(`[[stable#^c2|ref]] ${metadata}`)
  })
})

describe('repointPathWikiLinks', () => {
  const options = { fromPathKey: 'notes/plan-2.md', to: 'notes/roadmap' }

  it('retargets a plain path link when the file moves', () => {
    expect(repointPathWikiLinks('See [[notes/plan-2]].', options)).toBe('See [[notes/roadmap]].')
  })

  it('keeps the display and the fragment byte-for-byte', () => {
    expect(repointPathWikiLinks('See [[notes/plan-2|The Plan]].', options)).toBe(
      'See [[notes/roadmap|The Plan]].',
    )
    expect(repointPathWikiLinks('See [[notes/plan-2#Next steps]].', options)).toBe(
      'See [[notes/roadmap#Next steps]].',
    )
  })

  it('matches the folded spelling, including a trailing .md and case', () => {
    expect(repointPathWikiLinks('See [[Notes/Plan-2.md]].', options)).toBe('See [[notes/roadmap]].')
  })

  it('leaves a same-stem link in another folder untouched', () => {
    const source = 'See [[archive/plan-2]] and [[plan-2]].'
    expect(repointPathWikiLinks(source, options)).toBe(source)
  })

  it('leaves markdown hrefs untouched', () => {
    const source = 'See [plan](notes/plan-2.md).'
    expect(repointPathWikiLinks(source, options)).toBe(source)
  })

  it.each([
    ['a fragment separator', 'notes/c#-notes'],
    ['a backslash', String.raw`notes\plan`],
    ['a loose slash segment that reads as a name', 'notes/a / b'],
    ['a bare name', 'plan'],
  ])('rejects a destination with %s', (_reason, to) => {
    expect(() => repointPathWikiLinks('x', { fromPathKey: 'notes/a.md', to })).toThrowError(
      /invalid wiki-link path target/,
    )
  })
})
