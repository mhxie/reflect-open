import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { isLoopbackHttpUrl } from './loopback.ts'

const fixtureSchema = z.object({
  cases: z.array(z.object({ input: z.string(), loopback: z.boolean() })),
})

const fixture = fixtureSchema.parse(
  JSON.parse(
    readFileSync(new URL('../../../../fixtures/loopback-urls.json', import.meta.url), 'utf8'),
  ),
)

describe('isLoopbackHttpUrl', () => {
  it('matches the shared fixture corpus (the Rust transport reads the same file)', () => {
    for (const testCase of fixture.cases) {
      expect(isLoopbackHttpUrl(testCase.input), testCase.input).toBe(testCase.loopback)
    }
  })
})
