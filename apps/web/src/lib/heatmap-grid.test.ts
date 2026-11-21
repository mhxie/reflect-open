import { describe, expect, it } from 'vitest'
import { nextHeatmapIndex, weekColumnsFitting } from './heatmap-grid.ts'

describe('weekColumnsFitting', () => {
  it('fits fixed 14px columns beside the label column', () => {
    expect(weekColumnsFitting(0)).toBe(13)
    expect(weekColumnsFitting(24 - 3 + 14 * 10)).toBe(10)
    expect(weekColumnsFitting(24 - 3 + 14 * 10 - 1)).toBe(9)
    expect(weekColumnsFitting(10)).toBe(1)
  })
})

describe('nextHeatmapIndex', () => {
  // Three columns; the last day reachable (today) is column 2, row 3.
  const last = 2 * 7 + 3

  it('moves within a column and stops at its top and bottom', () => {
    expect(nextHeatmapIndex('ArrowDown', 7, last)).toBe(8)
    expect(nextHeatmapIndex('ArrowUp', 8, last)).toBe(7)
    expect(nextHeatmapIndex('ArrowUp', 7, last)).toBeNull()
    expect(nextHeatmapIndex('ArrowDown', 13, last)).toBeNull()
  })

  it('moves within a row and stops at the first column and at today', () => {
    expect(nextHeatmapIndex('ArrowRight', 2, last)).toBe(9)
    expect(nextHeatmapIndex('ArrowLeft', 9, last)).toBe(2)
    expect(nextHeatmapIndex('ArrowLeft', 2, last)).toBeNull()
    expect(nextHeatmapIndex('ArrowRight', 12, last)).toBeNull()
    expect(nextHeatmapIndex('ArrowDown', last, last)).toBeNull()
  })

  it('jumps to the first day and to today', () => {
    expect(nextHeatmapIndex('Home', 9, last)).toBe(0)
    expect(nextHeatmapIndex('End', 0, last)).toBe(last)
    expect(nextHeatmapIndex('Enter', 0, last)).toBeNull()
  })
})
