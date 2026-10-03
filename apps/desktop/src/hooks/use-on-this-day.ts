import { useQuery } from '@tanstack/react-query'
import { listOnThisDay, type OnThisDayEntry } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/** Earlier years' daily notes for `date`'s month and day, kept fresh by index invalidation. */
export function useOnThisDay(date: string): OnThisDayEntry[] {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: queryKeys.index.onThisDay(graph?.root, date),
    queryFn: () => listOnThisDay(date),
    enabled: bridgeReady && graph !== null,
  })
  return data ?? []
}
