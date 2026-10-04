import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  type Alias,
  type Document,
  type Pair,
  type ParsedNode,
} from 'yaml'

/**
 * Whether one frontmatter block loads — the TS half of the Rust pre-scan
 * (`crates/frontmatter/src/scan.rs`), applying the same rules to yaml's
 * document: one document, no parse errors (duplicate keys included), aliases
 * that name earlier anchors and stay within both budgets, a root that is a
 * plain mapping without merge keys, and at most 256 KiB. A block either side
 * refuses is "not loaded" on both: its fields read as empty, and its privacy
 * comes from the line scan alone.
 */

/** Blocks larger than this many UTF-8 bytes are never parsed (256 KiB). */
export const MAX_FRONTMATTER_BYTES = 256 * 1024

/**
 * The most nodes alias expansion may add. The Rust loader clones an anchored
 * subtree for every alias, so this bounds what loading a block can allocate;
 * TS refuses the same blocks so both sides read them alike.
 */
export const ALIAS_EXPANSION_BUDGET = 10_000

const CORE_MAP_TAG = 'tag:yaml.org,2002:map'
const CORE_MERGE_TAG = 'tag:yaml.org,2002:merge'

/** Why a frontmatter block didn't load. */
export type FrontmatterLoadFailure =
  | 'parseFailed'
  | 'notAMapping'
  | 'multipleDocuments'
  | 'aliasBudget'
  | 'tooLarge'

/** A node with its alias resolved; `null` is an empty value (`key:`). */
export type ResolvedNode = Exclude<ParsedNode, Alias.Parsed> | null

/** One key/value pair of the root mapping, aliases resolved. */
export interface RootPair {
  readonly key: ResolvedNode
  readonly value: ResolvedNode
}

/** The outcome of {@link loadFrontmatterBlock}. */
export type FrontmatterBlockLoad =
  | {
      readonly loaded: true
      /** The block as plain JS, exactly what yaml's `parse` returns. */
      readonly value: unknown
      readonly rootPairs: readonly RootPair[]
    }
  | {
      readonly loaded: false
      readonly reason: FrontmatterLoadFailure
      /** A non-fatal parse warning for the note (`ParsedNote.frontmatterWarning`). */
      readonly warning: string
    }

/**
 * A node of the walk: a sequence item can be a bare `Pair` (an implicit
 * single-pair mapping, one mapping node in the event stream), and `null`
 * stands for an empty value, which the event stream reports as a scalar.
 */
type WalkNode = ParsedNode | Pair<ParsedNode, ParsedNode | null> | null

/** Decide whether `raw` (the text between the fences) loads. */
export function loadFrontmatterBlock(raw: string): FrontmatterBlockLoad {
  if (utf8ByteLength(raw) > MAX_FRONTMATTER_BYTES) {
    return notLoaded('tooLarge', 'frontmatter is larger than 256 KiB; ignored')
  }
  let document: Document.Parsed
  try {
    document = parseDocument(raw)
  } catch (cause) {
    return notLoaded('parseFailed', invalidYaml(cause))
  }
  // A second document is reported after the first document's own errors,
  // as the Rust parser meets them in that order.
  const error = document.errors.find((candidate) => candidate.code !== 'MULTIPLE_DOCS')
  if (error !== undefined) {
    return notLoaded('parseFailed', invalidYaml(error))
  }
  const targets = resolveAliases(document.contents)
  if (targets === null) {
    return notLoaded('parseFailed', 'invalid YAML frontmatter: an alias names no earlier anchor')
  }
  const multipleDocuments = document.errors[0]
  if (multipleDocuments !== undefined) {
    return notLoaded('multipleDocuments', invalidYaml(multipleDocuments))
  }
  if (!withinExpansionBudget(document.contents, targets)) {
    return notLoaded('aliasBudget', 'invalid YAML frontmatter: aliases expand too far')
  }
  let value: unknown
  try {
    value = document.toJS()
  } catch (cause) {
    // yaml's own alias rule (`maxAliasCount`) throws a ReferenceError.
    return notLoaded(
      cause instanceof ReferenceError ? 'aliasBudget' : 'parseFailed',
      invalidYaml(cause),
    )
  }
  const root = document.contents
  if (!isMap(root) || (root.tag !== undefined && root.tag !== CORE_MAP_TAG)) {
    return notLoaded('notAMapping', 'frontmatter is not a mapping; ignored')
  }
  const rootPairs = root.items.map((pair) => ({
    key: resolveAlias(pair.key, targets),
    value: resolveAlias(pair.value, targets),
  }))
  // yaml merges `<<` keys in some modes and not others, so a root that has
  // one can't be read the same way everywhere.
  if (
    rootPairs.some(
      ({ key }) => isScalar(key) && (key.source === '<<' || key.tag === CORE_MERGE_TAG),
    )
  ) {
    return notLoaded('notAMapping', 'frontmatter has a merge key; ignored')
  }
  return { loaded: true, value, rootPairs }
}

