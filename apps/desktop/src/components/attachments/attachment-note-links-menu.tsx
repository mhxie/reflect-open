import type { MouseEvent, ReactElement } from 'react'
import { displayNoteTitle, type AttachmentNoteRef } from '@reflect/core'
import { NoteStateIndicator } from '@/components/note-state-indicator.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx'

interface AttachmentNoteLinksMenuProps {
  /** Every note linking to the file, most recently edited first. */
  notes: readonly AttachmentNoteRef[]
  /** The file's name, for the trigger's (and so the menu's) accessible name. */
  filename: string
  /** Open a note; ⌘-click (or ⌘Return) opens it in a new window. */
  onOpenNote: (path: string, event: MouseEvent) => void
}

/**
 * An Attachments card's "+N" control for a file more than one note links to:
 * a menu of every linking note, each opening that note, so the notes past the
 * first stay one click or keypress away.
 */
export function AttachmentNoteLinksMenu({
  notes,
  filename,
  onOpenNote,
}: AttachmentNoteLinksMenuProps): ReactElement {
  const others = notes.length - 1
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`${others} more ${others === 1 ? 'note links' : 'notes link'} to ${filename}`}
            className="shrink-0 rounded px-0.5 tabular-nums hover:bg-surface-hover hover:text-text"
          >
            +{others}
          </button>
        }
      />
      <DropdownMenuContent align="start" sideOffset={6} className="w-64">
        {notes.map((note) => (
          <DropdownMenuItem
            key={note.path}
            onClick={(event) => onOpenNote(note.path, event)}
            className="gap-1 px-2 py-1.5 text-[13px] text-text-secondary"
          >
            <NoteStateIndicator
              path={note.path}
              isPrivate={note.isPrivate}
              hasConflict={note.hasConflict}
            />
            <span className="min-w-0 flex-1 truncate">
              {displayNoteTitle(note.title) || 'Untitled'}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
