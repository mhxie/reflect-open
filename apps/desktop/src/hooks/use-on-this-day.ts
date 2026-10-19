import { useQuery } from '@tanstack/react-query'
import type { OnThisDayEntry } from '@reflect/core'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Earlier years' daily notes for `date`'s month and day, kept fresh by index invalidation.
 */
export function useOnThisDay(date: string): OnThisDayEntry[] {
  const { graph } = useGraph()
  const { dailyActivity } = useCoreServices()
  const { data } = useQuery({
    queryKey: queryKeys.index.onThisDay(graph?.root, date),
    queryFn: () => dailyActivity.listOnThisDay(date),
    enabled: graph !== null,
  })
  return data ?? []
}
