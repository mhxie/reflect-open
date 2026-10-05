import { describe, expect, it, vi } from 'vitest'
import { markdownToDoc } from '@meowdown/core'
import {
  readEmbeddedOutlineBlocks,
  readOutlineWithEmbeds,
  registerOutlineEmbed,
} from './outline-embeds.ts'
import { outlineHeadingsEqual } from './outline-headings.ts'

function reader(id: string, target: string, body: string, offset: number) {
  const root = document.createElement('div')
  root.dataset['noteEmbedOutline'] = id
  root.dataset['noteEmbedTarget'] = target
  const unregister = registerOutlineEmbed(root, {
    id,
    target,
    blocks: readEmbeddedOutlineBlocks(body, offset),
    element: () => null,
    reveal: vi.fn(),
  })
  return { root, unregister }
}

function outline(root: HTMLElement) {
  const doc = markdownToDoc('# Host\n\n![[Parent]]')
  const block = document.createElement('div')
  block.append(root)
  return readOutlineWithEmbeds(doc, (position) =>
    position === doc.firstChild!.nodeSize ? block : null,
  )
}

describe('embedded outline collection', () => {
  it('collects embeds inside quotes and lists at their source positions', () => {
    const parent = reader(
      'parent',
      'Parent',
      '# Parent\n\n> ![[Child]]\n\n## Between\n\n- ![[Other]]',
      1,
    )
    const child = reader('child', 'Child', '# Child\n\n## Chapter', 2)
    const other = reader('other', 'Other', '# Other', 2)
    parent.root.append(child.root, other.root)
    expect(outline(parent.root).map(({ text, level }) => [text, level])).toEqual([
      ['Parent', 2],
      ['Child', 3],
      ['Chapter', 4],
      ['Between', 3],
      ['Other', 3],
    ])
  })

  it('retains a loading repeated reader slot before an intervening chapter', () => {
    const parent = reader(
      'parent',
      'Parent',
      '# Parent\n\n![[Child]]\n\n## Between\n\n![[Child]]',
      1,
    )
    const loading = document.createElement('div')
    loading.dataset['noteEmbedOutline'] = 'loading'
    loading.dataset['noteEmbedTarget'] = 'Child'
    const ready = reader('second', 'Child', '# Child\n\n## Chapter', 2)
    parent.root.append(loading, ready.root)
    expect(outline(parent.root).map((heading) => heading.text)).toEqual([
      'Parent',
      'Between',
      'Child',
      'Chapter',
    ])
    expect(outline(parent.root)[2]?.embedded?.key).toBe('second:0')
  })

  it('retires only the registration that owns the mounted reader', () => {
    const parent = reader('parent', 'Parent', '# Old', 1)
    const remove = registerOutlineEmbed(parent.root, {
      id: 'new',
      target: 'Parent',
      blocks: readEmbeddedOutlineBlocks('# New', 1),
      element: () => null,
      reveal: vi.fn(),
    })
    parent.unregister()
    expect(outline(parent.root).map((heading) => heading.text)).toEqual(['New'])
    remove()
    expect(outline(parent.root)).toEqual([])
  })

  it('reads stable rows that reveal through the current registration', () => {
    const parent = reader('parent', 'Parent', '# Parent', 1)
    const first = outline(parent.root)
    expect(outlineHeadingsEqual(first, outline(parent.root))).toBe(true)
    const reveal = vi.fn()
    registerOutlineEmbed(parent.root, {
      id: 'parent',
      target: 'Parent',
      blocks: readEmbeddedOutlineBlocks('# Parent', 1),
      element: () => null,
      reveal,
    })
    first[0]?.embedded?.reveal()
    expect(reveal).toHaveBeenCalledWith(0)
  })
})
