import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { render } from 'vitest-browser-react'
import '@/test-utils/locator.ts'
import { NoteEditor, type NoteEditorHandle } from '../note-editor.tsx'
import { OutlineBridge } from './outline-bridge.tsx'
import { noteOutlineFor, type NoteOutline } from './outline-store.ts'

const PATH = 'notes/outline.md'
const VIEWPORT = 400
const pmRoot = page.locate('.ProseMirror')

/** Filler paragraphs: each section is taller than the viewport. */
function filler(label: string, count = 12): string {
  return Array.from({ length: count }, (_, index) => `${label} line ${index + 1}`).join('\n\n')
}

const NOTE = [
  '# Title',
  filler('intro', 2),
  '## Alpha **bold**',
  filler('alpha'),
  '### Alpha detail',
  filler('detail'),
  '## Beta',
  filler('beta'),
  '## Gamma',
  'short tail',
].join('\n\n')

interface Setup {
  handle: NoteEditorHandle
  scroller: HTMLElement
  unmount: () => Promise<void>
}

async function setup(markdown: string = NOTE): Promise<Setup> {
  const grabbed: { current: NoteEditorHandle | null } = { current: null }
  const screen = await render(
    // No scroll anchoring: Chromium's would hold a heading in place by itself,
    // and WebKit, the production engine, has none.
    <div
      data-testid="scroller"
      style={{ height: `${VIEWPORT}px`, overflow: 'auto', overflowAnchor: 'none' }}
    >
      <NoteEditor
        initialContent={markdown}
        handleRef={(handle) => {
          grabbed.current = handle
        }}
      >
        <OutlineBridge path={PATH} />
      </NoteEditor>
    </div>,
  )
  await expect.element(pmRoot).toBeInTheDocument()
  const scroller = page.getByTestId('scroller').element()
  if (!(scroller instanceof HTMLElement) || grabbed.current === null) {
    throw new Error('editor did not mount')
  }
  return { handle: grabbed.current, scroller, unmount: () => screen.unmount() }
}

async function publishedOutline(): Promise<NoteOutline> {
  return await vi.waitFor(() => {
    const outline = noteOutlineFor(PATH)
    expect(outline).not.toBeNull()
    return outline!
  })
}

function headingTop(scroller: HTMLElement, text: string): number {
  const heading = [...scroller.querySelectorAll('h1, h2, h3, h4, h5, h6')].find(
    (element) => element.textContent?.includes(text) === true,
  )
  if (heading === undefined) {
    throw new Error(`no heading "${text}"`)
  }
  return heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
})

