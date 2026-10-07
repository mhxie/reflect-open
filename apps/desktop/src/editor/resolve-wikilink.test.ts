import { describe, expect, it } from 'vitest'
import { resolveWikilink } from './resolve-wikilink.ts'

describe('resolveWikilink', () => {
  it('splits an alias at the first pipe, trimming both halves', () => {
    expect(resolveWikilink({ target: 'Tim MacCaw // Dad|Dad' })).toEqual({
      target: 'Tim MacCaw // Dad',
      display: 'Dad',
    })
    expect(resolveWikilink({ target: 'a | b | c' })).toEqual({ target: 'a', display: 'b | c' })
  })

  it('falls back to the display title for a blank alias', () => {
    expect(resolveWikilink({ target: 'Note|' })).toEqual({ target: 'Note', display: 'Note' })
    expect(resolveWikilink({ target: 'Tim MacCaw // Dad| ' })).toEqual({
      target: 'Tim MacCaw // Dad',
      display: 'Tim MacCaw',
    })
  })

  it('shows a bare `//` target by its first segment', () => {
    expect(resolveWikilink({ target: 'Tim MacCaw // Dad' })).toEqual({
      target: 'Tim MacCaw // Dad',
      display: 'Tim MacCaw',
    })
    expect(resolveWikilink({ target: '// Dad' })).toEqual({ target: '// Dad', display: 'Dad' })
  })

  it('leaves a plain target and a URL-shaped target alone', () => {
    expect(resolveWikilink({ target: 'Note' })).toBeUndefined()
    expect(resolveWikilink({ target: 'https://reflect.app' })).toBeUndefined()
  })

  it('renders reserved ref aliases as evidence only with validated citation metadata', () => {
    expect(
      resolveWikilink({
        target: 'Source#^c2|ref',
        metadata: { citation: { valid_at: '2020-01-02', invalid_at: '2020-02-01' } },
      }),
    ).toEqual({
      target: 'Source#^c2',
      display: 'Source#^c2',
      appearance: 'reference',
      description: 'Evidence recorded 2020-01-02; invalidated 2020-02-01',
    })
    for (const metadata of [
      undefined,
      {},
      { citation: {} },
      { citation: { valid_at: '9999-01-02' } },
      { citation: { valid_at: '2020-02-31' } },
      { citation: { valid_at: '2020-01-02', extra: 'unknown' } },
    ]) {
      expect(
        resolveWikilink({
          target: 'Source#^c2|ref',
          ...(metadata === undefined ? {} : { metadata }),
        }),
      ).toEqual({ target: 'Source#^c2', display: 'ref' })
    }
    expect(
      resolveWikilink({
        target: 'Source|topic',
        metadata: { citation: { valid_at: '2020-01-02' } },
      }),
    ).toEqual({ target: 'Source', display: 'topic' })
  })

  it('keeps malformed citation targets as ordinary visible links', () => {
    for (const target of ['', '   ', '#^c2', 'Note#Heading', 'Note#^c0', 'Note#^c2#extra']) {
      expect(
        resolveWikilink({
          target: `${target}|ref`,
          metadata: { citation: { valid_at: '2020-01-02' } },
        }),
      ).toEqual({ target: target.trim(), display: 'ref' })
    }
  })
})
