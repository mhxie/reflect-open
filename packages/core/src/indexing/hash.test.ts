import { sha256Hex } from '@reflect/utils'
import { describe, expect, it } from 'vitest'
import { hashBytes, matchesTrustedMtime, MTIME_TRUST_AGE_MS } from './hash.ts'

describe('hashBytes', () => {
  it('hashes the exact bytes: the text hash of their UTF-8 decoding, hex-encoded', async () => {
    const bytes = new TextEncoder().encode('caf\u{E9}')
    expect(await hashBytes(bytes)).toBe(await sha256Hex('caf\u{E9}'))
    expect(await hashBytes(bytes)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('tells binary content apart byte for byte', async () => {
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const changed = new Uint8Array([0x89, 0x50, 0x4e, 0x48])
    expect(await hashBytes(original)).toBe(await hashBytes(new Uint8Array(original)))
    expect(await hashBytes(original)).not.toBe(await hashBytes(changed))
  })
})

describe('matchesTrustedMtime', () => {
  it('trusts only a matching mtime old enough to have settled', () => {
    const now = 100_000
    expect(matchesTrustedMtime(1_000, 1_000, now)).toBe(true)
    expect(matchesTrustedMtime(1_000, 2_000, now)).toBe(false)
    expect(matchesTrustedMtime(undefined, 1_000, now)).toBe(false)
    expect(matchesTrustedMtime(1_000, undefined, now)).toBe(false)
    expect(matchesTrustedMtime(now, now, now + MTIME_TRUST_AGE_MS - 1)).toBe(false)
  })
})
