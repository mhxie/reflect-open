import { describe, expect, it } from 'vitest'
import {
  frontmatterPrivacy,
  parseFrontmatter,
  splitFrontmatter,
  upsertFrontmatter,
} from './frontmatter.ts'
import { isPinned, pinnedOrder } from './model.ts'

describe('splitFrontmatter', () => {
  it('returns the whole file as body when there is no frontmatter', () => {
    const split = splitFrontmatter('# Hello\n\nworld')
    expect(split).toEqual({ raw: null, body: '# Hello\n\nworld', bodyOffset: 0 })
  })

  it('carves a leading block and reports the body offset', () => {
    const source = '---\nid: x\n---\nbody'
    const split = splitFrontmatter(source)
    expect(split.raw).toBe('id: x')
    expect(split.body).toBe('body')
    expect(source.slice(split.bodyOffset)).toBe('body')
  })

  it('handles an empty frontmatter block', () => {
    expect(splitFrontmatter('---\n---\nbody').body).toBe('body')
  })

  it('treats an unterminated fence as plain body (tolerant)', () => {
    const source = '---\nid: x\nno closing fence'
    expect(splitFrontmatter(source)).toEqual({ raw: null, body: source, bodyOffset: 0 })
  })

  it.each([
    ['---\nid: x\n---\n# T\n', '# T\n'],
    ['---\nid: x\n---\n\n# T\n', '# T\n'],
    ['---\nid: x\n---\n\n\n# T\n', '\n# T\n'],
    ['---\nid: x\n---\n  \n# T\n', '# T\n'],
    ['---\n---\n\n# T\n', '# T\n'],
    ['\n# T\n', '\n# T\n'],
  ])('reads one blank line after the block as its separator: %j', (source, body) => {
    const split = splitFrontmatter(source)
    expect(split.body).toBe(body)
    expect(source.slice(split.bodyOffset)).toBe(body)
  })
})

