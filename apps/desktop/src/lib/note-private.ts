import {
  errorMessage,
  isLocalOnlyPath,
  parseNote,
  type NoteRow,
  type ParsedNote,
} from '@reflect/core'
import { commitNoteFrontmatter, readNoteSource } from '@/lib/note-frontmatter.ts'
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

/**
 * Toggle privacy with shared optimistic feedback and save-error reporting.
 * Markdown owns the final state. A note inside a local-only folder is private
 * by its path and read-only, so there is nothing to toggle; neither is there
 * for a locked note whose frontmatter can't be read ({@link hasUnreadableLock}),
 * which stays locked untouched.
 */
export async function toggleNotePrivate(input: NoteActionInput): Promise<void> {
  const { queryClient, root, generation, path } = input
  if (isLocalOnlyPath(path)) {
    return
  }
  const key = JSON.stringify([root, generation, path])
  if (pendingPrivacy.has(key)) {
    return
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
      return
    }
    const previous = queryClient.getQueryData<NoteRow | null>(queryKey)
    const predicted = !(previous?.isPrivate ?? false)
    apply(predicted)

    const actual = !parsed.frontmatter.private
    await commitNoteFrontmatter(path, { private: actual }, generation)
    if (actual !== predicted) {
      apply(actual)
    }
  } catch (cause) {
    void queryClient.invalidateQueries({ queryKey, exact: true })
    startOperation('Updating privacy').fail(errorMessage(cause))
  } finally {
    pendingPrivacy.delete(key)
  }
}
