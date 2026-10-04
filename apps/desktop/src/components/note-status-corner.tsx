import type { ReactElement } from 'react'
import { useNoteStatus } from '@/editor/status/note-status-store.ts'
import { useToday } from '@/lib/use-today.ts'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider.tsx'
import { focusedNotePathForRoute } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'

const numberFormat = new Intl.NumberFormat()

/**
 * A translucent status corner over the editor's bottom right, VS Code-style,
 * for the note being edited — the routed note, or the focused day in the
 * stream. Shows its live character count today; further items slot in beside
 * it. Never takes pointer events, so it can't cover text the user clicks.
 */
export function NoteStatusCorner(): ReactElement | null {
  const { route } = useRouter()
  const today = useToday()
  const focusedDailyDate = useFocusedDailyDate()
  const status = useNoteStatus(focusedNotePathForRoute(route, today, focusedDailyDate))
  if (status === null) {
    return null
  }

  return (
    <div
      role="status"
      aria-label="Note status"
      className="pointer-events-none absolute bottom-3 right-4 z-10 flex items-center gap-3 rounded-md bg-surface/70 px-2 py-0.5 text-2xs tabular-nums text-text-muted backdrop-blur-sm"
    >
      <span>{numberFormat.format(status.characters)} chars</span>
    </div>
  )
}
