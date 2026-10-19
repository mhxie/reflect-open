import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

const NO_COUNTS: ReadonlyMap<string, number> = new Map()

/**
 * Notes touched per local day, as All Notes' edit-day filter lists them, kept
 * fresh by index invalidation. Fetches nothing while `enabled` is false.
 */
export function useDailyEditCounts(enabled: boolean): ReadonlyMap<string, number> {
  const { graph } = useGraph()
  const { dailyActivity } = useCoreServices()
  const { data } = useQuery({
    queryKey: queryKeys.index.dailyEditCounts(graph?.root),
    queryFn: () => dailyActivity.listDailyEditCounts(),
    enabled: enabled && graph !== null,
  })
  return useMemo(
    () =>
      data === undefined ? NO_COUNTS : new Map(data.map((entry) => [entry.date, entry.notes])),
    [data],
  )
}
