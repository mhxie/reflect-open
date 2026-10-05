import type { CSSProperties, ReactElement } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { PinnedTagMove } from '@reflect/core'
import { GripVertical, MoreHorizontal, PinOff } from 'lucide-react'
import { Button } from '@/components/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { cn } from '@/lib/utils.ts'

export type PinnedTagControl = 'handle' | 'menu'

interface PinnedTagFilterRowProps {
  readonly tag: string
  readonly first: boolean
  readonly last: boolean
  readonly sorting: boolean
  readonly insertion: 'before' | 'after' | null
  onMove: (tag: string, move: PinnedTagMove) => void
  onUnpin: (tag: string) => void
  registerControl: (
    tag: string,
    control: PinnedTagControl,
    element: HTMLButtonElement | null,
  ) => void
  menuFinalFocus: (tag: string) => HTMLElement | null
}

/** A display-only tag label with a dedicated reorder handle and action menu. */
export function PinnedTagFilterRow({
  tag,
  first,
  last,
  sorting,
  insertion,
  onMove,
  onUnpin,
  registerControl,
  menuFinalFocus,
}: PinnedTagFilterRowProps): ReactElement {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tag })
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition }

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={cn(
        'relative flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px]',
        isDragging && 'opacity-30',
        insertion === 'before' &&
          'before:absolute before:inset-x-1 before:top-0 before:h-0.5 before:rounded-full before:bg-primary',
        insertion === 'after' &&
          'after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary',
      )}
    >
      <Tooltip disabled={sorting}>
        <TooltipTrigger
          render={
            <Button
              ref={(element) => {
                setActivatorNodeRef(element)
                registerControl(tag, 'handle', element)
              }}
              {...attributes}
              {...listeners}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Reorder #${tag}`}
              className="touch-none cursor-grab text-text-muted active:cursor-grabbing"
            >
              <GripVertical aria-hidden className="size-3.5" strokeWidth={1.75} />
            </Button>
          }
        />
        <TooltipContent className="max-w-60">
          Drag to reorder. Space or Enter picks up and drops; ↑/↓ moves; Escape cancels.
        </TooltipContent>
      </Tooltip>
      <Tooltip disabled={sorting}>
        <TooltipTrigger render={<span />} className="min-w-0 flex-1 truncate text-text">
          #{tag}
        </TooltipTrigger>
        <TooltipContent className="max-w-[min(20rem,calc(100vw-1rem))] break-all">
          #{tag}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <Tooltip disabled={sorting}>
          <DropdownMenuTrigger
            disabled={sorting}
            ref={(element) => registerControl(tag, 'menu', element)}
            render={
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for #${tag}`}>
                    <MoreHorizontal aria-hidden className="size-3.5" strokeWidth={1.75} />
                  </Button>
                }
              />
            }
          />
          <TooltipContent>Move or unpin this filter</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="end"
          className="w-44"
          aria-label={`Pinned filter #${tag}`}
          finalFocus={() => menuFinalFocus(tag)}
        >
          <DropdownMenuItem disabled={first} onClick={() => onMove(tag, 'top')}>
            Move to top
          </DropdownMenuItem>
          <DropdownMenuItem disabled={first} onClick={() => onMove(tag, 'up')}>
            Move up
          </DropdownMenuItem>
          <DropdownMenuItem disabled={last} onClick={() => onMove(tag, 'down')}>
            Move down
          </DropdownMenuItem>
          <DropdownMenuItem disabled={last} onClick={() => onMove(tag, 'bottom')}>
            Move to bottom
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onUnpin(tag)}>
            <PinOff aria-hidden className="size-3.5" strokeWidth={1.75} />
            Unpin
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
