import { useMemo } from 'react'
import { tasksForDay, withStruckRows, type DayTasks } from '@reflect/core'
import { useRecentlyCompleted } from '@/lib/tasks/recently-completed.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { useServiceState } from '@/services/use-service-state.ts'

/**
 * {@link tasksForDay} over the open tasks `TaskService` keeps fresh, merged
 * with this session's completions so a task checked here stays struck and
 * reopenable. `undefined` until the open tasks have loaded, so a caller can
 * tell a day with no tasks from one whose tasks are still being read.
 */
export function useDayTasks(day: string, today: string): DayTasks | undefined {
  const { graph } = useGraph()
  const { tasks } = useCoreServices()
  const { open } = useServiceState(tasks, tasks.getState)
  const struck = useRecentlyCompleted(graph?.root ?? null, open)
  return useMemo(
    () => (open === undefined ? undefined : tasksForDay(withStruckRows(open, struck), day, today)),
    [open, struck, day, today],
  )
}
