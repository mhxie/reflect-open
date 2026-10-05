import { describe, expect, it } from 'vitest'
import { deriveNoteState } from '@reflect/core'
import { activeNoteStateKinds } from './note-state-presentation.ts'

const ORDINARY = {
  kind: 'editable',
  isPrivate: false,
  isLocalOnly: false,
  isReadOnly: false,
  isProtected: false,
} as const

describe('activeNoteStateKinds', () => {
  it('names an ordinary note Editable alone', () => {
    expect(activeNoteStateKinds(ORDINARY)).toEqual(['editable'])
  })

  it('keeps Private visible next to an edit gate', () => {
    expect(
      activeNoteStateKinds(
        deriveNoteState({ path: 'notes/a.md', isPrivate: true, protected: true }),
      ),
    ).toEqual(['protected', 'private'])
    expect(
      activeNoteStateKinds({ ...ORDINARY, kind: 'read-only', isReadOnly: true, isPrivate: true }),
    ).toEqual(['read-only', 'private'])
  })

  it('lets Local-only stand for Private and Protected stand for Read-only', () => {
    expect(
      activeNoteStateKinds({
        kind: 'protected',
        isPrivate: true,
        isLocalOnly: true,
        isReadOnly: true,
        isProtected: true,
      }),
    ).toEqual(['protected', 'local-only'])
    expect(
      activeNoteStateKinds({ ...ORDINARY, kind: 'local-only', isPrivate: true, isLocalOnly: true }),
    ).toEqual(['local-only'])
  })

  it('always leads with the primary kind', () => {
    for (const input of [
      { path: 'notes/a.md', isPrivate: false },
      { path: 'notes/a.md', isPrivate: true },
      { path: 'notes/a.md', isPrivate: true, readOnly: true },
      { path: 'notes/a.md', isPrivate: false, hasConflict: true },
    ]) {
      const state = deriveNoteState(input)
      expect(activeNoteStateKinds(state)[0]).toBe(state.kind)
    }
  })
})