function notLoaded(reason: FrontmatterLoadFailure, warning: string): FrontmatterBlockLoad {
  return { loaded: false, reason, warning }
}

function invalidYaml(cause: unknown): string {
  return `invalid YAML frontmatter: ${cause instanceof Error ? cause.message : String(cause)}`
}

function resolveAlias(
  node: ParsedNode | null,
  targets: ReadonlyMap<Alias, ParsedNode>,
): ResolvedNode {
  if (node === null) {
    return null
  }
  if (!isAlias(node)) {
    return node
  }
  const target = targets.get(node)
  return target === undefined || isAlias(target) ? null : target
}

/** A walk node's children, in document order (a mapping's keys and values interleaved). */
function childrenOf(node: WalkNode): WalkNode[] {
  if (isMap(node)) {
    return node.items.flatMap((pair) => [pair.key, pair.value])
  }
  if (isSeq(node)) {
    return node.items
  }
  if (isPair(node)) {
    return [node.key, node.value]
  }
  return []
}

/**
 * Every alias's target: the last node anchored with its name before it in
 * document order (yaml's rule, and the Rust parser's). `null` when an alias
 * names no earlier anchor.
 */
function resolveAliases(root: ParsedNode | null): Map<Alias, ParsedNode> | null {
  const targets = new Map<Alias, ParsedNode>()
  const anchors = new Map<string, ParsedNode>()
  const stack: WalkNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() ?? null
    if (isAlias(node)) {
      const target = anchors.get(node.source)
      if (target === undefined) {
        return null
      }
      targets.set(node, target)
      continue
    }
    if ((isScalar(node) || isMap(node) || isSeq(node)) && node.anchor !== undefined) {
      anchors.set(node.anchor, node)
    }
    const children = childrenOf(node)
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index] ?? null)
    }
  }
  return targets
}

/**
 * Whether alias expansion adds at most {@link ALIAS_EXPANSION_BUDGET} nodes:
 * expanded sizes depth-first with an explicit stack, as in Rust; reaching a
 * node that is still being expanded (an alias inside its own anchor) means
 * the expansion never ends.
 */
function withinExpansionBudget(
  root: ParsedNode | null,
  targets: ReadonlyMap<Alias, ParsedNode>,
): boolean {
  if (root === null) {
    return true
  }
  let sourceNodes = 0
  const count: WalkNode[] = [root]
  while (count.length > 0) {
    const node = count.pop() ?? null
    if (!isAlias(node)) {
      sourceNodes += 1
      for (const child of childrenOf(node)) {
        count.push(child)
      }
    }
  }
  const cap = sourceNodes + ALIAS_EXPANSION_BUDGET
  const sizes = new Map<object, number>()
  const sizeOf = (node: WalkNode): number | undefined => (node === null ? 1 : sizes.get(node))
  const active = new Set<object>([root])
  const stack: { node: Exclude<WalkNode, null>; children: WalkNode[]; next: number }[] = [
    { node: root, children: childrenOf(root), next: 0 },
  ]
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!
    const alias = isAlias(frame.node) ? (targets.get(frame.node) ?? null) : undefined
    let pending: Exclude<WalkNode, null> | null = null
    if (alias !== undefined) {
      pending = alias !== null && !sizes.has(alias) ? alias : null
    } else {
      while (
        frame.next < frame.children.length &&
        sizeOf(frame.children[frame.next] ?? null) !== undefined
      ) {
        frame.next += 1
      }
      pending = frame.children[frame.next] ?? null
    }
    if (pending !== null) {
      if (active.has(pending)) {
        return false
      }
      active.add(pending)
      stack.push({ node: pending, children: childrenOf(pending), next: 0 })
      continue
    }
    const total =
      alias !== undefined
        ? (sizeOf(alias) ?? Infinity)
        : frame.children.reduce<number>((sum, child) => sum + (sizeOf(child) ?? Infinity), 1)
    // Every node is part of the root's expansion, so one over the cap is
    // enough to know the whole document is.
    if (total > cap) {
      return false
    }
    sizes.set(frame.node, total)
    active.delete(frame.node)
    stack.pop()
  }
  return true
}

/** UTF-8 length of `text` without encoding it (a lone surrogate counts as U+FFFD). */
function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4
      index += 1
    } else {
      bytes += 3
    }
  }
  return bytes
}
