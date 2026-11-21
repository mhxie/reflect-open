import { describe, expect, it } from 'vitest'
import { markdownToDoc } from '@meowdown/core'
import {
  outlineDepths,
  outlineHeadingsEqual,
  readOutlineHeadings,
  type OutlineHeading,
} from './outline-headings.ts'

function texts(markdown: string): string[] {
  return readOutlineHeadings(markdownToDoc(markdown)).map((heading) => heading.text)
}

function heading(level: number, position = level): OutlineHeading {
  return { level, text: `H${level}`, position }
}

describe('readOutlineHeadings', () => {
  it('lists top-level headings in order with their levels and node positions', () => {
    const doc = markdownToDoc('intro\n\n## One\n\ntext\n\n### Two')
    const headings = readOutlineHeadings(doc)
    expect(headings.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 2, text: 'One' },
      { level: 3, text: 'Two' },
    ])
    for (const { position, text } of headings) {
      expect(doc.nodeAt(position)?.textContent).toBe(text)
    }
  })

  it('treats a leading H1 as the title, but keeps later H1s as sections', () => {
    expect(texts('# Title\n\n## One\n\n# Part two')).toEqual(['One', 'Part two'])
    expect(texts('intro\n\n# Not a title')).toEqual(['Not a title'])
    expect(texts('## Leading H2\n\ntext')).toEqual(['Leading H2'])
  })

  it('leaves out empty headings and headings nested in lists or blockquotes', () => {
    expect(texts('# \n\n##\n\n- item\n\n> ## quoted\n\n## Kept')).toEqual(['Kept'])
  })

  it('keeps duplicate headings as distinct entries', () => {
    const headings = readOutlineHeadings(markdownToDoc('## Notes\n\none\n\n## Notes\n\ntwo'))
    expect(headings).toHaveLength(2)
    expect(headings[0]?.position).not.toBe(headings[1]?.position)
  })
})

describe('outlineDepths', () => {
  it('indents relative to the shallowest level, capped at three', () => {
    expect(outlineDepths([heading(2), heading(3), heading(6), heading(2)])).toEqual([0, 1, 3, 0])
    expect(outlineDepths([heading(1), heading(2)])).toEqual([0, 1])
    expect(outlineDepths([])).toEqual([])
  })
})

describe('outlineHeadingsEqual', () => {
  it('compares level, text, and position', () => {
    expect(outlineHeadingsEqual([heading(2)], [heading(2)])).toBe(true)
    expect(outlineHeadingsEqual([heading(2)], [heading(2, 9)])).toBe(false)
    expect(outlineHeadingsEqual([heading(2)], [{ ...heading(2), text: 'other' }])).toBe(false)
    expect(outlineHeadingsEqual([heading(2)], [])).toBe(false)
  })
})