describe('OutlineBridge', () => {
  it('publishes the section headings with their displayed text, leaving the title out', async () => {
    await setup()
    const outline = await publishedOutline()
    expect(outline.headings.map(({ level, text }) => ({ level, text }))).toEqual([
      { level: 2, text: 'Alpha bold' },
      { level: 3, text: 'Alpha detail' },
      { level: 2, text: 'Beta' },
      { level: 2, text: 'Gamma' },
    ])
    expect(outline.activeIndex).toBeNull()
  })

  it('follows typing and external reloads', async () => {
    const { handle } = await setup('# Title\n\n## One\n\nbody')
    await vi.waitFor(() => {
      expect(noteOutlineFor(PATH)?.headings.map((heading) => heading.text)).toEqual(['One'])
    })

    await pmRoot.getByText('body').click()
    await userEvent.keyboard('{End}{Enter}## Two')
    await vi.waitFor(() => {
      expect(noteOutlineFor(PATH)?.headings.map((heading) => heading.text)).toEqual(['One', 'Two'])
    })

    // A reload replaces the document without meowdown's onDocChange.
    handle.setMarkdown('# Title\n\n## Reloaded')
    await vi.waitFor(() => {
      expect(noteOutlineFor(PATH)?.headings.map((heading) => heading.text)).toEqual(['Reloaded'])
    })
  })

  it('jumps a heading to the top of the scroll container and puts the caret on it', async () => {
    const { scroller } = await setup()
    const outline = await publishedOutline()

    outline.reveal(2)
    await vi.waitFor(() => {
      expect(Math.abs(headingTop(scroller, 'Beta') - 16)).toBeLessThanOrEqual(1)
    })
    expect(noteOutlineFor(PATH)?.activeIndex).toBe(2)
    await expect.element(pmRoot).toHaveFocus()
    expect(window.getSelection()?.anchorNode?.parentElement?.closest('h2')?.textContent).toContain(
      'Beta',
    )
  })

  it('grows scroll room so a heading near the end still reaches the top, and drops it on unmount', async () => {
    const { scroller, unmount } = await setup()
    const outline = await publishedOutline()

    outline.reveal(3)
    await vi.waitFor(() => {
      expect(Math.abs(headingTop(scroller, 'Gamma') - 16)).toBeLessThanOrEqual(1)
    })
    expect(scroller.hasAttribute('data-outline-tail-space')).toBe(true)

    await unmount()
    expect(scroller.hasAttribute('data-outline-tail-space')).toBe(false)
    expect(scroller.style.getPropertyValue('--outline-tail-space')).toBe('')
    expect(noteOutlineFor(PATH)).toBeNull()
  })

  it('keeps a jumped heading at the top while content above it grows', async () => {
    const { scroller } = await setup()
    const outline = await publishedOutline()

    outline.reveal(2)
    await vi.waitFor(() => {
      expect(Math.abs(headingTop(scroller, 'Beta') - 16)).toBeLessThanOrEqual(1)
    })
    // Stand-in for an image or PDF preview above the heading finishing loading.
    const intro = pmRoot.getByText('intro line 1').element()
    if (!(intro instanceof HTMLElement)) {
      throw new TypeError('no intro paragraph')
    }
    intro.style.paddingTop = '300px'
    await vi.waitFor(() => {
      expect(Math.abs(headingTop(scroller, 'Beta') - 16)).toBeLessThanOrEqual(1)
    })
  })

  it('keeps a jumped heading at the top through document changes that only shift it', async () => {
    const { handle, scroller } = await setup()
    const outline = await publishedOutline()

    outline.reveal(2)
    await vi.waitFor(() => {
      expect(Math.abs(headingTop(scroller, 'Beta') - 16)).toBeLessThanOrEqual(1)
    })
    // Stand-in for content above the heading writing to the document as it
    // settles (a link card persisting its snapshot): same headings, shifted.
    handle.setMarkdown(NOTE.replace('# Title', `# Title\n\n${filler('settled', 6)}`))
    await vi.waitFor(() => {
      expect(noteOutlineFor(PATH)?.headings[2]?.position).not.toBe(outline.headings[2]?.position)
    })
    await vi.waitFor(() => {
      expect(Math.abs(headingTop(scroller, 'Beta') - 16)).toBeLessThanOrEqual(1)
    })
    expect(noteOutlineFor(PATH)?.activeIndex).toBe(2)
  })

  it('tracks the section being read as the note scrolls', async () => {
    const { scroller } = await setup()
    await publishedOutline()

    const betaTop = headingTop(scroller, 'Beta')
    scroller.scrollTop = betaTop - 20
    await vi.waitFor(() => {
      expect(noteOutlineFor(PATH)?.activeIndex).toBe(2)
    })

    const detailTop = headingTop(scroller, 'Alpha detail')
    scroller.scrollTop += detailTop - 20
    await vi.waitFor(() => {
      expect(noteOutlineFor(PATH)?.activeIndex).toBe(1)
    })

    scroller.scrollTop = 0
    await vi.waitFor(() => {
      expect(noteOutlineFor(PATH)?.activeIndex).toBeNull()
    })

    // At the very end the last section is the one being read, though its
    // heading never reaches the line.
    scroller.scrollTop = scroller.scrollHeight
    await vi.waitFor(() => {
      expect(noteOutlineFor(PATH)?.activeIndex).toBe(3)
    })
  })
})
