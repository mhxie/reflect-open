import { useQuery } from '@tanstack/react-query'
import { getNoteMtime } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * When `path`'s file was last modified per the index (epoch ms), kept fresh
 * by index invalidation; `null` while loading, unindexed, or for a `null` path.
 */
export function useNoteMtime(path: string | null): number | null {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: queryKeys.index.noteMtime(graph?.root, path ?? ''),
    queryFn: async () => (await getNoteMtime(path ?? '')) ?? null,
    enabled: path !== null && bridgeReady && graph !== null,
  })
  return data ?? null
}
