import { describe, expect, it } from 'vitest'
import type { NoteState } from '@reflect/core'
import type { BackupState } from '@/lib/backup-controller.ts'
import { noteDetails } from './note-details.ts'

const EDITABLE: NoteState = {
  kind: 'editable',
  isPrivate: false,
  isLocalOnly: false,
  isReadOnly: false,
  isProtected: false,
}
const COMMITTED = { version: 'abc123def4', pending: false, unavailable: false }

function connected(status: Extract<BackupState, { phase: 'connected' }>['status']): BackupState {
  return { phase: 'connected', remoteUrl: 'https://github.com/test/notes', repo: null, status }
}

function backupLabel(backup: BackupState | undefined, state: NoteState = EDITABLE): string {
  return noteDetails({ state, backup, version: COMMITTED }).backup[0]?.value ?? ''
}

describe('noteDetails', () => {
  it('describes an ordinary backed-up note without explaining the obvious', () => {
    expect(
      noteDetails({ state: EDITABLE, backup: connected({ state: 'idle' }), version: COMMITTED }),
    ).toEqual({
      note: [
        { name: 'Privacy', status: 'standard', value: 'Standard', hint: null },
        { name: 'Editing', status: 'editable', value: 'Editable', hint: null },
      ],
      backup: [
        { name: 'Backup', status: 'backed-up', value: 'Backed up', hint: null },
        { name: 'Version', status: 'committed', value: 'abc123def4', hint: null },
      ],
    })
  })

  it('says what keeping a note private means', () => {
    const { note } = noteDetails({
      state: { ...EDITABLE, kind: 'private', isPrivate: true },
      backup: connected({ state: 'idle' }),
      version: COMMITTED,
    })
    expect(note[0]).toEqual({
      name: 'Privacy',
      status: 'private',
      value: 'Private',
      hint: 'Never sent to AI or other services.',
    })
  })

  it('explains a read-only local-only note and leaves Git out of it', () => {
    const { note, backup } = noteDetails({
      state: {
        kind: 'read-only',
        isPrivate: true,
        isLocalOnly: true,
        isReadOnly: true,
        isProtected: false,
      },
      backup: connected({ state: 'idle' }),
      version: COMMITTED,
    })
    expect(note).toEqual([
      {
        name: 'Privacy',
        status: 'local-only',
        value: 'Local-only',
        hint: 'Stays on this device. Never synced or sent to AI.',
      },
      {
        name: 'Editing',
        status: 'read-only',
        value: 'Read-only',
        hint: 'Its folder isn’t editable in Reflect. Edit it in another app.',
      },
    ])
    expect(backup).toEqual([
      { name: 'Backup', status: 'never', value: 'Never backed up', hint: null },
    ])
  })

  it('pauses editing on a protected note', () => {
    const { note } = noteDetails({
      state: { ...EDITABLE, kind: 'protected', isReadOnly: true, isProtected: true },
      backup: undefined,
      version: COMMITTED,
    })
    expect(note[1]).toEqual({ name: 'Editing', status: 'paused', value: 'Paused', hint: null })
  })

  it('folds live graph sync into the Backup row', () => {
    expect(backupLabel({ phase: 'loading' })).toBe('Checking')
    expect(backupLabel({ phase: 'disconnected' })).toBe('Backup off')
    expect(backupLabel(connected({ state: 'syncing' }))).toBe('Syncing')
    expect(
      noteDetails({
        state: EDITABLE,
        backup: connected({ state: 'offline', message: 'unreachable' }),
        version: COMMITTED,
      }).backup[0],
    ).toEqual({
      name: 'Backup',
      status: 'offline',
      value: 'Offline',
      hint: 'Changes sync once the remote is reachable.',
    })
    expect(
      noteDetails({
        state: EDITABLE,
        backup: connected({ state: 'error', errorKind: 'auth', message: 'Token expired' }),
        version: COMMITTED,
      }).backup[0],
    ).toEqual({ name: 'Backup', status: 'failed', value: 'Sync failed', hint: 'Token expired' })
  })

  it('reports the version lookup without claiming a commit it has not seen', () => {
    const version = (pending: boolean, unavailable: boolean): string =>
      noteDetails({
        state: EDITABLE,
        backup: undefined,
        version: { version: null, pending, unavailable },
      }).backup[1]?.value ?? ''
    expect(version(true, false)).toBe('Loading')
    expect(version(false, true)).toBe('Unavailable')
    expect(version(false, false)).toBe('Uncommitted')
  })
})
