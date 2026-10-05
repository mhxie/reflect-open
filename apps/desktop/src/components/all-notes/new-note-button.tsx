import type { ReactElement } from 'react'
import { FilePlus2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip.tsx'
import { keybindingFor, newNoteRoute } from '@/lib/commands/app-commands.ts'
import { formatBindingLabel } from '@/lib/keybindings.ts'
import { useRouter } from '@/routing/router.tsx'

const NEW_NOTE_BINDING = keybindingFor('note.new')

/**
 * The All Notes header's primary action — the same fresh-note route as ⌘N
 * (created lazily on the first keystroke), with a compact icon in narrow panes.
 */
export function NewNoteButton(): ReactElement {
  const { navigate } = useRouter()
  const button = (
    <button
      type="button"
      aria-label="New note"
      onClick={() => navigate(newNoteRoute())}
      className="flex h-8 w-8 shrink-0 items-center justify-center gap-2 rounded-lg bg-accent py-1.5 text-sm font-medium text-text-on-brand shadow-sm transition-colors duration-100 hover:bg-accent-hover focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none @xl/all-notes:w-auto @xl/all-notes:px-3"
    >
      <FilePlus2 aria-hidden className="size-3.5 @xl/all-notes:hidden" />
      <span className="hidden @xl/all-notes:inline">New note</span>
      {NEW_NOTE_BINDING !== null ? (
        <span
          aria-hidden
          className="hidden rounded bg-white/20 px-1 py-px text-[11px] font-medium @xl/all-notes:inline"
        >
          {formatBindingLabel(NEW_NOTE_BINDING)}
        </span>
      ) : null}
    </button>
  )
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent>
        New note{NEW_NOTE_BINDING === null ? '' : ` (${formatBindingLabel(NEW_NOTE_BINDING)})`}
      </TooltipContent>
    </Tooltip>
  )
}
