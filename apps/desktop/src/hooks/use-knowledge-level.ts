import { useEffect } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  classifyKnowledgePath,
  loadKnowledgeLevels,
  type KnowledgeClassification,
  type KnowledgeLevelsState,
} from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

export type KnowledgeLevelState =
  | { readonly kind: 'unclassified' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'classified'; readonly classification: KnowledgeClassification }

interface FocusSubscription {
  count: number
  readonly onFocus: () => void
}

const focusSubscriptions = new WeakMap<QueryClient, Map<string, FocusSubscription>>()

function subscribeFocus(client: QueryClient, root: string, generation: number): () => void {
  let subscriptions = focusSubscriptions.get(client)
  if (subscriptions === undefined) {
    subscriptions = new Map()
    focusSubscriptions.set(client, subscriptions)
  }
  const queryKey = ['knowledge-levels', root, generation]
  const id = JSON.stringify(queryKey)
  let subscription = subscriptions.get(id)
  if (subscription === undefined) {
    subscription = {
      count: 0,
      onFocus: () => {
        if (client.getQueryState(queryKey)?.fetchStatus !== 'fetching') {
          void client.invalidateQueries({ queryKey, exact: true })
        }
      },
    }
    subscriptions.set(id, subscription)
    window.addEventListener('focus', subscription.onFocus)
  }
  const active = subscription
  active.count += 1
  return () => {
    active.count -= 1
    if (active.count === 0) {
      window.removeEventListener('focus', active.onFocus)
      subscriptions.delete(id)
    }
  }
}

/** All note surfaces share one cached, generation-pinned copy of the graph's path rules. */
export function useKnowledgeLevels(): KnowledgeLevelsState | undefined {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const client = useQueryClient()
  const root = graph?.root
  const generation = graph?.generation
  useEffect(() => {
    if (bridgeReady && root !== undefined && generation !== undefined) {
      return subscribeFocus(client, root, generation)
    }
  }, [bridgeReady, client, root, generation])
  const result = useQuery({
    queryKey: ['knowledge-levels', root, generation],
    queryFn: () => (generation === undefined ? null : loadKnowledgeLevels(generation)),
    enabled: bridgeReady && generation !== undefined,
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
