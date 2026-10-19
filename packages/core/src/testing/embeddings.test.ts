import { describe, expect, it } from 'vitest'
import type { SemanticIndexProgress } from '../embeddings/semantic-search-service.ts'
import { createTestSemanticSearchService } from './embeddings.ts'

describe('createTestSemanticSearchService', () => {
  it('reports a set index progress to its subscribers', () => {
    const semanticSearch = createTestSemanticSearchService()
    const seen: (SemanticIndexProgress | null)[] = []
    const unsubscribe = semanticSearch.subscribe(() => {
      seen.push(semanticSearch.getIndexProgress())
    })

    semanticSearch.setIndexProgress({ done: 30, total: 120 })
    semanticSearch.setIndexProgress(null)
    unsubscribe()
    semanticSearch.setIndexProgress({ done: 60, total: 120 })

    expect(seen).toEqual([{ done: 30, total: 120 }, null])
    expect(semanticSearch.getIndexProgress()).toEqual({ done: 60, total: 120 })
  })
})
