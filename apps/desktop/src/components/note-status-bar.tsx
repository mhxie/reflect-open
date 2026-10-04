import type { ReactElement } from 'react'
import { useNoteStatus } from '@/editor/status/note-status-store.ts'
import { useToday } from '@/lib/use-today.ts'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { focusedNotePathForRoute } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'

const numberFormat = new Intl.NumberFormat()

/**
 * A translucent full-width status bar along the editor's bottom edge,
 * VS Code-style, for the note being edited — the routed note, or the focused
 * day in the stream. Shows its live character count today; further items slot
 * in beside it. Off in settings hides it. Never takes pointer events, so it
 * can't cover text the user clicks.
 */
export function NoteStatusBar(): ReactElement | null {
  const { route } = useRouter()
  const today = useToday()
  const focusedDailyDate = useFocusedDailyDate()
  const { settings } = useSettings()
  const status = useNoteStatus(focusedNotePathForRoute(route, today, focusedDailyDate))
  if (!settings.statusBarEnabled || status === null) {
    return null
  }

  return (
    <div
      role="status"
      aria-label="Note status"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-6 items-center justify-end gap-3 border-t border-border/50 bg-surface/50 px-4 text-2xs tabular-nums text-text-muted backdrop-blur-[2px]"
    >
      <span>{numberFormat.format(status.characters)} chars</span>
    </div>
  )
}
