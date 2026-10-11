import { describe, test } from 'vitest'
import { parseSearchQuery } from '../indexing/filter-query.ts'
import { searchWithFilters } from '../indexing/filtered-search.ts'
import { suggestWikiTargets } from '../indexing/queries-suggestions.ts'
import { openBenchIndex } from './bench-index.ts'

/**
 * The search palette's per-keystroke reads: the ranked lexical search and the
 * wiki-target suggestions, for the prefixes a user types on the way to a word.
 * One-letter prefixes are the worst case: they match most of a graph.
 */

const index = openBenchIndex()
const run = { time: 1000, iterations: 5, warmupIterations: 1 }

describe(`palette search — ${index.label}`, () => {
  for (const query of ['a', 'th', 'tra', 'transformer', 'kv cache', '推', '推理', 'is:daily a']) {
    test(`search "${query}"`, async ({ bench }) => {
      await bench(`search "${query}"`, async () => {
        await searchWithFilters(parseSearchQuery(query))
      }).run(run)
    })
  }
})

describe(`palette suggestions — ${index.label}`, () => {
  for (const query of ['a', 'th', 'tra', 'transformer', '推']) {
    test(`suggest "${query}"`, async ({ bench }) => {
      await bench(`suggest "${query}"`, async () => {
        await suggestWikiTargets(query, 8)
      }).run(run)
    })
  }
})
