import { describe, expect, it, vi } from 'vitest'
import { noteProtection, type NoteProtectionInput } from './note-protection.ts'

const clear: NoteProtectionInput = {
  protected: false,
  saveBlocked: false,
  initialContent: '# Note\n',
  error: null,
  conflict: null,
  keepMine: vi.fn(),
  loadTheirs: vi.fn(),
  retrySave: vi.fn(),
}

describe('noteProtection', () => {
  it('does not infer an edit gate from content when the session is editable', () => {
    expect(noteProtection({ ...clear, initialContent: '<<<<<<< device\nprivate\n' })).toBeNull()
  })

  it('retains the full conflict version the user is reviewing', () => {
    const content =
      '---\nprivate: true\n---\n<<<<<<< this device\nmine\n=======\ntheirs\n>>>>>>> other device\n'
    expect(noteProtection({ ...clear, protected: true, initialContent: content })).toEqual({
      kind: 'sync-conflict',
      content,
    })
  })

  it('keeps unsafe Markdown protected even when an earlier save was blocked', () => {
    expect(
      noteProtection({ ...clear, protected: true, saveBlocked: true, conflict: '# External\n' }),
    ).toEqual({ kind: 'unsupported-markdown' })
  })

  it('resolves a parked external change before retrying a blocked save', () => {
    const keepMine = vi.fn()
    const loadTheirs = vi.fn()
    expect(
      noteProtection({
        ...clear,
        saveBlocked: true,
        conflict: '# External\n',
        error: 'Folder is unavailable',
        keepMine,
        loadTheirs,
      }),
    ).toEqual({
      kind: 'external-change',
      message: 'Folder is unavailable',
      keepMine,
      loadTheirs,
    })
    expect(keepMine).not.toHaveBeenCalled()
    expect(loadTheirs).not.toHaveBeenCalled()
    expect(noteProtection({ ...clear, conflict: '# External\n' })).toBeNull()
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
