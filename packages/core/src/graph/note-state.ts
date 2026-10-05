import { isLocalOnlyPath, isLocalOnlyReadOnlyPath } from './local-only.ts'

/** The primary note state displayed in a compact status indicator. */
export type NoteStateKind = 'editable' | 'private' | 'local-only' | 'read-only' | 'protected'

/** Explicit indexed or live-session flags; note titles and content are not inputs. */
export interface NoteStateInput {
  readonly path: string
  readonly isPrivate: boolean
  readonly hasConflict?: boolean
  readonly readOnly?: boolean
  readonly protected?: boolean
}

/** Independent access dimensions, with one primary state for compact displays. */
export interface NoteState {
  readonly kind: NoteStateKind
  readonly isPrivate: boolean
  readonly isLocalOnly: boolean
  readonly isReadOnly: boolean
  readonly isProtected: boolean
}

/**
 * Resolve explicit note flags against the open graph's Local-only path policy.
 * Protection and read-only take visual priority while all dimensions remain available.
 */
export function deriveNoteState(input: NoteStateInput): NoteState {
  const isLocalOnly = isLocalOnlyPath(input.path)
  const isProtected = input.protected === true || input.hasConflict === true
  const isReadOnly = isProtected || input.readOnly === true || isLocalOnlyReadOnlyPath(input.path)
  const isPrivate = input.isPrivate || isLocalOnly
  const kind: NoteStateKind = isProtected
    ? 'protected'
    : isReadOnly
      ? 'read-only'
      : isLocalOnly
        ? 'local-only'
        : isPrivate
          ? 'private'
          : 'editable'

  return { kind, isPrivate, isLocalOnly, isReadOnly, isProtected }
}