describe('parseFrontmatter', () => {
  it('types the known subset and passes through unknown keys', () => {
    const { data } = parseFrontmatter('id: abc\ncustom: hello\naliases:\n  - a\n  - b')
    expect(data.id).toBe('abc')
    expect(data.aliases).toEqual(['a', 'b'])
    expect(data.private).toBe(false)
    expect((data as Record<string, unknown>)['custom']).toBe('hello')
  })

  it('degrades broken YAML to defaults + a warning, never throwing', () => {
    const { data, warning } = parseFrontmatter('foo: [unclosed')
    expect(warning).toMatch(/invalid YAML/i)
    expect(data).toEqual({ aliases: [], private: false, pinned: false, ignoredContacts: [] })
  })

  it('treats non-mapping frontmatter as ignored + a warning', () => {
    const { warning } = parseFrontmatter('just a bare string')
    expect(warning).toMatch(/not a mapping/i)
  })

  it('reads a block of only comments, or a bare null, as empty frontmatter', () => {
    for (const raw of ['# private: true', '--- # private: true', '~ # private: true']) {
      const { data, warning, privacy } = parseFrontmatter(raw)
      expect(warning, raw).toBeUndefined()
      expect(privacy, raw).toEqual({ kind: 'public' })
      expect(data, raw).toEqual({ aliases: [], private: false, pinned: false, ignoredContacts: [] })
    }
  })

  it('reads nothing from a block holding a character the Rust reader would read differently', () => {
    for (const raw of [
      'title: x\0',
      '\u{FEFF}title: x',
      'title: x\rpinned: true',
      'title: x\u{7}',
    ]) {
      const { data, warning } = parseFrontmatter(raw)
      expect(warning, JSON.stringify(raw)).toMatch(/control character/)
      expect(data.title, JSON.stringify(raw)).toBeUndefined()
    }
    expect(parseFrontmatter('title: x\r\npinned: true').data.pinned).toBe(true)
  })

  it('reads every block as YAML 1.2, whatever its %YAML directive says', () => {
    // YAML 1.1 would make `yes` a boolean, which no string field accepts.
    expect(parseFrontmatter('%YAML 1.1\n--- #c\ntitle: yes').data.title).toBe('yes')
    expect(parseFrontmatter('%YAML 1.1\n--- #c\nyes: 1\ntrue: 2').warning).toBeUndefined()
  })

  it('reads the private flag fail-closed: an unrecognized value counts as private', () => {
    expect(parseFrontmatter('private: true').data.private).toBe(true)
    expect(parseFrontmatter('private: yes').data.private).toBe(true)
    expect(parseFrontmatter('private: false').data.private).toBe(false)
    expect(parseFrontmatter('private: no').data.private).toBe(false)
    expect(parseFrontmatter('id: x').data.private).toBe(false)
    const banana = parseFrontmatter('private: banana')
    expect(banana.privacy).toEqual({ kind: 'unreadable', reason: 'unrecognizedValue' })
    expect(banana.data.private).toBe(true)
    expect(banana.warning).toBeUndefined()
  })

  it('keeps private: true next to a malformed field, with a warning', () => {
    const { data, warning, privacy } = parseFrontmatter('private: true\ntitle: [unclosed')
    expect(privacy).toEqual({ kind: 'private' })
    expect(data.private).toBe(true)
    expect(warning).toMatch(/invalid YAML/i)
  })

  it('treats malformed YAML that mentions private as unreadable, and otherwise as public', () => {
    // Even `private: no`: the block can't be read, so its value can't be trusted.
    const unreadable = parseFrontmatter('private: no\ntitle: [unclosed')
    expect(unreadable.privacy).toEqual({ kind: 'unreadable', reason: 'parseFailed' })
    expect(unreadable.data.private).toBe(true)
    // A backslash could spell the key with an escape.
    expect(parseFrontmatter('title: "\\u0070"\ntags: [unclosed').data.private).toBe(true)
    expect(parseFrontmatter('title: [unclosed').data.private).toBe(false)
    expect(parseFrontmatter('just a bare string').data.private).toBe(false)
  })

  it('leaves a valid block that never mentions private untouched', () => {
    const { data, warning, privacy } = parseFrontmatter('title: Plain\naliases: [a]')
    expect(privacy).toEqual({ kind: 'public' })
    expect(warning).toBeUndefined()
    expect(data.private).toBe(false)
    expect(data.aliases).toEqual(['a'])
  })

  it('reads nothing from a block a second document or a repeated key makes unreadable', () => {
    expect(parseFrontmatter('title: First\n--- second').data).toEqual({
      aliases: [],
      private: false,
      pinned: false,
      ignoredContacts: [],
    })
    expect(parseFrontmatter('title: A\ntitle: B').warning).toMatch(/invalid YAML/i)
  })

  it('coerces the pinned value: booleans, truthy words, numbers as explicit order', () => {
    expect(parseFrontmatter('pinned: true').data.pinned).toBe(true)
    expect(parseFrontmatter('pinned: yes').data.pinned).toBe(true)
    expect(parseFrontmatter('pinned: false').data.pinned).toBe(false)
    expect(parseFrontmatter('pinned: banana').data.pinned).toBe(false)
    expect(parseFrontmatter('id: x').data.pinned).toBe(false)
    expect(parseFrontmatter('pinned: 2').data.pinned).toBe(2)
    expect(parseFrontmatter('pinned: 1.5').data.pinned).toBe(1.5)
    expect(parseFrontmatter('pinned: .nan').data.pinned).toBe(false)
  })

  it('reads the ignored-contacts list; junk degrades to empty', () => {
    expect(
      parseFrontmatter('ignoredContacts:\n  - Ada Lovelace\n  - Grace Hopper').data.ignoredContacts,
    ).toEqual(['Ada Lovelace', 'Grace Hopper'])
    expect(parseFrontmatter('ignoredContacts: banana').data.ignoredContacts).toEqual([])
    expect(parseFrontmatter('ignoredContacts:\n  - 42').data.ignoredContacts).toEqual([])
    expect(parseFrontmatter('id: x').data.ignoredContacts).toEqual([])
  })

  it('isPinned/pinnedOrder read the pin value — `pinned: 0` is order 0, pinned', () => {
    expect(isPinned(parseFrontmatter('pinned: 0').data)).toBe(true)
    expect(pinnedOrder(parseFrontmatter('pinned: 0').data)).toBe(0)
    expect(isPinned(parseFrontmatter('pinned: true').data)).toBe(true)
    expect(pinnedOrder(parseFrontmatter('pinned: true').data)).toBeNull()
    expect(isPinned(parseFrontmatter('id: x').data)).toBe(false)
    expect(pinnedOrder(parseFrontmatter('id: x').data)).toBeNull()
  })
})

