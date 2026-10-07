import type { BacklinkContext, SnippetTask } from '@reflect/core'

/** One rendered reference: the snippet Markdown plus its checkbox anchors. */
export interface BacklinkSnippetData {
  /** Stable render key, `path:posFrom`. */
  key: string
  /** The snippet Markdown. */
  text: string
  /** The snippet's checkbox tasks anchored to the source note, render order. */
  tasks: SnippetTask[]
}

/** One referencing note: its identity plus every linking line found in it. */
export interface BacklinkSource {
  /** Graph-relative path of the source note (the navigation target). */
  path: string
  /** Title of the source note. */
  title: string
  displayTitle?: string | null | undefined
  lang?: string | null | undefined
  /**
   * The source note is private (locked, unreadable, or local-only), so its
   * snippets must not reach the network. Any of its rows saying so, or
   * leaving it unsaid, makes it private.
   */
  isPrivate: boolean
  hasConflict: boolean
  /** The line around each link, keyed `path:posFrom` for stable rendering. */
  snippets: BacklinkSnippetData[]
}

/**
 * Group flat backlink rows by their source note, preserving the query's
 * most-recent-source-first order (V1 parity). Empty snippets (a source that
 * vanished between the index query and the file read) are dropped, but the
 * source group itself still renders so the reference stays discoverable.
 */
export function groupBacklinksBySource(backlinks: readonly BacklinkContext[]): BacklinkSource[] {
  const groups = new Map<string, BacklinkSource>()
  for (const backlink of backlinks) {
    // Fails closed: only an explicit `false` lets a source's media load.
    const sourcePrivate = backlink.sourcePrivate !== false
    let group = groups.get(backlink.sourcePath)
    if (group === undefined) {
      group = {
        path: backlink.sourcePath,
        title: backlink.sourceTitle,
        displayTitle: backlink.sourceDisplayTitle,
        lang: backlink.sourceLang,
        isPrivate: sourcePrivate,
        hasConflict: backlink.sourceHasConflict,
        snippets: [],
      }
      groups.set(backlink.sourcePath, group)
    } else if (sourcePrivate) {
      group.isPrivate = true
    }
    if (backlink.sourceHasConflict) {
      group.hasConflict = true
    }
    if (backlink.snippet !== '') {
      group.snippets.push({
        key: `${backlink.sourcePath}:${backlink.posFrom}`,
        text: backlink.snippet,
        tasks: backlink.tasks,
      })
    }
  }
  return [...groups.values()]
}
