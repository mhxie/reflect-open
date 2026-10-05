import { detectConflictMarkers } from '@reflect/core'

/** The live editor's reason for protecting a note and its available recovery. */
export type NoteProtection =
  | { readonly kind: 'sync-conflict'; readonly content: string }
  | { readonly kind: 'unsupported-markdown' }
  | {
      readonly kind: 'external-change'
      readonly message: string
      readonly keepMine: () => void
      readonly loadTheirs: () => void
    }
  | {
      readonly kind: 'save-blocked'
      readonly message: string
      readonly retrySave: () => void
    }

/** Session flags already enforcing protection; presentation does not add edit gates. */
export interface NoteProtectionInput {
  readonly protected: boolean
  readonly saveBlocked: boolean
  readonly initialContent: string
  readonly error: string | null
  readonly conflict: string | null
  readonly keepMine: () => void
  readonly loadTheirs: () => void
  readonly retrySave: () => void
}

/** Describe the existing protection gate, retaining the exact shown conflict version. */
export function noteProtection(input: NoteProtectionInput): NoteProtection | null {
  if (input.protected) {
    return detectConflictMarkers(input.initialContent)
      ? { kind: 'sync-conflict', content: input.initialContent }
      : { kind: 'unsupported-markdown' }
  }
  if (input.saveBlocked) {
    if (input.conflict !== null) {
      return {
        kind: 'external-change',
        message: input.error ?? 'This file cannot currently be written.',
        keepMine: input.keepMine,
        loadTheirs: input.loadTheirs,
      }
    }
    return {
      kind: 'save-blocked',
      message: input.error ?? 'This file cannot currently be written.',
      retrySave: input.retrySave,
    }
  }
  return null
}
