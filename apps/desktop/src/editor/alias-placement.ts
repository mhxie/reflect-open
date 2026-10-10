import {
  foldKey,
  nextAliases,
  parseNote,
  patchNote,
  ReflectError,
  upsertFrontmatter,
} from '@reflect/core'
import { frontmatterPatchToYaml, type FrontmatterPatch } from './note-session-frontmatter.ts'
import { openSession } from './open-documents.ts'

/**
 * Frontmatter writes for a settled rename (Plan 07b): the renamed note
 * records the title it renamed *away from* as an alias, so any inbound link
 * the rewrite missed (or couldn't reach) still resolves to this note, and a
 * declared `title:` moves to the new title before the rewrite.
 *
 * Placement routes through the live session whenever the note is open — in
 * the renaming pane or a *reopened* one (the open-documents service is the
 * one liveness signal). A direct disk write under a reopened dirty buffer
 * would park a conflict caused by our own background work, and "keep mine"
 * would silently drop the alias. Only when no session can take the patch
 * does it go straight to disk; a loading/clean session reconciles it
 * like any external change, and a header-only patch is body-safe even for
 * protected notes. That disk write is checked against the bytes the aliases
 * were computed from, and recomputed over a concurrent change (`patchNote`).
 */

/** A settled rename, `from` already known to be a real previous title. */
export interface SettledRename {
  from: string
  to: string
  /** The aliases this session's previous rename added (pruned, never user-authored ones). */
  previousAutoAliases: readonly string[]
}

/**
 * What a settled rename writes to the note's frontmatter: either the old
 * title as an alias, or, in a note that declares `title:`, the new title
 * there, which outranks the H1. The title moves only while it still holds
 * the title renamed from, so a newer retitle made meanwhile stands. Null when
 * nothing changes.
 */
function renamePatch(
  path: string,
  source: string,
  rename: SettledRename,
  part: 'alias' | 'title',
): { patch: FrontmatterPatch; added: string[] } | null {
  const { frontmatter } = parseNote({ path, source })
  if (part === 'alias') {
    const aliases = nextAliases(frontmatter.aliases, rename)
    return aliases === null
      ? null
      : { patch: { aliases }, added: addedAliases(frontmatter.aliases, aliases) }
  }
  const declared: unknown = (frontmatter as Record<string, unknown>)['title']
  return typeof declared === 'string' &&
    foldKey(declared.trim()) === foldKey(rename.from) &&
    declared.trim() !== rename.to
    ? { patch: { title: rename.to }, added: [] }
    : null
}

/** The entries of `next` that `current` did not already carry. */
function addedAliases(current: readonly string[], next: readonly string[]): string[] {
  const kept = new Set(current.map((alias) => foldKey(alias)))
  return next.filter((alias) => !kept.has(foldKey(alias)))
}

/**
 * Record `rename.from` as an alias on the note at `path`, returning the
 * aliases that were added (empty when nothing changed) so the next rename in
 * the chain can prune exactly those. Aliases are computed against the note's
 * **current** frontmatter at placement time — `aliases` replaces the whole
 * key, and any earlier snapshot can be stale (an external edit adopted
 * mid-rewrite, a racing chained rename): replacing from it would drop
 * concurrently-gained entries. Throws on failure; the caller owns reporting.
 */
export function placeOldTitleAlias(
  path: string,
  rename: SettledRename,
  generation: number,
): Promise<string[]> {
  return patchForRename(path, rename, generation, 'alias').then((change) => change.added)
}

/**
 * Move a declared `title:` from `rename.from` to `rename.to`. Runs before any
 * link is rewritten to the new title, which would otherwise resolve nowhere.
 * Resolves whether a title moved (a note without `title:` has none). Throws
 * on failure, like {@link placeOldTitleAlias}.
 */
export function moveDeclaredTitle(
  path: string,
  rename: SettledRename,
  generation: number,
): Promise<boolean> {
  return patchForRename(path, rename, generation, 'title').then((change) => change.changed)
}

async function patchForRename(
  path: string,
  rename: SettledRename,
  generation: number,
  part: 'alias' | 'title',
): Promise<{ changed: boolean; added: string[] }> {
  const owner = openSession(path, generation)
  let placed = false
  let change: ReturnType<typeof renamePatch> = null
  if (owner !== null) {
    // Read and patch in the same tick (no await between): atomic against the
    // session. Through its frontmatter channel — the editor view never
    // churns — and flushed rather than riding the debounce: a settle is
    // exactly the moment to persist, and quit-time teardown awaits this.
    change = renamePatch(path, owner.content(), rename, part)
    placed = change === null || owner.updateFrontmatter(change.patch)
    if (placed && change !== null) {
      await owner.flush()
    }
  }
  if (!placed) {
    await patchNote(
      path,
      (content) => {
        if (content === null) {
          throw new ReflectError('notFound', `${path} does not exist`)
        }
        change = renamePatch(path, content, rename, part)
        return change === null
          ? null
          : upsertFrontmatter(content, frontmatterPatchToYaml(change.patch))
      },
      generation,
    )
  }
  return { changed: change !== null, added: change?.added ?? [] }
}