describe('upsertFrontmatter', () => {
  it('creates a block when none exists', () => {
    expect(upsertFrontmatter('# Body', { id: 'x' })).toBe('---\nid: x\n---\n\n# Body')
  })

  it('updates a key while preserving unknown keys and the body byte-for-byte', () => {
    const source = '---\nid: x\ncustom: keep\n---\n# Body\n\ntext'
    const result = upsertFrontmatter(source, { private: true })
    expect(result).toContain('custom: keep')
    expect(result).toContain('private: true')
    expect(result.endsWith('# Body\n\ntext')).toBe(true)
  })

  it('is a byte-identical no-op for an empty patch (never re-serializes)', () => {
    const source = '---\nid: x # keep this comment\ncustom: keep\n---\n# Body'
    expect(upsertFrontmatter(source, {})).toBe(source)
  })

  it('patches a block hidden behind a byte-order mark and drops the mark', () => {
    // A new block in front would leave the old one, `private` and all, as body.
    const pinned = upsertFrontmatter('\u{FEFF}---\nprivate: true\n---\nbody', { pinned: true })
    expect(pinned).toBe('---\nprivate: true\npinned: true\n---\n\nbody')
    expect(frontmatterPrivacy(pinned)).toEqual({ kind: 'private' })
    // So a note whose only block hides there can be locked.
    const locked = upsertFrontmatter('\u{FEFF}---\ntitle: Diary\n---\n\nsecret', {
      private: true,
    })
    expect(locked).toBe('---\ntitle: Diary\nprivate: true\n---\n\nsecret')
    expect(frontmatterPrivacy(locked)).toEqual({ kind: 'private' })
    // A mark with no block behind it keeps the usual behavior.
    expect(upsertFrontmatter('\u{FEFF}# Body', { id: 'x' })).toBe(
      '---\nid: x\n---\n\n\u{FEFF}# Body',
    )
  })

  it('writes the block with the CRLF line endings the document uses', () => {
    const locked = upsertFrontmatter('---\r\ntitle: Diary\r\n---\r\n\r\nbody\r\n', {
      private: true,
    })
    expect(locked).toBe('---\r\ntitle: Diary\r\nprivate: true\r\n---\r\n\r\nbody\r\n')
    expect(splitFrontmatter(locked).body).toBe('body\r\n')
    expect(frontmatterPrivacy(locked)).toEqual({ kind: 'private' })
    expect(upsertFrontmatter('# Note\r\nbody\r\n', { private: true })).toBe(
      '---\r\nprivate: true\r\n---\r\n\r\n# Note\r\nbody\r\n',
    )
  })

  it('refuses to update invalid frontmatter rather than dropping bytes', () => {
    expect(() => upsertFrontmatter('---\nfoo: [unclosed\n---\nbody', { id: 'x' })).toThrow(
      /invalid YAML frontmatter/i,
    )
  })

  it('deletes a key when the patch value is undefined', () => {
    const source = '---\nid: x\ncustom: keep\n---\nbody'
    const result = upsertFrontmatter(source, { id: undefined })
    expect(result).not.toContain('id: x')
    expect(result).toContain('custom: keep')
  })

  it('removes the whole block when the last key is deleted', () => {
    expect(upsertFrontmatter('---\npinned: true\n---\n# Body', { pinned: undefined })).toBe(
      '# Body',
    )
  })

  it('does not create a block for a deletion-only patch', () => {
    expect(upsertFrontmatter('# Body', { pinned: undefined })).toBe('# Body')
  })

  it('deletes a missing key from an empty block without throwing', () => {
    expect(upsertFrontmatter('---\n---\n# T\n', { pinned: undefined })).toBe('# T\n')
  })

  it('keeps a body that opens with a blank line when it creates a block', () => {
    const patched = upsertFrontmatter('\n# T\n', { id: 'x' })
    expect(splitFrontmatter(patched).body).toBe('\n# T\n')
  })

  it('round-trips pin → unpin back to the original source', () => {
    const source = '# Body\n\ntext'
    const pinned = upsertFrontmatter(source, { pinned: true })
    expect(pinned).toBe('---\npinned: true\n---\n\n# Body\n\ntext')
    expect(upsertFrontmatter(pinned, { pinned: undefined })).toBe(source)
  })

  it('writes a nested mapping (the gist block) and round-trips it through the parser', () => {
    const gist = {
      id: 'g1',
      url: 'https://gist.github.com/alex/g1',
      file: 'A.md',
      hash: 'ab12cd34ef56ab78',
    }
    const next = upsertFrontmatter('# A\n\nbody', { gist })
    const split = splitFrontmatter(next)
    expect(split.body).toBe('# A\n\nbody')
    expect(parseFrontmatter(split.raw).data.gist).toEqual(gist)
  })

  it('replaces an existing gist block wholesale on republish', () => {
    const first = upsertFrontmatter('body', {
      gist: { id: 'g1', url: 'https://gist.github.com/alex/g1', file: 'Old.md', hash: 'h1' },
    })
    const second = upsertFrontmatter(first, {
      gist: { id: 'g1', url: 'https://gist.github.com/alex/g1', file: 'New.md', hash: 'h2' },
    })
    const { data } = parseFrontmatter(splitFrontmatter(second).raw)
    expect(data.gist).toEqual({
      id: 'g1',
      url: 'https://gist.github.com/alex/g1',
      file: 'New.md',
      hash: 'h2',
    })
    expect(second).not.toContain('Old.md')
  })
})

