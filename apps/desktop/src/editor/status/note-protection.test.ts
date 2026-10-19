import { describe, expect, it, vi } from 'vitest'
import { noteProtection, type NoteProtectionInput } from './note-protection.ts'

const clear: NoteProtectionInput = {
  protected: false,
  saveBlocked: false,
  error: null,
  retrySave: vi.fn(),
}

describe('noteProtection', () => {
  it('adds no edit gate while the session is editable', () => {
    expect(noteProtection(clear)).toBeNull()
  })

  it('describes a protected session as Markdown the editor cannot round-trip', () => {
    expect(noteProtection({ ...clear, protected: true })).toEqual({
      kind: 'unsupported-markdown',
    })
  })

  it('keeps unsafe Markdown protected even when an earlier save was blocked', () => {
    expect(noteProtection({ ...clear, protected: true, saveBlocked: true })).toEqual({
      kind: 'unsupported-markdown',
    })
  })

  it('offers the existing retry only for a blocked save', () => {
    const retrySave = vi.fn()
    const result = noteProtection({
      ...clear,
      saveBlocked: true,
      error: 'Folder is unavailable',
      retrySave,
    })
    expect(result).toEqual({
      kind: 'save-blocked',
      message: 'Folder is unavailable',
      retrySave,
    })
    expect(retrySave).not.toHaveBeenCalled()
  })
})
