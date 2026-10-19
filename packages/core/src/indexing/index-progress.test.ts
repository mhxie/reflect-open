import { describe, expect, it } from 'vitest'
import { isIndexProgressWorthShowing } from './index-progress.ts'

describe('isIndexProgressWorthShowing', () => {
  it('shows a first index over a large graph once it has read enough files', () => {
    expect(isIndexProgressWorthShowing({ done: 400, total: 3000, worked: 100 })).toBe(true)
  })

  it('hides a pass that reads little, however large the graph', () => {
    // A routine repeat pass skips everything read-free: `done` races ahead.
    expect(isIndexProgressWorthShowing({ done: 2900, total: 3000, worked: 0 })).toBe(false)
    expect(isIndexProgressWorthShowing({ done: 99, total: 3000, worked: 99 })).toBe(false)
  })

  it('hides a pass over a small graph, which finishes before it is worth showing', () => {
    expect(isIndexProgressWorthShowing({ done: 99, total: 99, worked: 99 })).toBe(false)
  })

  it('hides when no pass is running', () => {
    expect(isIndexProgressWorthShowing(null)).toBe(false)
  })
})
