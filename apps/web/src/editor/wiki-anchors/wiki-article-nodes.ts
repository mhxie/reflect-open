import type { Node as ProseMirrorNode } from '@prosekit/pm/model'
import { isWikiBibliographyHeading, isWikiRevisionHeading, wikiLedgerOwner } from '@reflect/core'

/** The claim an `anchors cN` code block holds the evidence ledger for, or null. */
export function ledgerOwnerOf(node: ProseMirrorNode): string | null {
  return node.type.name === 'codeBlock' ? wikiLedgerOwner(String(node.attrs['language'])) : null
}

/** Whether a node is the H2 that opens the article's bibliography. */
export function isBibliographyHeadingNode(node: ProseMirrorNode): boolean {
  return (
    node.type.name === 'heading' &&
    node.attrs['level'] === 2 &&
    isWikiBibliographyHeading(node.textContent)
  )
}

/** Whether a node is the H2 that opens the article's `Revision Log`. */
export function isRevisionHeadingNode(node: ProseMirrorNode): boolean {
  return (
    node.type.name === 'heading' &&
    node.attrs['level'] === 2 &&
    isWikiRevisionHeading(node.textContent)
  )
}
