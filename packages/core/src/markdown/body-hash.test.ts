import { describe, expect, it } from 'vitest'
import { noteBodyHash } from './body-hash.ts'

describe('noteBodyHash', () => {
  it('is deterministic and 16 hex chars', () => {
    const hash = noteBodyHash('# Note\n\nbody\n')
    expect(hash).toBe(noteBodyHash('# Note\n\nbody\n'))
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('changes when the body changes', () => {
    expect(noteBodyHash('a')).not.toBe(noteBodyHash('b'))
    expect(noteBodyHash('')).not.toBe(noteBodyHash(' '))
  })

  it('hashes by UTF-8 bytes, so multi-byte edits register', () => {
    expect(noteBodyHash('café')).not.toBe(noteBodyHash('cafe'))
  })
})
