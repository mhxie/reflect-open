import { describe, expect, it } from 'vitest'
import { layoutMasonry, masonryColumns, masonryNeighbor, masonryVisible } from './masonry-layout.ts'

const options = { width: 640, minColumnWidth: 200, gap: 20 }

describe('masonryColumns', () => {
  it('fits as many columns as stay at least the minimum width', () => {
    expect(masonryColumns(options)).toEqual({ count: 3, columnWidth: 200 })
    expect(masonryColumns({ ...options, width: 639 }).count).toBe(2)
    expect(masonryColumns({ ...options, width: 120 })).toEqual({ count: 1, columnWidth: 120 })
  })
})

describe('layoutMasonry', () => {
  it('fills the top row left to right, then the shortest column', () => {
    const heights = [100, 300, 200, 50, 80]
    const layout = layoutMasonry(heights.length, (index) => heights[index] ?? 0, options)

    expect(layout.positions.map(({ column, top }) => [column, top])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      // Column 0 is shortest (ends at 120), then column 0 again (190) beats column 2 (220).
      [0, 120],
      [0, 190],
    ])
    expect(layout.positions[2]).toMatchObject({ left: 440, width: 200 })
    expect(layout.height).toBe(300)
  })

  it('passes the column width to the height function', () => {
    const layout = layoutMasonry(1, (_index, columnWidth) => columnWidth / 2, options)
    expect(layout.positions[0]?.height).toBe(100)
  })

  it('has zero height with no cards', () => {
    expect(layoutMasonry(0, () => 100, options).height).toBe(0)
  })
})

describe('masonryNeighbor', () => {
  // Column 0: cards 0 (0–100), 3 (120–170), and 4 (190–270); column 1:
  // card 1 (0–300); column 2: card 2 (0–200).
  const heights = [100, 300, 200, 50, 80]
  const { positions } = layoutMasonry(heights.length, (index) => heights[index] ?? 0, options)

  it('moves within a column for up and down, stopping at the ends', () => {
    expect(masonryNeighbor(positions, 0, 'down')).toBe(3)
    expect(masonryNeighbor(positions, 3, 'up')).toBe(0)
    expect(masonryNeighbor(positions, 0, 'up')).toBeNull()
    expect(masonryNeighbor(positions, 1, 'down')).toBeNull()
  })

  it('moves to the adjacent column card nearest the vertical center', () => {
    expect(masonryNeighbor(positions, 1, 'left')).toBe(3)
    expect(masonryNeighbor(positions, 1, 'right')).toBe(2)
    expect(masonryNeighbor(positions, 4, 'right')).toBe(1)
    expect(masonryNeighbor(positions, 0, 'left')).toBeNull()
    expect(masonryNeighbor(positions, 2, 'right')).toBeNull()
  })
})

describe('masonryVisible', () => {
  // Column 0: cards 0 (0–100), 3 (120–170), 4 (190–270); column 1: card 1
  // (0–300); column 2: card 2 (0–200).
  const heights = [100, 300, 200, 50, 80]
  const { positions } = layoutMasonry(heights.length, (index) => heights[index] ?? 0, options)

  it('returns the cards intersecting the band, in reading order', () => {
    expect(masonryVisible(positions, 0, 50)).toEqual([0, 1, 2])
    expect(masonryVisible(positions, 150, 210)).toEqual([1, 2, 3, 4])
    expect(masonryVisible(positions, 280, 400)).toEqual([1])
  })

  it('treats the band as half-open and ignores cards outside it', () => {
    expect(masonryVisible(positions, 300, 400)).toEqual([])
    expect(masonryVisible(positions, -50, 0)).toEqual([])
  })
})
