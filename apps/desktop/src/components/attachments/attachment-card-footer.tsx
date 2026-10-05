import type { MouseEvent, ReactElement } from 'react'
import { displayNoteTitle, type AttachmentLibraryEntry } from '@reflect/core'
import { NoteStateIndicator } from '@/components/note-state-indicator.tsx'
import { formatRecencyLabel } from '@/lib/dates.ts'
import { useSettings } from '@/providers/settings-provider.tsx'
import { attachmentFilename, CARD_FOOTER_HEIGHT } from './attachment-media.ts'

interface AttachmentCardFooterProps {
  entry: AttachmentLibraryEntry
  onOpenNote: (path: string, event: MouseEvent) => void
}

function noteLabel(title: string): string {
  return displayNoteTitle(title) || 'Untitled'
}

/**
 * A card's caption: the filename, the most recently edited note linking to the
 * file (a link to it; ⌘-click opens a window) with a count of any others, and
 * when the file last changed. A file with no linking note found in the index
 * says so.
 */
export function AttachmentCardFooter({
  entry,
  onOpenNote,
}: AttachmentCardFooterProps): ReactElement {
  const { settings } = useSettings()
  const [firstNote, ...otherNotes] = entry.notes
  return (
    <div
      className="flex flex-none flex-col justify-center gap-0.5 px-2.5"
      style={{ height: CARD_FOOTER_HEIGHT }}
    >
      <span title={entry.path} className="truncate text-xs font-medium text-text">
        {attachmentFilename(entry.path)}
      </span>
      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-text-muted">
        {firstNote === undefined ? (
          <span className="truncate italic">No links found</span>
        ) : (
          <button
            type="button"
            title={entry.notes.map((note) => noteLabel(note.title)).join('\n')}
            onClick={(event) => onOpenNote(firstNote.path, event)}
            className="min-w-0 truncate text-left hover:text-text hover:underline"
          >
            <NoteStateIndicator
              path={firstNote.path}
              isPrivate={firstNote.isPrivate}
              hasConflict={firstNote.hasConflict}
              className="mr-1"
            />
            {noteLabel(firstNote.title)}
          </button>
        )}
        {otherNotes.length > 0 ? (
          <span className="shrink-0 tabular-nums">+{otherNotes.length}</span>
        ) : null}
        <span className="ml-auto shrink-0 pl-1">
          {formatRecencyLabel(entry.modifiedMs, settings)}
        </span>
      </div>
    </div>
  )
}
