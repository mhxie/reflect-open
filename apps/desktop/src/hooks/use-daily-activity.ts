import { useQuery } from '@tanstack/react-query'
import type { DailyActivity } from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Every daily note with content and its size, kept fresh by index
 * invalidation. Fetches nothing while `enabled` is false.
 */
export function useDailyActivity(enabled: boolean): DailyActivity[] | undefined {
  const { graph } = useGraph()
  const { dailyActivity } = useCoreServices()
  const { data } = useQuery({
    queryKey: queryKeys.index.dailyActivity(graph?.root),
    queryFn: () => dailyActivity.listDailyActivity(),
    enabled: enabled && graph !== null,
  })
  return data
}
