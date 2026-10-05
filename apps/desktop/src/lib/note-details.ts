import type { NoteState } from '@reflect/core'
import type { NoteGitVersion } from '@/hooks/use-note-git-version.ts'
import type { BackupState } from '@/lib/backup-controller.ts'

/** One row of the status bar's note details: a short value and what it means. */
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
    return { name: 'Editing', value: 'Paused', hint: 'Resolve the issue above to keep editing.' }
  }
  if (state.isReadOnly) {
    return {
      name: 'Editing',
      value: 'Read-only',
      hint: state.isLocalOnly ? 'Its local-only folder isn’t editable in Reflect.' : null,
    }
  }
  return { name: 'Editing', value: 'Editable', hint: null }
}

function privacyDetail(state: NoteState): NoteDetail {
  if (state.isLocalOnly) {
    return {
      name: 'Privacy',
      value: 'Local-only',
      hint: 'Stays on this device and is never sent to AI or other services.',
    }
  }
  if (state.isPrivate) {
    return {
      name: 'Privacy',
      value: 'Private',
      hint: 'Never sent to AI or other services. Backup still includes it.',
    }
  }
  return { name: 'Privacy', value: 'Standard', hint: 'AI features can read this note.' }
}

function backupDetail(state: NoteState, backup: BackupState | undefined): NoteDetail {
  if (state.isLocalOnly) {
    return { name: 'Backup', value: 'Excluded', hint: 'Never committed or synced.' }
  }
  if (backup?.phase === 'loading') {
    return { name: 'Backup', value: 'Checking', hint: null }
  }
  if (backup?.phase !== 'connected') {
    return { name: 'Backup', value: 'Off', hint: 'Git backup isn’t set up for this graph.' }
  }
  const { status } = backup
  switch (status.state) {
    case 'idle':
      return { name: 'Backup', value: 'Included', hint: null }
    case 'syncing':
      return { name: 'Backup', value: 'Syncing', hint: null }
    case 'offline':
      return {
        name: 'Backup',
        value: 'Offline',
        hint: 'Changes are committed locally and sync once the remote is reachable.',
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
  return { name: 'Version', value: 'Uncommitted', hint: 'Not in a backup commit yet.' }
}

/**
 * The note's independent dimensions, each with the consequence spelled out:
 * whether it can be edited, where its content may go, and how Git backup
 * treats it. Local-only notes never touch Git, so they have no Version row.
 */
export function noteDetails({ state, backup, version }: NoteDetailsInput): readonly NoteDetail[] {
  const details = [editingDetail(state), privacyDetail(state), backupDetail(state, backup)]
  return state.isLocalOnly ? details : [...details, versionDetail(version)]
}
