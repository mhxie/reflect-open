import { describe, expect, it } from 'vitest'
import { cleanSnippetText, HIGHLIGHT_END, HIGHLIGHT_START, parseHighlights } from './search.ts'

const mark = (text: string): string => `${HIGHLIGHT_START}${text}${HIGHLIGHT_END}`

describe('parseHighlights', () => {
  it('splits a snippet into plain and highlighted runs', () => {
    expect(parseHighlights(`…notes about ${mark('rust')} and ${mark('sqlite')} here`)).toEqual([
      { text: '…notes about ', highlighted: false },
      { text: 'rust', highlighted: true },
      { text: ' and ', highlighted: false },
      { text: 'sqlite', highlighted: true },
      { text: ' here', highlighted: false },
    ])
  })

  it('handles snippets with no matches and empty input', () => {
    expect(parseHighlights('plain text')).toEqual([{ text: 'plain text', highlighted: false }])
    expect(parseHighlights('')).toEqual([])
  })

  it('handles a snippet that is one whole match', () => {
    expect(parseHighlights(mark('everything'))).toEqual([{ text: 'everything', highlighted: true }])
  })
})

describe('cleanSnippetText', () => {
  const S = HIGHLIGHT_START
  const E = HIGHLIGHT_END

  it('drops heading and list markers, task boxes, and wiki brackets', () => {
    expect(
      cleanSnippetText(`# James Clear\n- Type: #person\n- Author of [[Atomic ${S}Habits${E}]]`),
    ).toBe(`James Clear Type: #person Author of Atomic ${S}Habits${E}`)
    expect(cleanSnippetText('+ [ ] Ship it\n+ [x] Done\n1. First')).toBe('Ship it Done First')
  })

  it('shows a wiki alias and a link’s text, and drops emphasis and code ticks', () => {
    expect(cleanSnippetText('see [[notes/a|the plan]] and [docs](https://x.y)')).toBe(
      'see the plan and docs',
    )
    expect(cleanSnippetText('**bold** and `code` and ~~gone~~')).toBe('bold and code and gone')
  })

  it('keeps tags and a hyphen inside a line', () => {
    expect(cleanSnippetText('8 - 3 is five #math')).toBe('8 - 3 is five #math')
  })

  it('drops brackets a snippet window cut in half', () => {
    expect(cleanSnippetText('…ted reading [[Atomic Ha')).toBe('…ted reading Atomic Ha')
  })
})
