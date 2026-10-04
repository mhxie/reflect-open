import { errorMessage, isLocalOnlyPath, parseNote, type NoteRow } from '@reflect/core'
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
 * Toggle privacy with shared optimistic feedback and save-error reporting.
 * Markdown owns the final state. A note inside a local-only folder is private
 * by its path and read-only, so there is nothing to toggle; neither is there
 * for a note whose frontmatter can't be read, which stays locked untouched.
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
    if (parsed.frontmatterPrivacy.kind === 'unreadable') {
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
