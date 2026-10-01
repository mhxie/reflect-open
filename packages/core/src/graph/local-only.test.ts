import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isLocalOnlyPath, setLocalOnlyFolders } from './local-only.ts'

const fixtureSchema = z.object({
  folders: z.array(z.string()),
  cases: z.array(z.object({ path: z.string(), localOnly: z.boolean() })),
})

const fixture = fixtureSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../../fixtures/local-only-paths.json', import.meta.url), 'utf8'),
  ),
)

afterEach(() => {
  setLocalOnlyFolders([])
})

describe('isLocalOnlyPath', () => {
  it('matches the shared fixture corpus (the Rust predicate reads the same file)', () => {
    setLocalOnlyFolders(fixture.folders)
    for (const testCase of fixture.cases) {
      expect(isLocalOnlyPath(testCase.path), testCase.path).toBe(testCase.localOnly)
    }
  })

  it('treats nothing as local-only while no folders are configured', () => {
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(false)
  })

  it('folds configured names ASCII case-insensitively', () => {
    setLocalOnlyFolders(['Secure'])
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(true)
    expect(isLocalOnlyPath('finance/SECURE/bank.md')).toBe(true)
  })

  it('follows the open graph: a new set replaces the previous one', () => {
    setLocalOnlyFolders(['secure'])
    setLocalOnlyFolders(['raw'])
    expect(isLocalOnlyPath('finance/secure/bank.md')).toBe(false)
    expect(isLocalOnlyPath('papers/raw/scan.png')).toBe(true)
  })
})
