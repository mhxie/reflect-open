import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  classifyKnowledgePath,
  type KnowledgeClassification,
  type KnowledgeLevelsState,
} from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

export type KnowledgeLevelState =
  | { readonly kind: 'unclassified' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'classified'; readonly classification: KnowledgeClassification }

/** All note surfaces share one cached, generation-pinned copy of the graph's path rules. */
export function useKnowledgeLevels(): KnowledgeLevelsState | undefined {
  const { graph } = useGraph()
  const { knowledgeLevels } = useCoreServices()
  const client = useQueryClient()
  const root = graph?.root
  const generation = graph?.generation
  // A Tauri window regaining focus fires `focus` without `visibilitychange`,
  // which is all the query library's own focus refetch hears. Every surface
  // listens; the first to see the focus refetches, the rest find it fetching.
  useEffect(() => {
    if (root === undefined || generation === undefined) {
      return
    }
    const queryKey = queryKeys.knowledgeLevels(root, generation)
    const onFocus = (): void => {
      if (client.getQueryState(queryKey)?.fetchStatus !== 'fetching') {
        void client.invalidateQueries({ queryKey, exact: true })
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [client, root, generation])
  const result = useQuery({
    queryKey: queryKeys.knowledgeLevels(root, generation),
    queryFn: () => knowledgeLevels.load(),
    enabled: generation !== undefined,
    staleTime: 60_000,
    // The sidecar is outside note watching; focus picks up a new harness export.
    refetchOnWindowFocus: 'always',
    retry: false,
  })
  if (result.isError || result.data?.kind === 'unavailable') return { kind: 'unavailable' }
  return result.data ?? undefined
}

/** Classify a note with the same path rules used by the level filter. */
export function useKnowledgeLevel(path: string): KnowledgeLevelState {
  const state = useKnowledgeLevels()
  if (state?.kind === 'unavailable') return state
  if (state?.kind !== 'ready') return { kind: 'unclassified' }
  const classification = classifyKnowledgePath(path, state.config)
  return classification === null ? { kind: 'unclassified' } : { kind: 'classified', classification }
}
