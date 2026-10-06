import {
  errorMessage,
  isLocalOnlyPath,
  parseNote,
  type NoteRow,
  type ParsedNote,
} from '@reflect/core'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter.ts'
import { toast } from '@/components/ui/toast.tsx'
import { startOperation } from '@/lib/operations.ts'
import { queryKeys } from '@/lib/query-client.ts'
import type { NoteActionInput } from './notes/types.ts'

const pendingPrivacy = new Set<string>()

/**
 * What the Lock control says for a note whose frontmatter can't be read: the
 * shared classifier treats it as locked, and a toggle would rewrite YAML
 * Reflect couldn't parse.
 */
export const UNREADABLE_FRONTMATTER_LABEL = "Frontmatter can't be read — treated as locked"

/** How to get an unreadable note's lock back. */
export const UNREADABLE_FRONTMATTER_HINT = "Fix this note's frontmatter to lock or unlock it."

/**
 * Whether the Lock control must leave a note alone: it is treated as locked,
 * but its frontmatter can't be parsed — unreadable, or locked by a `private:`
 * line in YAML that doesn't load — so a toggle would have to rewrite YAML
 * Reflect couldn't read.
 */
export function hasUnreadableLock(
  note: Pick<ParsedNote, 'frontmatterPrivacy' | 'frontmatterWarning'>,
): boolean {
  const { kind } = note.frontmatterPrivacy
  return kind === 'unreadable' || (kind === 'private' && note.frontmatterWarning !== undefined)
}

/** How a single note's privacy write ended. */
type PrivacyWrite =
  | { readonly kind: 'written'; readonly previous: boolean; readonly next: boolean }
  | { readonly kind: 'skipped' }

/**
 * Set one note's `private` flag to what `decide` picks from its current value,
 * with optimistic row feedback and save-error reporting. Markdown owns the
 * final state. A note inside a local-only folder is private by its path, and a
 * locked note whose frontmatter can't be read ({@link hasUnreadableLock})
 * stays locked untouched; both are skipped, as is a note already being written.
 */
async function writeNotePrivacy(
  input: NoteActionInput,
  decide: (current: boolean) => boolean,
): Promise<PrivacyWrite> {
  const { queryClient, root, generation, path } = input
  if (isLocalOnlyPath(path)) {
    return { kind: 'skipped' }
  }
  const key = JSON.stringify([root, generation, path])
  if (pendingPrivacy.has(key)) {
    return { kind: 'skipped' }
  }
  pendingPrivacy.add(key)
  const queryKey = queryKeys.index.note(root, path)
  const apply = (isPrivate: boolean): void => {
    queryClient.setQueryData<NoteRow | null>(queryKey, (row) => (row ? { ...row, isPrivate } : row))
  }
  try {
    await queryClient.cancelQueries({ queryKey, exact: true })
    // Read before predicting: an unreadable note must not flicker unlocked.
    const parsed = parseNote({ path, source: await readNoteSource(path) })
    if (hasUnreadableLock(parsed)) {
      startOperation('Updating privacy').fail(
        `${UNREADABLE_FRONTMATTER_LABEL}. ${UNREADABLE_FRONTMATTER_HINT}`,
      )
      return { kind: 'skipped' }
    }
    const previous = queryClient.getQueryData<NoteRow | null>(queryKey)
    const predicted = decide(previous?.isPrivate ?? false)
    apply(predicted)

    const current = parsed.frontmatter.private === true
    const next = decide(current)
    // A note already in the asked-for state keeps its file byte for byte.
    if (next !== current) {
      await commitNoteFrontmatter(path, { private: next }, generation)
    }
    if (next !== predicted) {
      apply(next)
    }
    return { kind: 'written', previous: current, next }
  } catch (cause) {
    void queryClient.invalidateQueries({ queryKey, exact: true })
    startOperation('Updating privacy').fail(errorMessage(cause))
    return { kind: 'skipped' }
  } finally {
    pendingPrivacy.delete(key)
  }
}

/** Set each note's privacy back to what it was before a write. */
async function restorePrivacy(
  input: Omit<NoteActionInput, 'path'>,
  previous: ReadonlyMap<string, boolean>,
): Promise<void> {
  for (const [path, isPrivate] of previous) {
    await writeNotePrivacy({ ...input, path }, () => isPrivate)
  }
}

/** Confirm a privacy change with a toast whose Undo puts every note back. */
function announcePrivacy(
  input: Omit<NoteActionInput, 'path'>,
  title: string,
  previous: ReadonlyMap<string, boolean>,
): void {
  toast.add({
    title,
    actionProps: {
      children: 'Undo',
      onClick: () => void restorePrivacy(input, previous),
    },
  })
}

/**
 * Toggle one note's privacy — the command, the context sidebar, the status
 * menu and the mobile actions all land here — and offer Undo.
 */
export async function toggleNotePrivate(input: NoteActionInput): Promise<void> {
  const result = await writeNotePrivacy(input, (current) => !current)
  if (result.kind === 'written') {
    announcePrivacy(
      input,
      result.next ? 'Marked private' : 'No longer private',
      new Map([[input.path, result.previous]]),
    )
  }
}

/** What a bulk privacy change did, for the caller's own feedback. */
export interface BulkPrivacyResult {
  /** Notes whose flag changed. */
  readonly changed: number
  /** Notes left alone: local-only, unreadable, already being written, or failed. */
  readonly skipped: number
}

/**
 * Set every listed note's privacy to `isPrivate`, one note at a time, and
 * offer one Undo for the notes that changed. Notes already in that state are
 * left as they are.
 */
export async function setNotesPrivate(
  input: Omit<NoteActionInput, 'path'>,
  paths: readonly string[],
  isPrivate: boolean,
): Promise<BulkPrivacyResult> {
  const previous = new Map<string, boolean>()
  let skipped = 0
  for (const path of paths) {
    const result = await writeNotePrivacy({ ...input, path }, () => isPrivate)
    if (result.kind === 'skipped') {
      skipped += 1
    } else if (result.previous !== result.next) {
      previous.set(path, result.previous)
    }
  }
  if (previous.size > 0) {
    const notes = previous.size === 1 ? '1 note' : `${previous.size} notes`
    announcePrivacy(
      input,
      isPrivate ? `Marked ${notes} private` : `${notes} no longer private`,
      previous,
    )
  }
  return { changed: previous.size, skipped }
}
