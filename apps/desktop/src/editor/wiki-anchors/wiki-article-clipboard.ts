import {
  clipboardMarkdownWithReferences,
  createMarkdownSourceMap,
  prepareReferenceTransport,
} from '@meowdown/core'
import { collectInlineElements, LEZER_NODE_IDS, parseInline } from '@meowdown/markdown'
import { EditorState, TextSelection, type Transaction } from '@prosekit/pm/state'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@prosekit/pm/model'
import { dropPoint } from '@prosekit/pm/transform'
import type { EditorView } from '@prosekit/pm/view'
import { readWikiClaimIndex } from '@reflect/core'
import { toast } from '@/components/ui/toast.tsx'
import { todayIso } from '@/lib/dates.ts'
import { wikiEditorRange, type WikiArticleProjection } from './wiki-article-projection.ts'
import { appendWikiArticleRecords, type WikiArticleLedgerRecord } from './wiki-article-records.ts'

const LEDGER_DATA = 'data-wiki-claim-ledgers'
const OWNER = /^anchors (c[1-9]\d*)$/

type ClaimLedgerTransfer = WikiArticleLedgerRecord

interface ClaimMoveRange {
  readonly from: number
  readonly to: number
  readonly ledgers: readonly (ClaimLedgerTransfer & { from: number; to: number })[]
}

/** Ordinary prose copy drops range identity and its administrative records. */
export function stripWikiClaimOwnership(source: string): string {
  const index = readWikiClaimIndex(source, todayIso())
  const spans = [
    ...index.markers.filter((marker) => marker.id !== null),
    ...index.ledgers.filter((ledger) => ledger.owner !== null),
  ].sort((left, right) => right.from - left.from)
  let result = source
  for (const span of spans) result = result.slice(0, span.from) + result.slice(span.to)
  return result
}

/** Sanitize the actual ProseMirror slice, so same-editor copy-drag cannot bypass HTML cleanup. */
function proseSlice(slice: Slice): Slice {
  function clean(content: Fragment): Fragment {
    const nodes: ProseMirrorNode[] = []
    content.forEach((node) => {
      if (node.type.name === 'codeBlock' && OWNER.test(String(node.attrs['language']))) return
      if (
        node.type.name === 'htmlComment' &&
        stripWikiClaimOwnership(String(node.attrs['content'])) === ''
      )
        return
      if (node.type.spec.code || node.marks.some((mark) => mark.type.spec.code)) {
        nodes.push(node)
        return
      }
      if (node.isTextblock) {
        const spans = collectInlineElements(
          parseInline(node.textContent),
          (element) =>
            element.type === LEZER_NODE_IDS.Comment &&
            /^<!--[ \t]*\/?claim:c[1-9]\d*[ \t]*-->$/.test(
              node.textContent.slice(element.from, element.to),
            ),
        )
        let offset = 0
        const children: ProseMirrorNode[] = []
        node.content.forEach((child) => {
          const end = offset + child.textContent.length
          if (child.isText) {
            let text = child.text ?? ''
            for (const span of [...spans].reverse()) {
              const from = Math.max(0, span.from - offset)
              const to = Math.min(text.length, span.to - offset)
              if (from < to) text = text.slice(0, from) + text.slice(to)
            }
            if (text !== '') children.push(child.type.schema.text(text, child.marks))
          } else children.push(child)
          offset = end
        })
        nodes.push(node.copy(Fragment.from(children)))
        return
      }
      if (node.isText) {
        const text = stripWikiClaimOwnership(node.text ?? '')
        if (text !== '') nodes.push(node.type.schema.text(text, node.marks))
      } else nodes.push(node.childCount ? node.copy(clean(node.content)) : node)
    })
    return Fragment.from(nodes)
  }
  const content = clean(slice.content)
  const open = Slice.maxOpen(content)
  return new Slice(
    content,
    Math.min(slice.openStart, open.openStart),
    Math.min(slice.openEnd, open.openEnd),
  )
}

