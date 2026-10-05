import { describe, expect, it } from 'vitest'
import { gistFilename } from './gist.ts'

describe('gistFilename', () => {
  it('appends .md to the title (dailies are already their ISO date)', () => {
    expect(gistFilename('Project X')).toBe('Project X.md')
    expect(gistFilename('2026-06-12')).toBe('2026-06-12.md')
  })

  it('folds path separators to dashes', () => {
    expect(gistFilename(String.raw`a/b\c`)).toBe('a-b-c.md')
  })

  it('falls back to Untitled for an empty or whitespace title', () => {
    expect(gistFilename('')).toBe('Untitled.md')
    expect(gistFilename('   ')).toBe('Untitled.md')
  })
})
