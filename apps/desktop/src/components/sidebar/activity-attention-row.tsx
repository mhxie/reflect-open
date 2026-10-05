import type { ReactElement } from 'react'
import { CircleAlert, TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import { dismissOperation, type Operation } from '@/lib/operations.ts'
import { cn } from '@/lib/utils.ts'

export interface ActivityAttentionRowProps {
  operation: Operation
}

/** An operation that failed or warned: its message, its action, and a dismiss. */
export function ActivityAttentionRow({ operation }: ActivityAttentionRowProps): ReactElement {
  const failed = operation.status === 'failed'
  const Icon = failed ? CircleAlert : TriangleAlert
  const action = operation.action
  return (
    <li className="flex gap-2 px-3 py-1.5">
      <Icon
        aria-hidden
        strokeWidth={1.75}
        // No warning token exists; amber is the app's warning colour.
        className={cn('mt-0.5 size-3.5 shrink-0', failed ? 'text-destructive' : 'text-amber-500')}
      />
      <div className="min-w-0 flex-1 text-xs">
        <p className="text-text-secondary">{operation.label}</p>
        {operation.message === null ? null : (
          <p className="text-2xs break-words text-text-muted">{operation.message}</p>
        )}
        {action === null ? null : (
          <Button
            size="xs"
            variant="secondary"
            className="mt-1"
            onClick={() => {
              void Promise.resolve(action.run()).catch((error: unknown) => {
                console.error('operation action failed:', error)
              })
            }}
          >
            {action.label}
          </Button>
        )}
      </div>
      <button
        type="button"
        aria-label={`Dismiss ${operation.label}`}
        onClick={() => dismissOperation(operation.id)}
        className="flex size-5 shrink-0 items-center justify-center rounded text-text-muted hover:bg-surface-hover hover:text-text"
      >
        <X aria-hidden className="size-3" strokeWidth={1.75} />
      </button>
    </li>
  )
}
