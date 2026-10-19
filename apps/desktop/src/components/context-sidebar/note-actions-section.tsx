import type { ReactElement } from 'react'
import {
  isLocalOnlyPath,
  isLocalOnlyReadOnlyPath,
  UNREADABLE_FRONTMATTER_HINT,
  UNREADABLE_FRONTMATTER_LABEL,
} from '@reflect/core'
import { Shield, ShieldOff } from 'lucide-react'
import { PinIcon } from '@/components/icons/pin-icon.tsx'
import { useLocalOnlyFolders } from '@/hooks/use-local-only-folders.ts'
import { useNoteRow } from '@/hooks/use-note-row.ts'
import { usePinnedNotes } from '@/hooks/use-pinned-notes.ts'
import { useUnreadableFrontmatter } from '@/hooks/use-unreadable-frontmatter.ts'
import { keybindingFor } from '@/lib/commands/app-commands.ts'
import { toggleNotePrivate } from '@/lib/note-privacy-toast.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
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

const PRIVACY_LABELS = {
  active: 'Make this note standard',
  inactive: 'Make this note private',
}
const UNREADABLE_LABELS = {
  active: UNREADABLE_FRONTMATTER_LABEL,
  inactive: UNREADABLE_FRONTMATTER_LABEL,
}

/**
 * "Note actions" as a context-sidebar section: mouse-reachable counterparts
 * to the note-scoped commands — pin/unpin and the `private` flag. Shared by
 * the daily and note context sidebars; dailies are valid targets for both.
 * Pin reads the pinned shelf and privacy reads the note row, both with the
 * note-row overlay every entrypoint writes merged over them; a note whose
 * frontmatter can't be read shows as locked with the toggle disabled. A note
 * inside a read-only local-only folder gets no section: every action would
 * write or publish it. One in an editable local-only folder keeps Pin (its
 * frontmatter stays in the folder) and Trash; privacy is gone because its
 * privacy is not a toggle, and Gist because it publishes.
 */
export function NoteActionsSection({
  path,
  showTrash = false,
}: NoteActionsSectionProps): ReactElement | null {
  const isPinned = usePinnedNotes().some((note) => note.path === path)
  const noteRow = useNoteRow(path)
  const isPrivate = noteRow?.isPrivate ?? false
  const unreadable = useUnreadableFrontmatter(path, isPrivate)
  const localOnlyFolders = useLocalOnlyFolders()
  const { noteActions } = useCoreServices()
  const togglePin = async (): Promise<void> => {
    await noteActions.togglePinned(path)
  }

  const togglePrivate = async (): Promise<void> => {
    await toggleNotePrivate(noteActions, path)
  }

  if (isLocalOnlyReadOnlyPath(localOnlyFolders, path)) {
    return null
  }
  const localOnly = isLocalOnlyPath(localOnlyFolders, path)

  return (
    <SidebarSection storageKey="note-actions" title="Note actions">
      <NoteActionButton
        isActive={isPinned}
        onClick={togglePin}
        icon={<PinIcon width={20} height={20} />}
        labels={{ active: 'Un-pin this note', inactive: 'Pin this note' }}
        keybinding={PIN_KEYBINDING}
      />
      {localOnly ? null : (
        <NoteActionButton
          isActive={isPrivate}
          disabled={unreadable}
          onClick={togglePrivate}
          icon={
            isPrivate && !unreadable ? (
              <ShieldOff size={14} aria-hidden />
            ) : (
              <Shield size={14} aria-hidden />
            )
          }
          labels={unreadable ? UNREADABLE_LABELS : PRIVACY_LABELS}
          keybinding={PRIVATE_KEYBINDING}
          tooltip={
            unreadable
              ? UNREADABLE_FRONTMATTER_HINT
              : isPrivate
                ? 'Allows this note to use AI. Backup and sync still include it.'
                : 'Blocks this note from AI. Backup and sync still include it.'
          }
        />
      )}
      {localOnly ? null : <NoteGistAction path={path} keybinding={GIST_KEYBINDING} />}
      {showTrash ? <NoteTrashAction path={path} /> : null}
    </SidebarSection>
  )
}
