/**
 * The save pipeline + external-change reconciliation for one open note
 * (Plan 05 steps 4-5) lives in `@reflect/core` (`NoteSessionService`).
 */
export { frontmatterPatchToYaml, INITIAL_NOTE_SNAPSHOT } from '@reflect/core'
export type {
  FrontmatterPatch,
  NoteContentOrigin,
  NoteSession,
  NoteSessionOptions,
  NoteSessionSnapshot,
  NoteSessionStatus,
} from '@reflect/core'
