import type { EditorState, Transaction } from '@prosekit/pm/state'
import { ledgerOwnerOf } from './wiki-article-nodes.ts'
import { appendWikiArticleRecords } from './wiki-article-records.ts'

/** The schema's record of a reader's doubt about a claim. */
export function wikiReaderFlag(asOf: string): string {
  return `@pass: reader | status: flagged | at: ${asOf}`
}

/**
 * Record that the reader questions claim `claimId`: the reader flag appended
 * to the end of its `anchors cN` ledger, or a new ledger holding it under the
 * article's evidence section when the claim has none. An ordinary undoable
 * edit; the claim's text is untouched, so no editor pending record follows.
 */
export function wikiQuestionTransaction(
  state: EditorState,
  claimId: string,
  asOf: string,
): Transaction {
  const record = wikiReaderFlag(asOf)
  const ends: number[] = []
  let separated = true
  state.doc.descendants((node, position) => {
    if (ends.length > 0) return false
    if (node.type.name !== 'codeBlock') return true
    if (ledgerOwnerOf(node) === claimId) {
      ends.push(position + node.nodeSize - 1)
      separated = node.textContent === '' || node.textContent.endsWith('\n')
    }
    return false
  })
  const transaction = state.tr
  const end = ends[0]
  if (end === undefined) appendWikiArticleRecords(transaction, [{ id: claimId, raw: record }])
  else transaction.insertText(`${separated ? '' : '\n'}${record}`, end)
  return transaction
}
