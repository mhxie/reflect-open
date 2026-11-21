/** The live editor's reason for protecting a note and its available recovery. */
export type NoteProtection =
  | { readonly kind: 'unsupported-markdown' }
  | {
      readonly kind: 'save-blocked'
      readonly message: string
      readonly retrySave: () => void
    }

/** Session flags already enforcing protection; presentation does not add edit gates. */
export interface NoteProtectionInput {
  readonly protected: boolean
  readonly saveBlocked: boolean
  readonly error: string | null
  readonly retrySave: () => void
}

/** Describe the existing protection gate and the recovery this pane offers. */
export function noteProtection(input: NoteProtectionInput): NoteProtection | null {
  if (input.protected) {
    return { kind: 'unsupported-markdown' }
  }
  if (input.saveBlocked) {
    return {
      kind: 'save-blocked',
      message: input.error ?? 'This file cannot currently be written.',
      retrySave: input.retrySave,
    }
  }
  return null
}
