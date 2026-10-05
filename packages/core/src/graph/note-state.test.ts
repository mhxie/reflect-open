import { afterEach, describe, expect, it } from 'vitest'
import { setLocalOnlyFolders } from './local-only.ts'
import { deriveNoteState } from './note-state.ts'

afterEach(() => setLocalOnlyFolders([]))

describe('deriveNoteState', () => {
  it('allows an ordinary daily note to use AI according to its explicit privacy flag', () => {
    expect(deriveNoteState({ path: 'daily/2026-10-05.md', isPrivate: false })).toEqual({
      kind: 'editable',
      isPrivate: false,
      isLocalOnly: false,
      isReadOnly: false,
      isProtected: false,
    })
    expect(deriveNoteState({ path: 'daily/2026-10-05.md', isPrivate: true }).kind).toBe('private')
  })

  it('keeps a Private note editable and eligible for Git backup', () => {
    const state = deriveNoteState({ path: 'notes/private.md', isPrivate: true })
    expect(state.kind).toBe('private')
    expect(state.isReadOnly).toBe(false)
    expect(state.isLocalOnly).toBe(false)
  })

  it('makes Local-only notes Private and read-only by default', () => {
    setLocalOnlyFolders(['secure'])
    expect(deriveNoteState({ path: 'secure/a.md', isPrivate: false })).toEqual({
      kind: 'read-only',
      isPrivate: true,
      isLocalOnly: true,
      isReadOnly: true,
      isProtected: false,
    })
  })

  it('shows Local-only rather than a lock when its path permits editing', () => {
    setLocalOnlyFolders(['secure'], ['secure'])
    const state = deriveNoteState({ path: 'secure/a.md', isPrivate: false })
    expect(state.kind).toBe('local-only')
    expect(state.isReadOnly).toBe(false)
    expect(state.isPrivate).toBe(true)
  })

  it('does not grant editing through an editable folder nested in a read-only one', () => {
    setLocalOnlyFolders(['secure', 'drafts'], ['drafts'])
    expect(deriveNoteState({ path: 'secure/drafts/a.md', isPrivate: false }).kind).toBe('read-only')
  })

  it('reflects a live editing block independently of privacy', () => {
    const state = deriveNoteState({ path: 'notes/a.md', isPrivate: false, readOnly: true })
    expect(state.kind).toBe('read-only')
    expect(state.isPrivate).toBe(false)
  })

  it.each([{ protected: true }, { hasConflict: true }])(
    'keeps protection independent of the privacy flag: %j',
    (flags) => {
      const state = deriveNoteState({ path: 'notes/a.md', isPrivate: false, ...flags })
      expect(state.kind).toBe('protected')
      expect(state.isReadOnly).toBe(true)
      expect(state.isPrivate).toBe(false)
    },
  )

  it.each([{ protected: true }, { hasConflict: true }])(
    'gives protection priority while preserving the other dimensions: %j',
    (flags) => {
      setLocalOnlyFolders(['secure'], ['secure'])
      const state = deriveNoteState({ path: 'secure/a.md', isPrivate: false, ...flags })
      expect(state.kind).toBe('protected')
      expect(state.isProtected).toBe(true)
      expect(state.isReadOnly).toBe(true)
      expect(state.isLocalOnly).toBe(true)
      expect(state.isPrivate).toBe(true)
    },
  )
})
