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

function values(...args: Parameters<typeof noteDetails>): Record<string, string> {
  return Object.fromEntries(noteDetails(...args).map((detail) => [detail.name, detail.value]))
}

describe('noteDetails', () => {
  it('describes an ordinary backed-up note', () => {
    const details = noteDetails({
      state: EDITABLE,
      backup: connected({ state: 'idle' }),
      version: COMMITTED,
    })
    expect(details).toEqual([
      { name: 'Editing', value: 'Editable', hint: null },
      { name: 'Privacy', value: 'Standard', hint: 'AI features can read this note.' },
      { name: 'Backup', value: 'Included', hint: null },
      { name: 'Version', value: 'abc123def4', hint: null, monospace: true },
    ])
  })

  it('says a private note is kept from AI but still backed up', () => {
    const [, privacy] = noteDetails({
      state: { ...EDITABLE, kind: 'private', isPrivate: true },
      backup: connected({ state: 'idle' }),
      version: COMMITTED,
    })
    expect(privacy).toEqual({
      name: 'Privacy',
      value: 'Private',
      hint: 'Never sent to AI or other services. Backup still includes it.',
    })
  })

  it('explains a read-only local-only note and leaves Git out of it', () => {
    const details = noteDetails({
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
    expect(details.map((detail) => detail.name)).toEqual(['Editing', 'Privacy', 'Backup'])
    expect(details[0]?.hint).toBe('Its local-only folder isn’t editable in Reflect.')
    expect(details[1]?.value).toBe('Local-only')
    expect(details[2]).toEqual({
      name: 'Backup',
      value: 'Excluded',
      hint: 'Never committed or synced.',
    })
  })

  it('points a protected note at the recovery shown above', () => {
    const [editing] = noteDetails({
      state: { ...EDITABLE, kind: 'protected', isReadOnly: true, isProtected: true },
      backup: undefined,
      version: COMMITTED,
    })
    expect(editing).toEqual({
      name: 'Editing',
      value: 'Paused',
      hint: 'Resolve the issue above to keep editing.',
    })
  })

  it('folds live graph sync into the Backup value', () => {
    const version = COMMITTED
    expect(values({ state: EDITABLE, backup: { phase: 'loading' }, version }).Backup).toBe(
      'Checking',
    )
    expect(values({ state: EDITABLE, backup: { phase: 'disconnected' }, version }).Backup).toBe(
      'Off',
    )
    expect(
      values({ state: EDITABLE, backup: connected({ state: 'syncing' }), version }).Backup,
    ).toBe('Syncing')
    expect(
      values({
        state: EDITABLE,
        backup: connected({ state: 'offline', message: 'unreachable' }),
        version,
      }).Backup,
    ).toBe('Offline')
    const [, , failed] = noteDetails({
      state: EDITABLE,
      backup: connected({ state: 'error', errorKind: 'auth', message: 'Token expired' }),
      version,
    })
    expect(failed).toEqual({ name: 'Backup', value: 'Sync failed', hint: 'Token expired' })
  })

  it('reports the version lookup without claiming a commit it has not seen', () => {
    const state = EDITABLE
    const backup = undefined
    expect(
      values({ state, backup, version: { version: null, pending: true, unavailable: false } })
        .Version,
    ).toBe('Loading')
    expect(
      values({ state, backup, version: { version: null, pending: false, unavailable: true } })
        .Version,
    ).toBe('Unavailable')
    expect(
      values({ state, backup, version: { version: null, pending: false, unavailable: false } })
        .Version,
    ).toBe('Uncommitted')
  })
})
