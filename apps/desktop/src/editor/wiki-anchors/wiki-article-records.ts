import type { Node as ProseMirrorNode } from '@prosekit/pm/model'
import type { Transaction } from '@prosekit/pm/state'

/** One complete owned ledger, including opaque lines and historical records. */
export interface WikiArticleLedgerRecord {
  readonly id: string
  readonly raw: string
}

/** Insert administrative records inside Evidence, before any following section. */
export function appendWikiArticleRecords(
  transaction: Transaction,
  ledgers: readonly WikiArticleLedgerRecord[],
  definitions: readonly ProseMirrorNode[] = [],
): void {
  if (ledgers.length + definitions.length === 0) return
  let evidence: number | null = null
  let at = transaction.doc.content.size
  transaction.doc.forEach((node, position) => {
    if (node.type.name !== 'heading' || Number(node.attrs['level']) > 2) return
    if (evidence !== null) {
      at = Math.min(at, position)
      return
    }
    if (node.attrs['level'] === 2 && /^(?:Evidence|References)$/.test(node.textContent)) {
      evidence = position
      at = transaction.doc.content.size
    } else if (node.attrs['level'] === 2 && node.textContent === 'Revision Log')
      at = Math.min(at, position)
  })
  const { schema } = transaction.doc.type
  const nodes: ProseMirrorNode[] = []
  if (evidence === null && ledgers.length > 0)
    nodes.push(schema.nodes['heading']!.create({ level: 2 }, schema.text('Evidence')))
  for (const ledger of ledgers)
    nodes.push(
      schema.nodes['codeBlock']!.create(
        { language: `anchors ${ledger.id}` },
        ledger.raw === '' ? null : schema.text(ledger.raw),
      ),
    )
  nodes.push(...definitions)
  transaction.insert(at, nodes)
}
