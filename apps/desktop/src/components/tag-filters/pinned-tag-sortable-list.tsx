import { useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { orderPinnedFilterTags, type PinnedTagMove } from '@reflect/core'
import {
  cancelPinnedTagDrag,
  markPinnedTagDragEscape,
  type PinnedTagDragSession,
} from './cancel-pinned-tag-drag.ts'
import { PinnedTagFilterRowPreview } from './pinned-tag-filter-row-preview.tsx'
import { PinnedTagFilterRow, type PinnedTagControl } from './pinned-tag-filter-row.tsx'

interface PinnedTagSortableListProps {
  readonly tags: readonly string[]
  onReorder: (original: readonly string[], next: readonly string[], tag: string) => void
  onMove: (tag: string, move: PinnedTagMove) => void
  onUnpin: (tag: string) => void
  registerControl: (
    tag: string,
    control: PinnedTagControl,
    element: HTMLButtonElement | null,
  ) => void
  menuFinalFocus: (tag: string) => HTMLElement | null
}

const detectPinnedTagCollision: CollisionDetection = (arguments_) =>
  arguments_.pointerCoordinates === null ? closestCenter(arguments_) : pointerWithin(arguments_)

function sessionFromEvent(event: Event): PinnedTagDragSession | null {
  const target = event.target
  const activator = target instanceof Element ? target.closest<HTMLButtonElement>('button') : null
  return activator === null
    ? null
    : {
        activator,
        pointerId: event instanceof PointerEvent ? event.pointerId : null,
      }
}

/** Preview sortable moves locally and persist only a completed, current drag. */
export function PinnedTagSortableList({
  tags,
  onReorder,
  onMove,
  onUnpin,
  registerControl,
  menuFinalFocus,
}: PinnedTagSortableListProps): ReactElement {
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [overTag, setOverTag] = useState<string | null>(null)
  const mounted = useRef(true)
  const dragSession = useRef<PinnedTagDragSession | null>(null)
  const originalOrder = useRef(tags)
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
      onActivation: ({ event }) => {
        dragSession.current = sessionFromEvent(event)
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      scrollBehavior: 'auto',
    }),
  )

  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      const session = dragSession.current
      dragSession.current = null
      if (session !== null) {
        cancelPinnedTagDrag(session)
      }
    }
  }, [])

  useLayoutEffect(() => {
    if (dragSession.current !== null) {
      cancelPinnedTagDrag(dragSession.current)
    }
  }, [tags])

  const handleDragStart = (event: DragStartEvent): void => {
    if (typeof event.active.id === 'string') {
      originalOrder.current = tags
      dragSession.current = sessionFromEvent(event.activatorEvent)
      setActiveTag(event.active.id)
      setOverTag(event.active.id)
    }
  }
  const handleDragOver = (event: DragOverEvent): void => {
    setOverTag(typeof event.over?.id === 'string' ? event.over.id : null)
  }
  const handleDragEnd = (event: DragEndEvent): void => {
    dragSession.current = null
    setActiveTag(null)
    setOverTag(null)
    if (!mounted.current || event.over === null || typeof event.active.id !== 'string') {
      return
    }
    const original = originalOrder.current
    onReorder(
      original,
      orderPinnedFilterTags(original, event.active.id, event.over.id),
      event.active.id,
    )
  }
  const handleDragCancel = (): void => {
    dragSession.current = null
    if (mounted.current) {
      setActiveTag(null)
      setOverTag(null)
    }
  }
  const position = (tag: string): number => tags.indexOf(tag) + 1
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      `Picked up #${active.id}, position ${position(String(active.id))} of ${tags.length}.`,
    onDragOver: ({ active, over }) =>
      over === null
        ? `#${active.id} is outside the pinned list.`
        : `#${active.id} will move to position ${position(String(over.id))} of ${tags.length}.`,
    onDragEnd: ({ active, over }) =>
      `Dropped #${active.id}${over === null ? ' without changing order' : ` at position ${position(String(over.id))} of ${tags.length}`}.`,
    onDragCancel: ({ active }) => `Cancelled moving #${active.id}. Order unchanged.`,
  }
  const sourceIndex = activeTag === null ? -1 : tags.indexOf(activeTag)
  const targetIndex = overTag === null ? -1 : tags.indexOf(overTag)

  return (
    <div
      onKeyDownCapture={(event) => {
        if (activeTag !== null && event.key === 'Escape') {
          event.preventDefault()
          markPinnedTagDragEscape(event.nativeEvent)
        }
      }}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={detectPinnedTagCollision}
        onDragAbort={() => {
          dragSession.current = null
        }}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        cancelDrop={() => !mounted.current}
        accessibility={{
          announcements,
          screenReaderInstructions: {
            draggable:
              'Press Space or Enter to pick up this pinned filter. Use the up and down arrow keys to move it. Press Space or Enter to drop it, or Escape to cancel.',
          },
        }}
      >
        <SortableContext items={[...tags]} strategy={verticalListSortingStrategy}>
          <ol
            aria-label="Pinned filters"
            className="max-h-60 overflow-y-auto overscroll-contain py-1"
          >
            {tags.map((tag, index) => (
              <PinnedTagFilterRow
                key={tag}
                tag={tag}
                first={index === 0}
                last={index === tags.length - 1}
                sorting={activeTag !== null}
                insertion={
                  tag !== activeTag && tag === overTag && targetIndex !== sourceIndex
                    ? targetIndex < sourceIndex
                      ? 'before'
                      : 'after'
                    : null
                }
                onMove={onMove}
                onUnpin={onUnpin}
                registerControl={registerControl}
                menuFinalFocus={menuFinalFocus}
              />
            ))}
          </ol>
        </SortableContext>
        {createPortal(
          <DragOverlay dropAnimation={null} zIndex={60}>
            {activeTag === null ? null : <PinnedTagFilterRowPreview tag={activeTag} />}
          </DragOverlay>,
          document.body,
        )}
      </DndContext>
    </div>
  )
}
