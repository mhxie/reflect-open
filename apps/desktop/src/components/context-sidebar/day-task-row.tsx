import type { ReactElement } from 'react'
import { Circle, CircleCheck } from 'lucide-react'
import { displayNoteTitle, isLocalOnlyReadOnlyPath, type OpenTask } from '@reflect/core'
import { isModEvent } from '@meowdown/core'
import type { NoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { formatShortDate } from '@/lib/dates.ts'
import { useTaskCheckboxToggle } from '@/lib/tasks/use-task-checkbox-toggle.ts'
import { cn } from '@/lib/utils.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { routeForPath } from '@/routing/route.ts'
import { NoteStateIndicator } from '@/components/note-state-indicator.tsx'

interface DayTaskRowProps {
  task: OpenTask
  /** The sidebar's day — a task written in that day's note needs no source label. */
  day: string
  onNavigate: NoteLinkNavigation
}

/**
 * A daily-sidebar task row. The checkbox goes through the Tasks view's guarded
 * write-back and, as there, stays inert for a task in a read-only local-only
 * note.
 */
export function DayTaskRow({ task, day, onNavigate }: DayTaskRowProps): ReactElement {
  const { settings } = useSettings()
  const { toggle, isPending } = useTaskCheckboxToggle(task)
  const label = task.text || 'Empty task'
  const source =
    task.dailyDate === day
      ? null
      : task.dailyDate !== null
        ? formatShortDate(task.dailyDate, settings.dateFormat)
        : displayNoteTitle(task.noteTitle)

  return (
    <li className="flex items-start gap-2 rounded-md px-3 py-1 hover:bg-surface-hover">
      <button
        type="button"
        aria-label={task.checked ? `Reopen: ${label}` : `Complete: ${label}`}
        disabled={isPending || isLocalOnlyReadOnlyPath(task.notePath)}
        onClick={toggle}
        className="flex h-5 shrink-0 items-center text-text-muted transition-colors hover:text-text focus-visible:text-text focus-visible:outline-none disabled:cursor-default"
      >
        {task.checked ? (
          <CircleCheck aria-hidden className="size-3.5 text-accent" strokeWidth={2} />
        ) : (
          <Circle aria-hidden className="size-3.5" strokeWidth={2} />
        )}
      </button>
      <button
        type="button"
        onClick={(event) =>
          onNavigate({ target: routeForPath(task.notePath), openInNewWindow: isModEvent(event) })
        }
        className="flex min-w-0 flex-1 flex-col text-left text-xs leading-5"
      >
        <span
          className={cn(
            'line-clamp-2 break-words text-text-secondary',
            task.checked && 'text-text-muted line-through',
          )}
        >
          {label}
        </span>
        {source === null ? null : (
          <span className="truncate text-2xs text-text-muted">
            <NoteStateIndicator
              path={task.notePath}
              isPrivate={task.isPrivate}
              hasConflict={task.hasConflict}
              className="mr-1"
            />
            {source}
          </span>
        )}
      </button>
    </li>
  )
}
