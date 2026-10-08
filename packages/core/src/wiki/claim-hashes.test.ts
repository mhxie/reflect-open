import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { wikiClaimTextHashes } from './claim-hashes.ts'

const corpus = z
  .object({
    cases: z.array(
      z.object({
        name: z.string(),
        markdown: z.string(),
        hashes: z.record(z.string(), z.string()),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(
        new URL('../../../../fixtures/wiki-claim-text-hashes.json', import.meta.url),
        'utf8',
      ),
    ),
  )

it.each(corpus.cases)('$name (shared vectors)', async ({ markdown, hashes }) => {
  expect(Object.fromEntries(await wikiClaimTextHashes(markdown, '2026-10-08'))).toEqual(hashes)
})
