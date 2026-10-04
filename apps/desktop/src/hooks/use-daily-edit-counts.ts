import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listDailyEditCounts } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { queryKeys } from '@/lib/query-client.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

const NO_COUNTS: ReadonlyMap<string, number> = new Map()

/**
 * Notes touched per local day, as All Notes' edit-day filter lists them, kept
 * fresh by index invalidation. Fetches nothing while `enabled` is false.
 */
export function useDailyEditCounts(enabled: boolean): ReadonlyMap<string, number> {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data } = useQuery({
    queryKey: queryKeys.index.dailyEditCounts(graph?.root),
    queryFn: () => listDailyEditCounts(),
    enabled: enabled && bridgeReady && graph !== null,
  })
  return useMemo(
    () =>
      data === undefined ? NO_COUNTS : new Map(data.map((entry) => [entry.date, entry.notes])),
    [data],
  )
}
