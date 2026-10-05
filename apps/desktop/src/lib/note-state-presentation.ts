import {
  FileText,
  FileWarning,
  HardDrive,
  LockKeyhole,
  Shield,
  type LucideIcon,
} from 'lucide-react'
import type { NoteState, NoteStateKind } from '@reflect/core'

interface NoteStatePresentation {
  readonly label: string
  /** What the state means for the note, in one short sentence; null for the default. */
  readonly description: string | null
  readonly icon: LucideIcon
  readonly className: string
}

const presentations: Record<NoteStateKind, NoteStatePresentation> = {
  editable: {
    label: 'Editable',
    description: null,
    icon: FileText,
    className: 'text-text-secondary',
  },
  private: {
    label: 'Private',
    description: 'Never sent to AI or other services',
    icon: Shield,
    className: 'text-note-state-private',
  },
  'local-only': {
    label: 'Local-only',
    description: 'Stays on this device, never synced or sent to AI',
    icon: HardDrive,
    className: 'text-note-state-local-only',
  },
  'read-only': {
    label: 'Read-only',
    description: 'Can’t be edited in Reflect',
    icon: LockKeyhole,
    className: 'text-text-secondary',
  },
  protected: {
    label: 'Protected',
    description: 'Editing is paused until an issue is resolved',
    icon: FileWarning,
    className: 'text-note-state-protected',
  },
}

/** The shared access-state presentation, independent of Git backup and sync. */
export function noteStatePresentation(kind: NoteStateKind): NoteStatePresentation {
  return presentations[kind]
}

/**
 * Every state that applies to the note, most urgent first, so a compact
 * display that has room for more than one word never hides a privacy flag
 * behind an edit gate. The first entry is always `state.kind`. Local-only
 * implies Private, and Protected implies Read-only, so neither repeats.
 */
export function activeNoteStateKinds(state: NoteState): readonly NoteStateKind[] {
  const kinds: NoteStateKind[] = []
  if (state.isProtected) {
    kinds.push('protected')
  } else if (state.isReadOnly) {
    kinds.push('read-only')
  }
  if (state.isLocalOnly) {
    kinds.push('local-only')
  } else if (state.isPrivate) {
    kinds.push('private')
  }
  return kinds.length === 0 ? ['editable'] : kinds
}
