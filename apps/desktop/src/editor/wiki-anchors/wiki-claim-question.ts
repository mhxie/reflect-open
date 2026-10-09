import type { EditorState, Transaction } from '@prosekit/pm/state'
import type { WikiArticleIndex } from '@reflect/core'
import { ledgerOwnerOf } from './wiki-article-nodes.ts'
import { appendWikiArticleRecords } from './wiki-article-records.ts'

/** The schema's record of a reader's doubt about a claim. */
export function wikiReaderFlag(asOf: string): string {
  return `@pass: reader | status: flagged | at: ${asOf}`
}

/**
 * Record that the reader questions claim `claimId`: the reader flag appended
 * to the end of its valid `anchors cN` ledger, or a new ledger holding it
 * under the article's evidence section when the claim has none. Null when
 * the claim's only ledgers are invalid (misplaced or duplicated), where a
 * record would not count. An ordinary undoable edit; the claim's text is
 * untouched, so no editor pending record follows.
 */
export function wikiQuestionTransaction(
  state: EditorState,
  index: WikiArticleIndex,
  claimId: string,
  asOf: string,
): Transaction | null {
  const record = wikiReaderFlag(asOf)
  const owned = index.ledgers.filter((ledger) => ledger.owner === claimId)
  if (owned.length === 0) {
    const transaction = state.tr
    appendWikiArticleRecords(transaction, [{ id: claimId, raw: record }])
    return transaction
  }
  // A claim's ledger counts only when it is the claim's one ledger.
  if (owned.length !== 1 || owned[0]?.valid !== true) return null
  let target: { end: number; separated: boolean } | null = null
  state.doc.descendants((node, position) => {
    if (target !== null) return false
    if (node.type.name !== 'codeBlock') return true
    if (ledgerOwnerOf(node) === claimId)
      target = {
        end: position + node.nodeSize - 1,
        separated: node.textContent === '' || node.textContent.endsWith('\n'),
      }
    return false
  })
  if (target === null) return null
  const { end, separated } = target
  return state.tr.insertText(`${separated ? '' : '\n'}${record}`, end)
}
