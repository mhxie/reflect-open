import { createMarkdownSourceMap } from '@meowdown/core'
import type { Node as ProseMirrorNode } from '@prosekit/pm/model'
import { isRevisionHeadingNode } from './wiki-article-nodes.ts'

/** A top-level administrative section ends only at the next H1/H2. */
export function wikiRevisionSection(
  doc: ProseMirrorNode,
): { from: number; to: number; markdown: string } | null {
  let from: number | null = null
  let contentFrom = 0
  let to = doc.content.size
  doc.forEach((node, position) => {
    if (node.type.name !== 'heading' || Number(node.attrs['level']) > 2) return
    if (from !== null) {
      to = Math.min(to, position)
      return
    }
    if (isRevisionHeadingNode(node)) {
      from = position
      contentFrom = position + node.nodeSize
    }
  })
  return from === null
    ? null
    : { from, to, markdown: createMarkdownSourceMap(doc.cut(contentFrom, to)).markdown }
}
