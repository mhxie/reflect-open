import { createElement, type ReactElement } from 'react'
import { deriveNoteState } from '@reflect/core'
import { useNoteStatus } from '@/editor/status/note-status-store.ts'
import { noteStatePresentation } from '@/lib/note-state-presentation.ts'
import { cn } from '@/lib/utils.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

interface NoteStateIndicatorProps {
  readonly path: string
  readonly isPrivate: boolean
  readonly hasConflict?: boolean
  readonly className?: string
}

/** A single state glyph for a list row, with a one-word tooltip and accessible name. */
export function NoteStateIndicator({
  path,
  isPrivate,
  hasConflict = false,
  className,
}: NoteStateIndicatorProps): ReactElement {
  const context = useGraph({ optional: true })
  const graph = context?.graph
  const live = useNoteStatus(graph ? { generation: graph.generation, path } : null)
  const state = live?.state ?? deriveNoteState({ path, isPrivate, hasConflict })
  const { label, icon: Icon, className: color } = noteStatePresentation(state.kind)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={label}
            className={cn(
              'relative -top-px inline-flex shrink-0 items-center align-middle',
              color,
              className,
            )}
          >
            {createElement(Icon, { 'aria-hidden': true, className: 'size-3', strokeWidth: 2 })}
          </span>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
