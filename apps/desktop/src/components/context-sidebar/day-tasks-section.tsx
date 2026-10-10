import type { ReactElement } from 'react'
import type { OpenTask } from '@reflect/core'
import { getTaskKey } from '@/lib/tasks/task-identity.ts'
import { useDayTasks } from '@/lib/tasks/use-day-tasks.ts'
import { useTaskActions } from '@/lib/tasks/use-task-actions.ts'
import { useToday } from '@/lib/use-today.ts'
import { useRouter } from '@/routing/router.tsx'
import { usePeekNavigation } from '@/components/peek/peek-provider.tsx'
import { DayTaskRow } from './day-task-row.tsx'
import { SidebarSection } from './sidebar-section.tsx'

/** Rows shown before the list hands off to the Tasks view. */
const DAY_TASKS_LIMIT = 10

interface DayTasksSectionProps {
  /** The day the sidebar describes — a validated ISO date. */
  date: string
}

interface TaskRun {
  label: string
  tasks: readonly OpenTask[]
}

/** The leading `limit` tasks across `runs`, in order, dropping emptied runs. */
function capRuns(runs: readonly TaskRun[], limit: number): TaskRun[] {
  const capped: TaskRun[] = []
  let remaining = limit
  for (const run of runs) {
    const tasks = run.tasks.slice(0, remaining)
    remaining -= tasks.length
    if (tasks.length > 0) {
      capped.push({ label: run.label, tasks })
    }
  }
  return capped
}

/**
 * Daily-sidebar Tasks section ({@link tasksForDay}), capped with a link to the
 * Tasks view. Renders nothing when the day has no open tasks.
 */
export function DayTasksSection({ date }: DayTasksSectionProps): ReactElement | null {
  const today = useToday()
  const { navigate } = useRouter()
  const navigateNoteLink = usePeekNavigation(date)
  const { overdue, due } = useDayTasks(date, today)
  const actions = useTaskActions()
  const total = overdue.length + due.length
  if (total === 0) {
    return null
  }

  const labeled = overdue.length > 0 && due.length > 0
  const runs = capRuns(
    [
      { label: 'Overdue', tasks: overdue },
      { label: 'Current', tasks: due },
    ],
    DAY_TASKS_LIMIT,
  )

  return (
    <SidebarSection storageKey="tasks" title="Tasks">
      <div className="space-y-2">
        {runs.map((run) => (
          <div key={run.label}>
            {labeled ? (
              <p className="px-3 pb-0.5 text-2xs font-medium text-text-muted">{run.label}</p>
            ) : null}
            <ul>
              {run.tasks.map((task) => (
                <DayTaskRow
                  key={getTaskKey(task)}
                  task={task}
                  day={date}
                  onNavigate={navigateNoteLink}
                  onToggle={() => actions.checkboxToggle(task)}
                  togglePending={actions.isPending}
                />
              ))}
            </ul>
          </div>
        ))}
        {total > DAY_TASKS_LIMIT ? (
          <button
            type="button"
            onClick={() => navigate({ kind: 'tasks' })}
            className="w-full rounded-md px-3 py-1 text-left text-xs text-text-muted hover:bg-surface-hover hover:text-text"
          >
            View all {total} in Tasks
          </button>
        ) : null}
      </div>
    </SidebarSection>
  )
}
