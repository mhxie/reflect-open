import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { tasksForDay, type DayTasks } from '@reflect/core'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { createOpenTasksQueryOptions } from '@/lib/tasks/tasks-query.ts'
import { useRecentlyCompleted } from '@/lib/tasks/recently-completed.ts'
import { withStruckRows } from '@/lib/tasks/task-visibility.ts'
import { useGraph } from '@/providers/graph-provider.tsx'

const NO_TASKS: DayTasks = { overdue: [], due: [] }

/**
 * {@link tasksForDay} over the shared open-tasks query, merged with this
 * session's completions so a task checked here stays struck and reopenable.
 */
export function useDayTasks(day: string, today: string): DayTasks {
  const { graph } = useGraph()
  const bridgeReady = useBridgeReady()
  const { data: open } = useQuery({
    ...createOpenTasksQueryOptions(graph?.root),
    enabled: bridgeReady && graph !== null,
  })
  const struck = useRecentlyCompleted(graph?.root ?? null, open)
  return useMemo(
    () => (open === undefined ? NO_TASKS : tasksForDay(withStruckRows(open, struck), day, today)),
    [open, struck, day, today],
  )
}
