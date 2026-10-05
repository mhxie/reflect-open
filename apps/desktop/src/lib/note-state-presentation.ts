import {
  FileText,
  FileWarning,
  HardDrive,
  LockKeyhole,
  Shield,
  type LucideIcon,
} from 'lucide-react'
import type { NoteStateKind } from '@reflect/core'

interface NoteStatePresentation {
  readonly label: string
  readonly icon: LucideIcon
  readonly className: string
}

const presentations: Record<NoteStateKind, NoteStatePresentation> = {
  editable: { label: 'Editable', icon: FileText, className: 'text-text-secondary' },
  private: {
    label: 'Private',
    icon: Shield,
    className: 'text-note-state-private',
  },
  'local-only': {
    label: 'Local-only',
    icon: HardDrive,
    className: 'text-note-state-local-only',
  },
  'read-only': {
    label: 'Read-only',
    icon: LockKeyhole,
    className: 'text-text-secondary',
  },
  protected: {
    label: 'Protected',
    icon: FileWarning,
    className: 'text-note-state-protected',
  },
}

/** The shared access-state presentation, independent of Git backup and sync. */
export function noteStatePresentation(kind: NoteStateKind): NoteStatePresentation {
  return presentations[kind]
}
