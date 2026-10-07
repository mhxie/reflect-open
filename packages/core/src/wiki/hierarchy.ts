import { wikiLocation, wikiPathIn, type WikiLanguage } from './languages.ts'
import type { WikiEntry } from './list.ts'

/** The file name that makes a note its folder's index (matched exactly, case-sensitive). */
const INDEX_FILE = 'index.md'

/** Whether `path` (graph- or wiki-relative) names a folder's index note. */
export function isWikiIndexPath(path: string): boolean {
  return path === INDEX_FILE || path.endsWith(`/${INDEX_FILE}`)
}

/**
 * Whether a wiki entry is an index. The role comes from the file name alone,
 * so an index stays one whether or not it makes claims or has been read.
 */
export function isWikiIndex(entry: Pick<WikiEntry, 'path'>): boolean {
  return isWikiIndexPath(entry.path)
}

/**
 * The relative paths an index above the note at `relativePath` could have,
 * nearest first: each enclosing folder's `index.md`, up to the language root.
 * An index starts from its parent folder, so it is never its own parent; the
 * root index has none.
 */
function ancestorIndexCandidates(relativePath: string): string[] {
  const folders = relativePath.split('/').slice(0, -1)
  const nearest = isWikiIndexPath(relativePath) ? folders.length - 1 : folders.length
  const candidates: string[] = []
  for (let depth = nearest; depth >= 0; depth -= 1) {
    candidates.push([...folders.slice(0, depth), INDEX_FILE].join('/'))
  }
  return candidates
}

/**
 * The graph paths an index above the wiki note at `path` could have, nearest
 * first, inside its own language folder. Parentage comes from paths alone,
 * never from links in a note's body. Empty outside the wiki and for a root index.
 */
export function wikiAncestorIndexPaths(path: string, languages: readonly WikiLanguage[]): string[] {
  const location = wikiLocation(path, languages)
  if (location === null) {
    return []
  }
  return ancestorIndexCandidates(location.relativePath).map((candidate) =>
    wikiPathIn(location.language, candidate),
  )
}

/** One entry in the index tree, with the entries that belong under it. */
export interface WikiIndexNode {
  readonly entry: WikiEntry
  /**
   * The entry's path inside its language folder: the same for every copy,
   * so state keyed on it (what is collapsed) survives a language switch.
   */
  readonly key: string
  readonly children: readonly WikiIndexNode[]
}

/** One visible row of the index tree, in render order. */
export interface WikiIndexRow {
  readonly entry: WikiEntry
  readonly key: string
  /** How many ancestors the row sits under (0 for a top-level row). */
  readonly depth: number
  readonly hasChildren: boolean
  /** Whether the row's children show; false for a leaf. */
  readonly expanded: boolean
}

interface MutableNode {
  readonly entry: WikiEntry
  readonly key: string
  readonly children: MutableNode[]
}

/**
 * `entries` as a tree: each under the nearest ancestor index among them, else
 * at the top. Siblings keep input order, so a prior sort orders every level.
 * Placement reads the path inside the language folder, which every copy shares.
 */
export function buildWikiIndexTree(
  entries: readonly WikiEntry[],
  languages: readonly WikiLanguage[],
): WikiIndexNode[] {
  const nodes = entries.map((entry): MutableNode => ({
    entry,
    key: wikiLocation(entry.path, languages)?.relativePath ?? entry.path,
    children: [],
  }))
  const indexes = new Map(
    nodes.filter((node) => isWikiIndexPath(node.key)).map((node) => [node.key, node]),
  )
  const roots: MutableNode[] = []
  for (const node of nodes) {
    const parent = ancestorIndexCandidates(node.key)
      .map((candidate) => indexes.get(candidate))
      .find((candidate) => candidate !== undefined)
    if (parent === undefined) {
      roots.push(node)
    } else {
      parent.children.push(node)
    }
  }
  return roots
}

/**
 * The tree's rows in render order — each parent before its children — leaving
 * out everything under a node whose key is in `collapsed`.
 */
export function visibleWikiIndexRows(
  tree: readonly WikiIndexNode[],
  collapsed: ReadonlySet<string>,
): WikiIndexRow[] {
  const rows: WikiIndexRow[] = []
  const visit = (nodes: readonly WikiIndexNode[], depth: number): void => {
    for (const node of nodes) {
      const hasChildren = node.children.length > 0
      const expanded = hasChildren && !collapsed.has(node.key)
      rows.push({ entry: node.entry, key: node.key, depth, hasChildren, expanded })
      if (expanded) {
        visit(node.children, depth + 1)
      }
    }
  }
  visit(tree, 0)
  return rows
}