describe('frontmatter gist block', () => {
  it('parses a well-formed block', () => {
    const { data } = parseFrontmatter(
      'gist:\n  id: g1\n  url: https://gist.github.com/alex/g1\n  file: A.md\n  hash: ab12cd34ef56ab78',
    )
    expect(data.gist).toEqual({
      id: 'g1',
      url: 'https://gist.github.com/alex/g1',
      file: 'A.md',
      hash: 'ab12cd34ef56ab78',
    })
  })

  it('coerces all-digit ids and hashes a third-party rewrite may have unquoted', () => {
    const { data } = parseFrontmatter(
      'gist:\n  id: 12345678\n  url: https://gist.github.com/alex/g1\n  file: A.md\n  hash: 1234567812345678',
    )
    expect(data.gist?.id).toBe('12345678')
    expect(data.gist?.hash).toBe('1234567812345678')
  })

  it('rejects a non-http(s) gist url, degrading to "never published"', () => {
    expect(
      parseFrontmatter('gist:\n  id: g1\n  url: file:///etc/passwd\n  file: A.md\n  hash: h1').data
        .gist,
    ).toBeUndefined()
    expect(
      parseFrontmatter('gist:\n  id: g1\n  url: javascript:alert(1)\n  file: A.md\n  hash: h1').data
        .gist,
    ).toBeUndefined()
  })

  it('degrades a mangled block to "never published" without failing the note', () => {
    expect(parseFrontmatter('gist: not-an-object').data.gist).toBeUndefined()
    expect(parseFrontmatter('gist:\n  id: g1').data.gist).toBeUndefined()
  })
})

describe('frontmatterPrivacy', () => {
  it('classifies the block behind a byte-order mark, never as plainly private', () => {
    expect(frontmatterPrivacy('\u{FEFF}---\nprivate: true\n---\nbody')).toEqual({
      kind: 'unreadable',
      reason: 'bomBeforeFence',
    })
    expect(frontmatterPrivacy('\u{FEFF}---\ntitle: x\n---\nbody')).toEqual({ kind: 'public' })
    expect(frontmatterPrivacy('---\nprivate: true\n---\nbody')).toEqual({ kind: 'private' })
  })

  it('treats an unterminated fence as no frontmatter, like the split', () => {
    expect(frontmatterPrivacy('---\ntitle: Never closed\nmy private thoughts')).toEqual({
      kind: 'public',
    })
  })
})
