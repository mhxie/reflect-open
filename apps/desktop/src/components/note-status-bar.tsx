import type { ReactElement } from 'react'
import { useNoteStatus } from '@/editor/status/note-status-store.ts'
import { useNoteMtime } from '@/hooks/use-note-mtime.ts'
import { useNow } from '@/hooks/use-now.ts'
import { useTyping } from '@/hooks/use-typing.ts'
import { formatEditedLabel } from '@/lib/dates.ts'
import { cn } from '@/lib/utils.ts'
import { useToday } from '@/lib/use-today.ts'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { focusedNotePathForRoute } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'

const numberFormat = new Intl.NumberFormat()

/** Relative edit times ("5 min ago") refresh this often. */
const CLOCK_MS = 30_000

/** The bar steps aside while typing, returning after this pause (or a mouse move). */
const TYPING_IDLE_MS = 1500

/**
 * A translucent full-width status bar along the editor's bottom edge,
 * VS Code-style, for the note being edited — the routed note, or the focused
 * day in the stream: when it was last edited, and its live character count
 * (with the selection's, while there is one). Fades out while the user types,
 * Arc-style, and off in settings hides it. Never takes pointer events, so it
 * can't cover text the user clicks.
 */
export function NoteStatusBar(): ReactElement | null {
  const { route } = useRouter()
  const today = useToday()
  const focusedDailyDate = useFocusedDailyDate()
  const { settings } = useSettings()
  const path = focusedNotePathForRoute(route, today, focusedDailyDate)
  const status = useNoteStatus(path)
  const visible = settings.statusBarEnabled && status !== null
  const mtime = useNoteMtime(visible ? path : null)
  const now = useNow(CLOCK_MS)
  const typing = useTyping(TYPING_IDLE_MS)
  if (!visible) {
    return null
  }

  const editedAt = Math.max(mtime ?? 0, status.editedAt ?? 0)
  const characters = numberFormat.format(status.characters)
  return (
    <div
      role="status"
      aria-label="Note status"
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 z-10 flex h-6 items-center justify-end gap-3 border-t border-border/50 bg-surface/50 px-4 text-2xs tabular-nums text-text-muted backdrop-blur-[2px] transition-opacity duration-300',
        typing && 'opacity-0',
      )}
    >
      {editedAt > 0 ? (
        <span>{formatEditedLabel(editedAt, settings, new Date(Math.max(now, editedAt)))}</span>
      ) : null}
      <span>
        {status.selectedCharacters > 0
          ? `${numberFormat.format(status.selectedCharacters)} / ${characters} chars`
          : `${characters} chars`}
      </span>
    </div>
  )
}
