import { describe, expect, it } from 'vitest'
import { createLocalOnlyFolders, NO_LOCAL_ONLY_FOLDERS } from './local-only.ts'
import { deriveNoteState } from './note-state.ts'

describe('deriveNoteState', () => {
  it('allows an ordinary daily note to use AI according to its explicit privacy flag', () => {
    expect(
      deriveNoteState(NO_LOCAL_ONLY_FOLDERS, { path: 'daily/2026-10-05.md', isPrivate: false }),
    ).toEqual({
      kind: 'editable',
      isPrivate: false,
      isLocalOnly: false,
      isReadOnly: false,
      isProtected: false,
    })
    expect(
      deriveNoteState(NO_LOCAL_ONLY_FOLDERS, { path: 'daily/2026-10-05.md', isPrivate: true }).kind,
    ).toBe('private')
  })

  it('keeps a Private note editable and eligible for Git backup', () => {
    const state = deriveNoteState(NO_LOCAL_ONLY_FOLDERS, {
      path: 'notes/private.md',
      isPrivate: true,
    })
    expect(state.kind).toBe('private')
    expect(state.isReadOnly).toBe(false)
    expect(state.isLocalOnly).toBe(false)
  })

  it('makes Local-only notes Private and read-only by default', () => {
    const localOnly = createLocalOnlyFolders(['secure'])
    expect(deriveNoteState(localOnly, { path: 'secure/a.md', isPrivate: false })).toEqual({
      kind: 'read-only',
      isPrivate: true,
      isLocalOnly: true,
      isReadOnly: true,
      isProtected: false,
    })
  })

  it('shows Local-only rather than a lock when its path permits editing', () => {
    const localOnly = createLocalOnlyFolders(['secure'], ['secure'])
    const state = deriveNoteState(localOnly, { path: 'secure/a.md', isPrivate: false })
    expect(state.kind).toBe('local-only')
    expect(state.isReadOnly).toBe(false)
    expect(state.isPrivate).toBe(true)
  })

  it('does not grant editing through an editable folder nested in a read-only one', () => {
    const localOnly = createLocalOnlyFolders(['secure', 'drafts'], ['drafts'])
    expect(deriveNoteState(localOnly, { path: 'secure/drafts/a.md', isPrivate: false }).kind).toBe(
      'read-only',
    )
  })

  it('decides with the folders it is given, not another graph’s', () => {
    // The same path is an ordinary note in a graph without the folder.
    expect(
      deriveNoteState(NO_LOCAL_ONLY_FOLDERS, { path: 'secure/a.md', isPrivate: false }).kind,
    ).toBe('editable')
  })

  it('reflects a live editing block independently of privacy', () => {
    const state = deriveNoteState(NO_LOCAL_ONLY_FOLDERS, {
      path: 'notes/a.md',
      isPrivate: false,
      readOnly: true,
    })
    expect(state.kind).toBe('read-only')
    expect(state.isPrivate).toBe(false)
  })

  it.each([{ protected: true }])(
    'keeps protection independent of the privacy flag: %j',
    (flags) => {
      const state = deriveNoteState(NO_LOCAL_ONLY_FOLDERS, {
        path: 'notes/a.md',
        isPrivate: false,
        ...flags,
      })
      expect(state.kind).toBe('protected')
      expect(state.isReadOnly).toBe(true)
      expect(state.isPrivate).toBe(false)
    },
  )

  it.each([{ protected: true }])(
    'gives protection priority while preserving the other dimensions: %j',
    (flags) => {
      const localOnly = createLocalOnlyFolders(['secure'], ['secure'])
      const state = deriveNoteState(localOnly, { path: 'secure/a.md', isPrivate: false, ...flags })
      expect(state.kind).toBe('protected')
      expect(state.isProtected).toBe(true)
      expect(state.isReadOnly).toBe(true)
      expect(state.isLocalOnly).toBe(true)
      expect(state.isPrivate).toBe(true)
    },
  )
})