/** Retain emphasis that begins or ends outside an exact prose selection. */
function formattedSlice(view: EditorView, from: number, to: number): Slice {
  const slice = view.state.doc.slice(from, to, true)
  const formatting = new Set([
    LEZER_NODE_IDS.Emphasis,
    LEZER_NODE_IDS.StrongEmphasis,
    LEZER_NODE_IDS.Strikethrough,
    LEZER_NODE_IDS.Highlight,
  ])
  function delimiters(position: number, opening: boolean): string {
    const resolved = view.state.doc.resolve(position)
    const parent = resolved.parent
    if (!parent.isTextblock || parent.content.size !== parent.textContent.length) return ''
    const containers = collectInlineElements(
      parseInline(parent.textContent),
      (element) =>
        formatting.has(element.type) &&
        element.from < resolved.parentOffset &&
        element.to > resolved.parentOffset,
    )
    if (!opening) containers.reverse()
    return containers
      .map((element) => {
        const marker = opening ? element.children[0] : element.children.at(-1)
        return marker === undefined ? '' : parent.textContent.slice(marker.from, marker.to)
      })
      .join('')
  }
  const prefix = delimiters(from, true)
  const suffix = delimiters(to, false)
  if (prefix === '' && suffix === '') return slice
  const blocks: ProseMirrorNode[] = []
  slice.content.descendants((node) => {
    if (node.isTextblock) {
      blocks.push(node)
      return false
    }
    return true
  })
  function rewrite(content: Fragment): Fragment {
    const nodes: ProseMirrorNode[] = []
    content.forEach((node) => {
      if (node.isTextblock && node.content.size === node.textContent.length) {
        let text = node.textContent
        if (node === blocks.at(-1) && suffix !== '') {
          const closing = /(?:<!--[ \t]*\/claim:c[1-9]\d*[ \t]*-->)+$/.exec(text)
          const at = closing?.index ?? text.length
          text = text.slice(0, at) + suffix + text.slice(at)
        }
        if (node === blocks[0] && prefix !== '') {
          const opening = /^(?:<!--[ \t]*claim:c[1-9]\d*[ \t]*-->)+/.exec(text)
          const at = opening?.[0].length ?? 0
          text = text.slice(0, at) + prefix + text.slice(at)
        }
        nodes.push(
          text === node.textContent ? node : node.copy(Fragment.from(node.type.schema.text(text))),
        )
      } else nodes.push(node.childCount ? node.copy(rewrite(node.content)) : node)
    })
    return Fragment.from(nodes)
  }
  return new Slice(rewrite(slice.content), slice.openStart, slice.openEnd)
}

function withoutTransferredLedgers(slice: Slice, ledgers: readonly ClaimLedgerTransfer[]): Slice {
  const ids = new Set(ledgers.map((ledger) => ledger.id))
  function clean(content: Fragment): Fragment {
    const nodes: ProseMirrorNode[] = []
    content.forEach((node) => {
      if (
        node.type.name === 'codeBlock' &&
        ids.has(OWNER.exec(String(node.attrs['language']))?.[1] ?? '')
      )
        return
      nodes.push(node.childCount ? node.copy(clean(node.content)) : node)
    })
    return Fragment.from(nodes)
  }
  const content = clean(slice.content)
  const open = Slice.maxOpen(content)
  return new Slice(
    content,
    Math.min(slice.openStart, open.openStart),
    Math.min(slice.openEnd, open.openEnd),
  )
}

function transferHtml(dom: HTMLElement, ledgers: readonly ClaimLedgerTransfer[]): string {
  const first = dom.firstElementChild ?? dom.appendChild(document.createElement('span'))
  first.setAttribute(LEDGER_DATA, JSON.stringify(ledgers.map(({ id, raw }) => ({ id, raw }))))
  return dom.innerHTML
}

function transferLedgers(html: string): ClaimLedgerTransfer[] | null {
  if (!html.includes(LEDGER_DATA)) return null
  const raw = new DOMParser()
    .parseFromString(html, 'text/html')
    .querySelector(`[${CSS.escape(LEDGER_DATA)}]`)
    ?.getAttribute(LEDGER_DATA)
  if (!raw || raw.length > 1_000_000) return null
  try {
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values) || values.length > 1000) return null
    return values.filter(
      (value: unknown): value is ClaimLedgerTransfer =>
        value !== null &&
        typeof value === 'object' &&
        'id' in value &&
        typeof value.id === 'string' &&
        /^c[1-9]\d*$/.test(value.id) &&
        'raw' in value &&
        typeof value.raw === 'string',
    )
  } catch {
    return null
  }
}

function removeMovedSource(
  transaction: Transaction,
  range: ClaimMoveRange,
  includeLedgers: boolean,
): Transaction {
  const spans = [
    { from: range.from, to: range.to },
    ...(includeLedgers
      ? range.ledgers.filter((ledger) => ledger.from < range.from || ledger.to > range.to)
      : []),
  ].sort((left, right) => right.from - left.from)
  for (const span of spans) transaction.deleteRange(span.from, span.to)
  return transaction
}

