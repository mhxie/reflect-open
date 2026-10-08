import { describe, expect, it } from 'vitest'
import { hasUnsavedEdit, nextSavedClaims, type SavedClaim } from './wiki-trust-edits.ts'

const none: ReadonlyMap<string, SavedClaim> = new Map()

describe('nextSavedClaims', () => {
  it('snapshots the editor text when a file version is first seen', () => {
    const next = nextSavedClaims(none, new Map([['c1', 'h1']]), new Map([['c1', 'A']]), null)
    expect(next.get('c1')).toEqual({ saved: 'h1', text: 'A' })
  })

  it('keeps the snapshot through a refetch of the same file while the text is dirty', () => {
    const first = nextSavedClaims(none, new Map([['c1', 'h1']]), new Map([['c1', 'A']]), null)
    const again = nextSavedClaims(first, new Map([['c1', 'h1']]), new Map([['c1', 'A2']]), null)
    expect(again).toBe(first)
    expect(hasUnsavedEdit(again, 'c1', 'A2', 'h-a2')).toBe(true)
  })

  it('takes the new text once a save changes the file version', () => {
    const first = nextSavedClaims(none, new Map([['c1', 'h1']]), new Map([['c1', 'A']]), null)
    const saved = nextSavedClaims(first, new Map([['c1', 'h2']]), new Map([['c1', 'A2']]), null)
    expect(saved.get('c1')).toEqual({ saved: 'h2', text: 'A2' })
    expect(hasUnsavedEdit(saved, 'c1', 'A2', 'h2')).toBe(false)
  })

  it('reads a reloaded claim as clean once the editor hashes to the file', () => {
    // The harness rewrote the file before the editor reloaded it.
    const early = nextSavedClaims(none, new Map([['c1', 'h2']]), new Map([['c1', 'A']]), null)
    expect(hasUnsavedEdit(early, 'c1', 'B', 'h2')).toBe(false)
    const settled = nextSavedClaims(
      early,
      new Map([['c1', 'h2']]),
      new Map([['c1', 'B']]),
      new Map([['c1', 'h2']]),
    )
    expect(settled.get('c1')).toEqual({ saved: 'h2', text: 'B' })
  })

  it('leaves a claim the editor serializes differently clean until it is typed in', () => {
    const first = nextSavedClaims(
      none,
      new Map([['c1', 'h1']]),
      new Map([['c1', 'A*']]),
      new Map([['c1', 'h-other']]),
    )
    expect(hasUnsavedEdit(first, 'c1', 'A*', 'h-other')).toBe(false)
    expect(hasUnsavedEdit(first, 'c1', 'A*!', 'h-other2')).toBe(true)
  })

  it('takes no snapshot before the editor has text', () => {
    expect(nextSavedClaims(none, new Map([['c1', 'h1']]), new Map(), null).size).toBe(0)
  })
})
