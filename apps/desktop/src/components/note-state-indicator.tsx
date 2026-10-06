import { createElement, type ReactElement } from 'react'
import { deriveNoteState } from '@reflect/core'
import { useNoteStatus } from '@/editor/status/note-status-store.ts'
import { activeNoteStateKinds, noteStatePresentation } from '@/lib/note-state-presentation.ts'
import { cn } from '@/lib/utils.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'

interface NoteStateIndicatorProps {
  readonly path: string
  readonly isPrivate: boolean
  readonly hasConflict?: boolean
  readonly className?: string
}

/**
 * A single state glyph for a note in a list, named by the note's primary
 * state, with a tooltip listing every state that applies and what each one
 * means. An ordinary editable note shows nothing, so the glyph only appears
 * where it says something.
 */
export function NoteStateIndicator({
  path,
  isPrivate,
  hasConflict = false,
  className,
}: NoteStateIndicatorProps): ReactElement | null {
  const context = useGraph({ optional: true })
  const graph = context?.graph
  const live = useNoteStatus(graph ? { generation: graph.generation, path } : null)
  const state = live?.state ?? deriveNoteState({ path, isPrivate, hasConflict })
  if (state.kind === 'editable') {
    return null
  }
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
      <TooltipContent className="flex-col items-start gap-0.5">
        {activeNoteStateKinds(state).map((kind) => {
          const presentation = noteStatePresentation(kind)
          return (
            <span key={kind}>
              <span className="font-medium">{presentation.label}</span>
              {presentation.description === null ? null : (
                <span className="opacity-70"> · {presentation.description}</span>
              )}
            </span>
          )
        })}
      </TooltipContent>
    </Tooltip>
  )
}
