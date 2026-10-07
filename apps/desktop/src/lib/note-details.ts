import type { NoteState } from '@reflect/core'
import type { NoteGitVersion } from '@/hooks/use-note-git-version.ts'
import type { BackupState } from '@/lib/backup-controller.ts'

interface NoteDetailRow<Name extends string, Status extends string> {
  readonly name: Name
  /** What the row reports, for presentation to key on instead of the label text. */
  readonly status: Status
  /** One or two words, scannable down the column. */
  readonly value: string
  /** The consequence of the value in a sentence, or null when it needs none. */
  readonly hint: string | null
}

export type PrivacyDetail = NoteDetailRow<'Privacy', 'local-only' | 'private' | 'standard'>
export type EditingDetail = NoteDetailRow<'Editing', 'paused' | 'read-only' | 'editable'>
export type BackupDetail = NoteDetailRow<
  'Backup',
  'never' | 'checking' | 'off' | 'backed-up' | 'syncing' | 'offline' | 'failed'
>
/** A `committed` row's value is the commit hash itself. */
export type VersionDetail = NoteDetailRow<
  'Version',
  'unavailable' | 'committed' | 'loading' | 'uncommitted'
>

/** One row of the status menu: a short label and, when needed, what it means. */
export type NoteDetail = PrivacyDetail | EditingDetail | BackupDetail | VersionDetail

interface NoteDetailsInput {
  readonly state: NoteState
  readonly backup: BackupState | undefined
  readonly version: NoteGitVersion
}

function editingDetail(state: NoteState): EditingDetail {
  if (state.isProtected) {
    return { name: 'Editing', status: 'paused', value: 'Paused', hint: null }
  }
  if (state.isReadOnly) {
    return {
      name: 'Editing',
      status: 'read-only',
      value: 'Read-only',
      hint: state.isLocalOnly
        ? 'Its folder isn’t editable in Reflect. Edit it in another app.'
        : null,
    }
  }
  return { name: 'Editing', status: 'editable', value: 'Editable', hint: null }
}

function privacyDetail(state: NoteState): PrivacyDetail {
  if (state.isLocalOnly) {
    return {
      name: 'Privacy',
      status: 'local-only',
      value: 'Local-only',
      hint: 'Stays on this device. Never synced or sent to AI.',
    }
  }
  if (state.isPrivate) {
    return {
      name: 'Privacy',
      status: 'private',
      value: 'Private',
      hint: 'Never sent to AI or other services.',
    }
  }
  return { name: 'Privacy', status: 'standard', value: 'Standard', hint: null }
}

function backupDetail(state: NoteState, backup: BackupState | undefined): BackupDetail {
  if (state.isLocalOnly) {
    return { name: 'Backup', status: 'never', value: 'Never backed up', hint: null }
  }
  if (backup?.phase === 'loading') {
    return { name: 'Backup', status: 'checking', value: 'Checking', hint: null }
  }
  if (backup?.phase !== 'connected') {
    return { name: 'Backup', status: 'off', value: 'Backup off', hint: null }
  }
  const { status } = backup
  switch (status.state) {
    case 'idle':
      return { name: 'Backup', status: 'backed-up', value: 'Backed up', hint: null }
    case 'syncing':
      return { name: 'Backup', status: 'syncing', value: 'Syncing', hint: null }
    case 'offline':
      return {
        name: 'Backup',
        status: 'offline',
        value: 'Offline',
        hint: 'Changes sync once the remote is reachable.',
      }
    case 'error':
      return { name: 'Backup', status: 'failed', value: 'Sync failed', hint: status.message }
  }
}

function versionDetail(version: NoteGitVersion): VersionDetail {
  if (version.unavailable) {
    return { name: 'Version', status: 'unavailable', value: 'Unavailable', hint: null }
  }
  if (version.version !== null) {
    return { name: 'Version', status: 'committed', value: version.version, hint: null }
  }
  if (version.pending) {
    return { name: 'Version', status: 'loading', value: 'Loading', hint: null }
  }
  return { name: 'Version', status: 'uncommitted', value: 'Uncommitted', hint: null }
}

/** The status menu's sections: what this note is, then how Git backup treats it. */
export interface NoteDetailSections {
  readonly note: readonly [privacy: PrivacyDetail, editing: EditingDetail]
  /** Local-only notes never touch Git, so they have no Version row. */
  readonly backup: readonly [backup: BackupDetail, version?: VersionDetail]
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
