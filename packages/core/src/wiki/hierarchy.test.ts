import { describe, expect, it } from 'vitest'
import {
  buildWikiIndexTree,
  isWikiIndex,
  isWikiIndexPath,
  visibleWikiIndexRows,
  wikiAncestorIndexPaths,
  type WikiIndexNode,
} from './hierarchy.ts'
import { DEFAULT_WIKI_LANGUAGES, normalizeWikiLanguages } from './languages.ts'
import type { WikiEntry } from './list.ts'

const LANGUAGES = DEFAULT_WIKI_LANGUAGES

function entry(path: string, claims: number | null = 0): WikiEntry {
  return {
    path,
    title: path,
    topic: null,
    mtime: 0,
    isPrivate: false,
    hasConflict: false,
    state: claims === null ? 'evicted' : 'local',
    preview: null,
    revised: null,
    translations: new Map(),
    citedBy: 0,
    tags: [],
    summary:
      claims === null
        ? null
        : {
            preview: null,
            claims,
            unsourcedClaims: 0,
            sources: 0,
            verifiedClaims: 0,
            flaggedClaims: 0,
            lastRevised: null,
          },
  }
}

/** The tree as nested `[key, children]` pairs, for readable assertions. */
function shape(nodes: readonly WikiIndexNode[]): unknown[] {
  return nodes.map((node) =>
    node.children.length === 0 ? node.key : [node.key, shape(node.children)],
  )
}

describe('isWikiIndex', () => {
  it('reads the role from the file name alone', () => {
    expect(isWikiIndexPath('wiki/index.md')).toBe(true)
    expect(isWikiIndexPath('index.md')).toBe(true)
    expect(isWikiIndexPath('wiki/topic/Index.md')).toBe(false)
    expect(isWikiIndexPath('wiki/reindex.md')).toBe(false)
    expect(isWikiIndexPath('wiki/index.md/Note.md')).toBe(false)

    // Claims and an unread file change nothing.
    expect(isWikiIndex(entry('wiki/topic/index.md', 4))).toBe(true)
    expect(isWikiIndex(entry('wiki/topic/index.md', null))).toBe(true)
    expect(isWikiIndex(entry('wiki/topic/Guide.md', 0))).toBe(false)
  })
})

describe('wikiAncestorIndexPaths', () => {
  it('lists every enclosing folder’s index, nearest first, up to the language root', () => {
    expect(wikiAncestorIndexPaths('wiki/topic/sub/Note.md', LANGUAGES)).toEqual([
      'wiki/topic/sub/index.md',
      'wiki/topic/index.md',
      'wiki/index.md',
    ])
    expect(wikiAncestorIndexPaths('wiki/Note.md', LANGUAGES)).toEqual(['wiki/index.md'])
  })

  it('starts an index from its parent folder, and gives the root index none', () => {
    expect(wikiAncestorIndexPaths('wiki/topic/sub/index.md', LANGUAGES)).toEqual([
      'wiki/topic/index.md',
      'wiki/index.md',
    ])
    expect(wikiAncestorIndexPaths('wiki/index.md', LANGUAGES)).toEqual([])
  })

  it('compares whole folder names', () => {
    expect(wikiAncestorIndexPaths('wiki/topic-a/Note.md', LANGUAGES)).toEqual([
      'wiki/topic-a/index.md',
      'wiki/index.md',
    ])
  })

  it('stays inside the note’s own language folder', () => {
    expect(wikiAncestorIndexPaths('wiki-cn/topic/Note.md', LANGUAGES)).toEqual([
      'wiki-cn/topic/index.md',
      'wiki-cn/index.md',
    ])
    const nested = normalizeWikiLanguages([{ label: 'English', folder: 'kb/wiki' }])
    expect(wikiAncestorIndexPaths('kb/wiki/topic/Note.md', nested)).toEqual([
      'kb/wiki/topic/index.md',
      'kb/wiki/index.md',
    ])
  })

  it('is empty outside the wiki', () => {
    expect(wikiAncestorIndexPaths('notes/Note.md', LANGUAGES)).toEqual([])
    expect(wikiAncestorIndexPaths('wikis/Note.md', LANGUAGES)).toEqual([])
  })
})

describe('buildWikiIndexTree', () => {
  it('nests each entry under its nearest listed ancestor index, keeping sibling order', () => {
    const tree = buildWikiIndexTree(
      [
        entry('wiki/zeta/index.md'),
        entry('wiki/index.md'),
        entry('wiki/topic/sub/index.md'),
        entry('wiki/topic-a/index.md'),
        entry('wiki/topic/index.md'),
        // No index in `deep/` or `deep/a/`: it belongs to the root.
        entry('wiki/deep/a/b/index.md'),
      ],
      LANGUAGES,
    )

    expect(shape(tree)).toEqual([
      [
        'index.md',
        [
          'zeta/index.md',
          'topic-a/index.md',
          // Listed before its parent, it still lands under it.
          ['topic/index.md', ['topic/sub/index.md']],
          'deep/a/b/index.md',
        ],
      ],
    ])
  })

  it('puts entries without a listed ancestor at the top', () => {
    const tree = buildWikiIndexTree(
      [entry('wiki/topic/index.md'), entry('wiki/other/index.md'), entry('wiki/topic/x/index.md')],
      LANGUAGES,
    )

    expect(shape(tree)).toEqual([['topic/index.md', ['topic/x/index.md']], 'other/index.md'])
  })

  it('places entries listed in a translation by their shared relative path', () => {
    const tree = buildWikiIndexTree(
      [entry('wiki-cn/index.md'), entry('wiki/topic/index.md')],
      LANGUAGES,
    )

    expect(shape(tree)).toEqual([['index.md', ['topic/index.md']]])
    expect(tree[0]?.entry.path).toBe('wiki-cn/index.md')
  })
})

describe('visibleWikiIndexRows', () => {
  const tree = buildWikiIndexTree(
    [
      entry('wiki/index.md'),
      entry('wiki/topic/index.md'),
      entry('wiki/topic/sub/index.md'),
      entry('wiki/other/index.md'),
    ],
    LANGUAGES,
  )

  it('lists each parent before its children, with depth and expansion', () => {
    expect(
      visibleWikiIndexRows(tree, new Set()).map(({ key, depth, hasChildren, expanded }) => [
        key,
        depth,
        hasChildren,
        expanded,
      ]),
    ).toEqual([
      ['index.md', 0, true, true],
      ['topic/index.md', 1, true, true],
      ['topic/sub/index.md', 2, false, false],
      ['other/index.md', 1, false, false],
    ])
  })

  it('hides everything under a collapsed row', () => {
    expect(
      visibleWikiIndexRows(tree, new Set(['topic/index.md'])).map(({ key, expanded }) => [
        key,
        expanded,
      ]),
    ).toEqual([
      ['index.md', true],
      ['topic/index.md', false],
      ['other/index.md', false],
    ])
    expect(visibleWikiIndexRows(tree, new Set(['index.md'])).map((row) => row.key)).toEqual([
      'index.md',
    ])
  })
})
