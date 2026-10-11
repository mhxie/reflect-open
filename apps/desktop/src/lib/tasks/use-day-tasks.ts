import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { tasksForDay, type DayTasks } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { createOpenTasksQueryOptions } from '@/lib/tasks/tasks-query.ts'
import { useRecentlyCompleted } from '@/lib/tasks/recently-completed.ts'
import { withStruckRows } from '@/lib/tasks/task-visibility.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

/**
 * {@link tasksForDay} over the shared open-tasks query, merged with this
 * session's completions so a task checked here stays struck and reopenable.
 * `undefined` until the open tasks have loaded, so a caller can tell a day
 * with no tasks from one whose tasks are still being read.
 */
export function useDayTasks(day: string, today: string): DayTasks | undefined {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data: open } = useQuery({
    ...createOpenTasksQueryOptions(graph?.root),
    enabled: bridgeReady && graph !== null,
  })
  const struck = useRecentlyCompleted(graph?.root ?? null, open)
  return useMemo(
    () => (open === undefined ? undefined : tasksForDay(withStruckRows(open, struck), day, today)),
    [open, struck, day, today],
  )
}
