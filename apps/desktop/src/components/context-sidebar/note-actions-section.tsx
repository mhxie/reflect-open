import type { ReactElement } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { isLocalOnlyPath } from '@reflect/core'
import { Lock } from 'lucide-react'
import { PinIcon } from '@/components/icons/pin-icon.tsx'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { useUnreadableFrontmatter } from '@/hooks/use-unreadable-frontmatter.ts'
import { keybindingFor } from '@/lib/commands/app-commands.ts'
import { toggleNotePinned } from '@/lib/note-pin.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import {
  toggleNotePrivate,
  UNREADABLE_FRONTMATTER_HINT,
  UNREADABLE_FRONTMATTER_LABEL,
} from '@/lib/note-private.ts'
import { NoteActionButton } from './note-action-button.tsx'
import { NoteGistAction } from './note-gist-action.tsx'
import { NoteTrashAction } from './note-trash-action.tsx'
import { SidebarSection } from './sidebar-section.tsx'

interface NoteActionsSectionProps {
  /** Graph-relative path of the note the actions operate on. */
  path: string
  /** Whether this context can offer deleting the note. Daily sidebars leave this off. */
  showTrash?: boolean
}

// Derived from the command definitions so the hints can never drift from the
// real bindings (the same contract as the Today hint).
const PIN_KEYBINDING = keybindingFor('note.togglePin')
const PRIVATE_KEYBINDING = keybindingFor('note.togglePrivate')
const GIST_KEYBINDING = keybindingFor('note.publishGist')

const LOCK_LABELS = { active: 'Unlock note', inactive: 'Lock note' }
const UNREADABLE_LABELS = {
  active: UNREADABLE_FRONTMATTER_LABEL,
  inactive: UNREADABLE_FRONTMATTER_LABEL,
}

/**
 * "Note actions" as a context-sidebar section: mouse-reachable counterparts
 * to the note-scoped commands — pin/unpin and the `private` flag. Shared by
 * the daily and note context sidebars; dailies are valid targets for both.
 * Pin reads the shared shelf cache, updated immediately by every pin entrypoint.
 * Privacy reads the note row cache shared by the palette and mobile actions;
 * a note whose frontmatter can't be read shows as locked with the toggle
 * disabled. A note inside a local-only folder gets no section: every action
 * would write or publish it, and its privacy is not a toggle.
 */
export function NoteActionsSection({
  path,
  showTrash = false,
}: NoteActionsSectionProps): ReactElement | null {
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const noteRow = useNoteRow(path)
  const isPrivate = noteRow?.isPrivate ?? false
  const unreadable = useUnreadableFrontmatter(path, isPrivate)
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const togglePin = async (): Promise<void> => {
    if (graph !== null) {
      await toggleNotePinned({
        queryClient,
        root: graph.root,
        generation: graph.generation,
        path,
      })
    }
  }

  const togglePrivate = async (): Promise<void> => {
    if (graph !== null) {
      await toggleNotePrivate({ queryClient, root: graph.root, generation: graph.generation, path })
    }
  }

  if (isLocalOnlyPath(path)) {
    return null
  }

  return (
    <SidebarSection storageKey="note-actions" title="Note actions">
      <NoteActionButton
        isActive={isPinned}
        onClick={togglePin}
        icon={<PinIcon width={20} height={20} />}
        labels={{ active: 'Un-pin this note', inactive: 'Pin this note' }}
        keybinding={PIN_KEYBINDING}
      />
      <NoteActionButton
        isActive={isPrivate}
        disabled={unreadable}
        onClick={togglePrivate}
        icon={<Lock size={14} aria-hidden />}
        labels={unreadable ? UNREADABLE_LABELS : LOCK_LABELS}
        keybinding={PRIVATE_KEYBINDING}
        tooltip={
          unreadable
            ? UNREADABLE_FRONTMATTER_HINT
            : 'Locks this note out of AI. Backup and sync still include it.'
        }
      />
      <NoteGistAction path={path} keybinding={GIST_KEYBINDING} />
      {showTrash ? <NoteTrashAction path={path} /> : null}
    </SidebarSection>
  )
}
