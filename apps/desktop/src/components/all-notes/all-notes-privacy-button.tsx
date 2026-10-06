import { useState, type ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isLocalOnlyPath, type NoteListEntry } from '@reflect/core'
import { Shield, ShieldOff } from 'lucide-react'
import { setNotesPrivate } from '@/lib/note-private.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { Button } from '@/components/ui/button.tsx'

interface AllNotesPrivacyButtonProps {
  /** The selected notes, as listed. */
  readonly notes: readonly NoteListEntry[]
}

/**
 * The selection's privacy action: marks every selected note private, or —
 * when all of them already are — makes them not private again. Local-only
 * notes are private by their folder, so they are left out, and the button
 * hides when nothing else is selected, and below the header width where it
 * would squeeze out the filters. The write offers one Undo; the list
 * follows once the index re-projects the changed files.
 */
export function AllNotesPrivacyButton({ notes }: AllNotesPrivacyButtonProps): ReactElement | null {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const targets = notes.filter((note) => !isLocalOnlyPath(note.path))
  if (targets.length === 0 || graph === null) {
    return null
  }
  const makePrivate = !targets.every((note) => note.isPrivate)
  const label = makePrivate ? 'Mark private' : 'Unmark private'

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      await setNotesPrivate(
        { queryClient, root: graph.root, generation: graph.generation },
        targets.map((note) => note.path),
        makePrivate,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={busy}
      aria-label={`${label} (${targets.length})`}
      onClick={() => void apply()}
      className="hidden px-2 text-text-secondary hover:text-note-state-private @sm/all-notes:inline-flex @3xl/all-notes:px-2.5"
    >
      {makePrivate ? (
        <Shield aria-hidden className="size-3.5" />
      ) : (
        <ShieldOff aria-hidden className="size-3.5" />
      )}
      <span className="hidden @3xl/all-notes:inline">{label}</span>
      <span
        aria-hidden
        className="flex h-4 min-w-4 items-center justify-center rounded-full bg-note-state-private/10 px-1 text-[10px] font-semibold leading-none tabular-nums text-note-state-private"
      >
        {targets.length}
      </span>
    </Button>
  )
}