/** Moving an inline range to a paragraph start must retain portable comment-block spacing. */
function makeLeadingMarkersPortable(transaction: Transaction): void {
  const changes: { from: number; to: number; nodes: ProseMirrorNode[] }[] = []
  transaction.doc.descendants((node, position) => {
    if (node.type.name !== 'paragraph') return true
    const markers: ProseMirrorNode[] = []
    let offset = 0
    for (;;) {
      const match = /^(<!--[ \t]*\/?claim:c[1-9]\d*[ \t]*-->)/.exec(node.textContent.slice(offset))
      if (match === null) break
      markers.push(node.type.schema.nodes['htmlComment']!.create({ content: match[1] }))
      offset += match[1]!.length
    }
    if (offset > 0)
      changes.push({
        from: position,
        to: position + node.nodeSize,
        nodes: [...markers, node.copy(node.content.cut(offset))],
      })
    return false
  })
  for (const change of changes.reverse())
    transaction.replaceWith(change.from, change.to, change.nodes)
}

function literalMoveSource(view: EditorView, range: ClaimMoveRange, slice: Slice): string {
  const transaction = EditorState.create({
    doc: view.state.doc.type.create(null, slice.content),
  }).tr
  makeLeadingMarkersPortable(transaction)
  let source = createMarkdownSourceMap(transaction.doc).markdown
  const present = new Set(
    readWikiClaimIndex(source, todayIso()).ledgers.map((ledger) => ledger.owner),
  )
  const missing = range.ledgers.filter((ledger) => !present.has(ledger.id))
  if (missing.length > 0)
    source += `\n\n## Evidence\n\n${missing.map((ledger) => `\`\`\`anchors ${ledger.id}\n${ledger.raw}\n\`\`\``).join('\n\n')}`
  return clipboardMarkdownWithReferences(source, slice, view.state.doc)
}

/** Keep generic Markdown clipboard metadata, including reference definitions. */
export function copyWikiProse(
  view: EditorView,
  event: ClipboardEvent,
  projection: WikiArticleProjection,
): boolean {
  if (event.clipboardData === null || view.state.selection.empty || !projection.index.article)
    return false
  const serialized = view.serializeForClipboard(
    proseSlice(formattedSlice(view, view.state.selection.from, view.state.selection.to)),
  )
  const text = stripWikiClaimOwnership(serialized.text)
  event.preventDefault()
  event.clipboardData.setData('text/plain', text)
  event.clipboardData.setData('text/html', serialized.dom.innerHTML)
  return true
}

/** Complete moves include invisible endpoints; partial moves require a boundary decision. */
function claimMoveRange(
  view: EditorView,
  event: Event,
  projection: WikiArticleProjection,
): ClaimMoveRange | 'blocked' | null {
  const selection = view.state.selection
  if (selection.empty) return null
  let from = selection.from
  let to = selection.to
  let containsClaim = false
  const owners = new Set<string>()
  for (const claim of projection.index.claims) {
    if (claim.kind !== 'range') continue
    const range = wikiEditorRange(projection.map, claim)
    if (range === null) continue
    const start = TextSelection.near(view.state.doc.resolve(range.from), 1).from
    const end = TextSelection.near(view.state.doc.resolve(range.to), -1).to
    if (selection.from >= end || selection.to <= start) continue
    if (selection.from > start || selection.to < end) {
      event.preventDefault()
      toast.add({
        type: 'error',
        title: `This selection cuts through ${claim.id.toUpperCase()}. Adjust its boundaries or copy the text instead.`,
      })
      return 'blocked'
    }
    containsClaim = true
    owners.add(claim.id)
    const open = claim.open === null ? null : wikiEditorRange(projection.map, claim.open)
    const close = claim.close === null ? null : wikiEditorRange(projection.map, claim.close)
    if (open !== null) from = Math.min(from, open.from)
    if (close !== null) to = Math.max(to, close.to)
  }
  if (!containsClaim) return null
  const ledgers: ClaimMoveRange['ledgers'][number][] = []
  view.state.doc.descendants((node, position) => {
    if (node.type.name !== 'codeBlock') return true
    const id = OWNER.exec(String(node.attrs['language']))?.[1]
    if (
      id !== undefined &&
      owners.has(id) &&
      projection.index.ledgers.some((ledger) => ledger.owner === id && ledger.valid)
    )
      ledgers.push({ id, raw: node.textContent, from: position, to: position + node.nodeSize })
    return false
  })
  return { from, to, ledgers }
}

/** Cutting a complete visible range also cuts its hidden endpoints, in one undo step. */
export function cutWikiClaim(
  view: EditorView,
  event: ClipboardEvent,
  projection: WikiArticleProjection,
): boolean {
  const range = claimMoveRange(view, event, projection)
  if (range === 'blocked') return true
  if (range === null || event.clipboardData === null) return false
  const slice = formattedSlice(view, range.from, range.to)
  const serialized = view.serializeForClipboard(slice)
  event.preventDefault()
  event.clipboardData.setData('text/plain', literalMoveSource(view, range, slice))
  event.clipboardData.setData('text/html', transferHtml(serialized.dom, range.ledgers))
  view.dispatch(
    removeMovedSource(view.state.tr, range, true).scrollIntoView().setMeta('uiEvent', 'cut'),
  )
  return true
}

interface ClaimDrag extends ClaimMoveRange {
  readonly view: EditorView
  readonly doc: ProseMirrorNode
  readonly move: boolean
}

let claimDrag: ClaimDrag | null = null

/** Source-backed drag transport carries a complete pair across block handles. */
export function startWikiClaimDrag(
  view: EditorView,
  event: DragEvent,
  projection: WikiArticleProjection,
): boolean {
  const range = claimMoveRange(view, event, projection)
  if (range === 'blocked') return true
  if (range === null || event.dataTransfer === null) return false
  const move = !event.altKey && !event.ctrlKey
  const original = formattedSlice(view, range.from, range.to)
  const slice = move ? original : proseSlice(original)
  const serialized = view.serializeForClipboard(slice)
  event.dataTransfer.clearData()
  event.dataTransfer.setData(
    'text/html',
    move ? transferHtml(serialized.dom, range.ledgers) : serialized.dom.innerHTML,
  )
  event.dataTransfer.setData(
    'text/plain',
    move ? literalMoveSource(view, range, slice) : stripWikiClaimOwnership(serialized.text),
  )
  event.dataTransfer.effectAllowed = 'copyMove'
  view.dragging = { slice, move }
  claimDrag = { view, doc: view.state.doc, ...range, move }
  return true
}

/** Apply a range move and its source-definition transport in the same transaction. */
export function dropWikiClaim(view: EditorView, event: DragEvent, slice: Slice): boolean {
  const drag = claimDrag
  if (drag === null) return false
  claimDrag = null
  if (!view.editable || (drag.move && !drag.view.editable) || !drag.view.state.doc.eq(drag.doc)) {
    event.preventDefault()
    return true
  }
  const coordinates = view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (coordinates === null) return false
  const references = prepareReferenceTransport(
    slice,
    view.state.doc,
    event.dataTransfer?.getData('text/html') ?? '',
  )
  const transported = references?.slice ?? slice
  const incoming =
    drag.move && drag.view !== view
      ? withoutTransferredLedgers(transported, drag.ledgers)
      : transported
  const position = dropPoint(view.state.doc, coordinates.pos, incoming) ?? coordinates.pos
  if (drag.view === view && position >= drag.from && position <= drag.to) {
    event.preventDefault()
    return true
  }
  const transaction = view.state.tr
  if (drag.move && drag.view === view) removeMovedSource(transaction, drag, false)
  const target = transaction.mapping.map(position)
  transaction.replaceRange(target, target, incoming).scrollIntoView().setMeta('uiEvent', 'drop')
  makeLeadingMarkersPortable(transaction)
  appendWikiArticleRecords(
    transaction,
    drag.move && drag.view !== view ? drag.ledgers : [],
    references?.definitions ?? [],
  )
  event.preventDefault()
  view.dispatch(transaction)
  if (drag.move && drag.view !== view && drag.view.editable && drag.view.state.doc.eq(drag.doc))
    drag.view.dispatch(removeMovedSource(drag.view.state.tr, drag, true).setMeta('uiEvent', 'drop'))
  drag.view.dragging = null
  view.focus()
  return true
}

/** A cut carries its detached ledgers; ordinary prose copy never installs this payload. */
export function pasteWikiClaim(view: EditorView, event: ClipboardEvent, slice: Slice): boolean {
  const html = event.clipboardData?.getData('text/html') ?? ''
  const ledgers = transferLedgers(html)
  if (ledgers === null) return false
  if (!view.editable) return true
  const references = prepareReferenceTransport(slice, view.state.doc, html)
  const transaction = view.state.tr.replaceSelection(
    withoutTransferredLedgers(references?.slice ?? slice, ledgers),
  )
  makeLeadingMarkersPortable(transaction)
  appendWikiArticleRecords(transaction, ledgers, references?.definitions ?? [])
  view.dispatch(transaction.setMeta('paste', true).setMeta('uiEvent', 'paste').scrollIntoView())
  return true
}

/** A canceled drag must not affect a later unrelated drop. */
export function endWikiClaimDrag(view: EditorView): void {
  if (claimDrag?.view === view) claimDrag = null
}
