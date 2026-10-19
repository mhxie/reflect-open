import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * When `path`'s file was last modified per the index (epoch ms), kept fresh
 * by index invalidation; `null` while loading, unindexed, or for a `null` path.
 */
export function useNoteMtime(path: string | null): number | null {
  const { graph } = useGraph()
  const { indexQuery } = useCoreServices()
  const { data } = useQuery({
    queryKey: queryKeys.index.noteMtime(graph?.root, path ?? ''),
    queryFn: async () => (path === null ? null : ((await indexQuery.getNoteMtime(path)) ?? null)),
    enabled: path !== null && graph !== null,
  })
  return data ?? null
}
