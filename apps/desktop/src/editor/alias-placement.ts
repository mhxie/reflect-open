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
 * Old-title alias placement after a settled rename (Plan 07b): the renamed
 * note records the title it renamed *away from* as an alias, so any inbound
 * link the rewrite missed (or couldn't reach) still resolves to this note.
 *
 * Placement routes through the live session whenever the note is open — in
 * the renaming pane or a *reopened* one (the open-documents service is the
 * one liveness signal). A direct disk write under a reopened dirty buffer
 * would park a conflict caused by our own background work, and "keep mine"
 * would silently drop the alias. Only when no session can take the patch
 * does the alias go straight to disk; a loading/clean session reconciles it
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
 * What a settled rename writes to the note's frontmatter: the old title as an
 * alias (unless `alias` is off, as when another note holds that title), and,
 * in a note that declares `title:`, the new title there too: the explicit
 * title outranks the H1, so without it the rewritten links would resolve
 * nowhere. Null when nothing changes.
 */
function renamePatch(
  path: string,
  source: string,
  rename: SettledRename,
  alias: boolean,
): { patch: FrontmatterPatch; added: string[] } | null {
  const { frontmatter } = parseNote({ path, source })
  const aliases = alias ? nextAliases(frontmatter.aliases, rename) : null
  const declared: unknown = (frontmatter as Record<string, unknown>)['title']
  const title = typeof declared === 'string' && declared.trim() !== rename.to ? rename.to : null
  if (aliases === null && title === null) return null
  return {
    patch: {
      ...(aliases === null ? {} : { aliases }),
      ...(title === null ? {} : { title }),
    },
    added: aliases === null ? [] : addedAliases(frontmatter.aliases, aliases),
  }
}

/** The entries of `next` that `current` did not already carry. */
function addedAliases(current: readonly string[], next: readonly string[]): string[] {
  const kept = new Set(current.map((alias) => foldKey(alias)))
  return next.filter((alias) => !kept.has(foldKey(alias)))
}

/**
 * Record `rename.from` as an alias on the note at `path` (skipped with
 * `alias: false`), and move a declared `title:` to `rename.to`, returning the
 * aliases that were added (empty when nothing changed) so the next rename in
 * the chain can prune exactly those. Aliases are computed against the note's
 * **current** frontmatter at placement time — `aliases` replaces the whole
 * key, and any earlier snapshot can be stale (an external edit adopted
 * mid-rewrite, a racing chained rename): replacing from it would drop
 * concurrently-gained entries. Throws on failure; the caller owns reporting.
 */
export async function placeOldTitleAlias(
  path: string,
  rename: SettledRename,
  generation: number,
  options: { alias?: boolean } = {},
): Promise<string[]> {
  const alias = options.alias ?? true
  const owner = openSession(path, generation)
  let placed = false
  let added: string[] = []
  if (owner !== null) {
    // Read and patch in the same tick (no await between): atomic against the
    // session. Through its frontmatter channel — the editor view never
    // churns — and flushed rather than riding the debounce: a settle is
    // exactly the moment to persist, and quit-time teardown awaits this.
    const change = renamePatch(path, owner.content(), rename, alias)
    placed = change === null || owner.updateFrontmatter(change.patch)
    if (placed && change !== null) {
      added = change.added
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
        const change = renamePatch(path, content, rename, alias)
        added = change?.added ?? []
        return change === null
          ? null
          : upsertFrontmatter(content, frontmatterPatchToYaml(change.patch))
      },
      generation,
    )
  }
  return added
}
