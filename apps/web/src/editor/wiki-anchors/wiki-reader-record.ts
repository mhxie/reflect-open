import type { EditorState, Transaction } from '@prosekit/pm/state'
import type { WikiArticleIndex } from '@reflect/core'
import { ledgerOwnerOf } from './wiki-article-nodes.ts'
import { appendWikiArticleRecords } from './wiki-article-records.ts'

/** What the reader may record about a claim: `flagged` doubts it, `verified` dismisses a doubt. */
export type WikiReaderStatus = 'flagged' | 'verified'

/** The schema's record of the reader's word on a claim. */
export function wikiReaderRecord(status: WikiReaderStatus, asOf: string): string {
  return `@pass: reader | status: ${status} | at: ${asOf}`
}

/**
 * Record the reader's `status` on claim `claimId`: the record appended to the
 * end of its valid `anchors cN` ledger, or a new ledger holding it under the
 * article's evidence section when the claim has none. Null when the claim's
 * only ledgers are invalid (misplaced or duplicated), where a record would
 * not count. An ordinary undoable edit; the claim's text is untouched, so no
 * editor pending record follows.
 */
export function wikiReaderTransaction(
  state: EditorState,
  index: WikiArticleIndex,
  claimId: string,
  status: WikiReaderStatus,
  asOf: string,
): Transaction | null {
  const record = wikiReaderRecord(status, asOf)
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
