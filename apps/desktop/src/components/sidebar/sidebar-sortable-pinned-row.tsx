import { memo, type CSSProperties, type ReactElement } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { displayNoteTitle } from '@reflect/core'
import type { PinnedNote } from '@reflect/core'
import { usePeekNavigation } from '@/components/peek/peek-provider.tsx'
import { formatDayLabel } from '@/lib/dates.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { usePinnedNoteMenu } from '@/hooks/use-pinned-note-menu.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { routeForPath, routesEqual } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'
import { SidebarPinnedRowPreview } from './sidebar-pinned-row-preview.tsx'
import { isModEvent } from '@meowdown/core'

interface SidebarSortablePinnedRowProps {
  note: PinnedNote
  binding?: string | undefined
}

export const SidebarSortablePinnedRow = memo(function SidebarSortablePinnedRow({
  note,
  binding,
}: SidebarSortablePinnedRowProps): ReactElement {
  const { route } = useRouter()
  const navigateNoteLink = useNoteLinkNavigation()
  const peekNoteLink = usePeekNavigation()
  const handleContextMenu = usePinnedNoteMenu(note)
  const { settings } = useSettings()
  const target = routeForPath(note.path)
  const active = routesEqual(route, target)
  const label =
    note.dailyDate !== null
      ? formatDayLabel(note.dailyDate, settings.dateFormat)
      : displayNoteTitle(note.title)
  const { isDragging, listeners, setNodeRef, transform, transition } = useSortable({
    id: note.path,
  })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <li className="-mx-2.5">
      <button
        ref={setNodeRef}
        type="button"
        style={style}
        onClick={(event) => {
          // Shift peeks, as in the palette; ⌘ still opens a new window.
          const peek = event.shiftKey && !isModEvent(event)
          const follow = peek ? peekNoteLink : navigateNoteLink
          follow({ target, openInNewWindow: isModEvent(event) })
        }}
        onContextMenu={handleContextMenu}
        aria-current={active ? 'page' : undefined}
        className="group block w-full"
        {...listeners}
      >
        <SidebarPinnedRowPreview
          active={active}
          label={label}
          placeholder={isDragging}
          binding={binding}
        />
      </button>
    </li>
  )
})
