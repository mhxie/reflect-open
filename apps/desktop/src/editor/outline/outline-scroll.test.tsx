import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  alignToContainerTop,
  clearTailSpace,
  hasTailSpace,
  holdAtContainerTop,
  lastIndexAtOrAbove,
  offsetFromContainerTop,
  verticalScrollContainer,
} from './outline-scroll.ts'

interface Fixture {
  container: HTMLElement
  blocks: HTMLElement[]
}

/** A 300px scroller holding `count` 100px blocks, optionally in a min-height column. */
function mount(count: number, minHeightColumn = false): Fixture {
  const container = document.createElement('div')
  container.style.cssText = 'height: 300px; overflow: auto;'
  const column = document.createElement('div')
  if (minHeightColumn) {
    column.style.minHeight = '100%'
  }
  const blocks = Array.from({ length: count }, () => {
    const block = document.createElement('div')
    block.style.height = '100px'
    column.append(block)
    return block
  })
  container.append(column)
  document.body.append(container)
  return { container, blocks }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('verticalScrollContainer', () => {
  it('finds the nearest vertically scrolling ancestor', () => {
    const { container, blocks } = mount(2)
    expect(verticalScrollContainer(blocks[0]!)).toBe(container)
    expect(verticalScrollContainer(container)).toBeNull()
  })
})

describe('alignToContainerTop', () => {
  it('scrolls an element to the top edge plus the margin', () => {
    const { container, blocks } = mount(10)
    alignToContainerTop(container, blocks[4]!, 16)
    expect(offsetFromContainerTop(container, blocks[4]!)).toBeCloseTo(16, 0)
    expect(hasTailSpace(container)).toBe(false)
  })

  it('grows tail space when the content after the element is too short', () => {
    const { container, blocks } = mount(10)
    alignToContainerTop(container, blocks[9]!, 16)
    expect(offsetFromContainerTop(container, blocks[9]!)).toBeCloseTo(16, 0)
    expect(hasTailSpace(container)).toBe(true)

    // Jumping back up keeps the room; it lasts until cleared.
    alignToContainerTop(container, blocks[1]!, 16)
    expect(offsetFromContainerTop(container, blocks[1]!)).toBeCloseTo(16, 0)
    expect(hasTailSpace(container)).toBe(true)

    clearTailSpace(container)
    expect(hasTailSpace(container)).toBe(false)
    expect(container.scrollHeight).toBe(1000)
  })

  it('reaches the top in content shorter than the viewport, min-height column or not', () => {
    for (const minHeightColumn of [false, true]) {
      const { container, blocks } = mount(2, minHeightColumn)
      alignToContainerTop(container, blocks[1]!, 16)
      expect(offsetFromContainerTop(container, blocks[1]!)).toBeCloseTo(16, 0)
      container.remove()
    }
  })
})

describe('lastIndexAtOrAbove', () => {
  const tops = [-200, -10, 40, 300, 900]
  const topAt = (index: number): number | null => tops[index] ?? null

  it('returns the last index whose top is at or above the line', () => {
    expect(lastIndexAtOrAbove(tops.length, topAt, 50)).toBe(2)
    expect(lastIndexAtOrAbove(tops.length, topAt, 40)).toBe(2)
    expect(lastIndexAtOrAbove(tops.length, topAt, 1000)).toBe(4)
  })

  it('returns null above the first element or with none', () => {
    expect(lastIndexAtOrAbove(tops.length, topAt, -300)).toBeNull()
    expect(lastIndexAtOrAbove(0, topAt, 50)).toBeNull()
  })

  it('treats an unrendered element as below the line', () => {
    const sparse = (index: number): number | null => (index === 2 ? null : (tops[index] ?? null))
    expect(lastIndexAtOrAbove(tops.length, sparse, 50)).toBe(1)
  })
})

describe('holdAtContainerTop', () => {
  /** A fixture without browser scroll anchoring, so only the hold moves the scroll. */
  function mountUnanchored(count: number): Fixture {
    const fixture = mount(count)
    fixture.container.style.overflowAnchor = 'none'
    return fixture
  }

  /** Wait for `count` animation frames. */
  async function frames(count: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  }

  it('keeps the target at the top while content above it grows', async () => {
    const { container, blocks } = mountUnanchored(10)
    const target = blocks[6]!
    const onStop = vi.fn()
    const stop = holdAtContainerTop(container, () => target, 16, 5000, onStop)
    expect(Math.round(offsetFromContainerTop(container, target))).toBe(16)

    blocks[0]!.style.height = '250px'
    await frames(2)

    expect(Math.round(offsetFromContainerTop(container, target))).toBe(16)
    expect(onStop).not.toHaveBeenCalled()
    stop()
  })

  it('ends on reader input and stops following', async () => {
    const { container, blocks } = mountUnanchored(10)
    const target = blocks[6]!
    const onStop = vi.fn()
    holdAtContainerTop(container, () => target, 16, 5000, onStop)

    window.dispatchEvent(new WheelEvent('wheel'))
    expect(onStop).toHaveBeenCalledTimes(1)
    const scrollTop = container.scrollTop
    blocks[0]!.style.height = '250px'
    await frames(2)

    expect(container.scrollTop).toBe(scrollTop)
  })

  it('ends at its deadline, and a repeated stop is a no-op', async () => {
    const { container, blocks } = mountUnanchored(10)
    const onStop = vi.fn()
    const stop = holdAtContainerTop(container, () => blocks[6]!, 16, 0, onStop)

    await frames(2)
    stop()

    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
