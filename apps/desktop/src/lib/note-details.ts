import type { NoteState } from '@reflect/core'
import type { NoteGitVersion } from '@/hooks/use-note-git-version.ts'
import type { BackupState } from '@/lib/backup-controller.ts'

/** One row of the status menu: a short label and, when needed, what it means. */
export interface NoteDetail {
  readonly name: 'Editing' | 'Privacy' | 'Backup' | 'Version'
  /** One or two words, scannable down the column. */
  readonly value: string
  /** The consequence of the value in a sentence, or null when it needs none. */
  readonly hint: string | null
  /** Whether the value is an identifier, such as a commit hash. */
  readonly monospace?: boolean
}

interface NoteDetailsInput {
  readonly state: NoteState
  readonly backup: BackupState | undefined
  readonly version: NoteGitVersion
}

function editingDetail(state: NoteState): NoteDetail {
  if (state.isProtected) {
    return { name: 'Editing', value: 'Paused', hint: null }
  }
  if (state.isReadOnly) {
    return {
      name: 'Editing',
      value: 'Read-only',
      hint: state.isLocalOnly
        ? 'Its folder isn’t editable in Reflect. Edit it in another app.'
        : null,
    }
  }
  return { name: 'Editing', value: 'Editable', hint: null }
}

function privacyDetail(state: NoteState): NoteDetail {
  if (state.isLocalOnly) {
    return {
      name: 'Privacy',
      value: 'Local-only',
      hint: 'Stays on this device. Never synced or sent to AI.',
    }
  }
  if (state.isPrivate) {
    return { name: 'Privacy', value: 'Private', hint: 'Never sent to AI or other services.' }
  }
  return { name: 'Privacy', value: 'Standard', hint: null }
}

function backupDetail(state: NoteState, backup: BackupState | undefined): NoteDetail {
  if (state.isLocalOnly) {
    return { name: 'Backup', value: 'Never backed up', hint: null }
  }
  if (backup?.phase === 'loading') {
    return { name: 'Backup', value: 'Checking', hint: null }
  }
  if (backup?.phase !== 'connected') {
    return { name: 'Backup', value: 'Backup off', hint: null }
  }
  const { status } = backup
  switch (status.state) {
    case 'idle':
      return { name: 'Backup', value: 'Backed up', hint: null }
    case 'syncing':
      return { name: 'Backup', value: 'Syncing', hint: null }
    case 'offline':
      return {
        name: 'Backup',
        value: 'Offline',
        hint: 'Changes sync once the remote is reachable.',
      }
    case 'error':
      return { name: 'Backup', value: 'Sync failed', hint: status.message }
  }
}

function versionDetail(version: NoteGitVersion): NoteDetail {
  if (version.unavailable) {
    return { name: 'Version', value: 'Unavailable', hint: null }
  }
  if (version.version !== null) {
    return { name: 'Version', value: version.version, hint: null, monospace: true }
  }
  if (version.pending) {
    return { name: 'Version', value: 'Loading', hint: null }
  }
  return { name: 'Version', value: 'Uncommitted', hint: null }
}

/** The status menu's sections: what this note is, then how Git backup treats it. */
export interface NoteDetailSections {
  readonly note: readonly [privacy: NoteDetail, editing: NoteDetail]
  /** Local-only notes never touch Git, so they have no Version row. */
  readonly backup: readonly NoteDetail[]
}

/**
 * The note's independent dimensions, each as a short label with the
 * consequence spelled out only where the label alone would not say it.
 */
export function noteDetails({ state, backup, version }: NoteDetailsInput): NoteDetailSections {
  const backupRow = backupDetail(state, backup)
  return {
    note: [privacyDetail(state), editingDetail(state)],
    backup: state.isLocalOnly ? [backupRow] : [backupRow, versionDetail(version)],
  }
}
