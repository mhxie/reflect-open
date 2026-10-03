import { useQuery } from '@tanstack/react-query'
import { listDailyActivity, type DailyActivity } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * Every daily note with content and its size, kept fresh by index
 * invalidation. Fetches nothing while `enabled` is false.
 */
export function useDailyActivity(enabled: boolean): DailyActivity[] | undefined {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: queryKeys.index.dailyActivity(graph?.root),
    queryFn: () => listDailyActivity(),
    enabled: enabled && bridgeReady && graph !== null,
  })
  return data
}
