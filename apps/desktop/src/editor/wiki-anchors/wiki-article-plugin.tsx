import { definePlugin, Priority, withPriority, type PlainExtension } from '@prosekit/core'
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@prosekit/pm/state'
import { isHistoryTransaction } from '@prosekit/pm/history'
import { Decoration, DecorationSet, type EditorView } from '@prosekit/pm/view'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import { wikiPendingPass, type WikiArticleIndex } from '@reflect/core'
import { WikiArticleEvidence } from './wiki-article-evidence.tsx'
import { WikiArticleBibliography } from './wiki-article-bibliography.tsx'
import { wikiClaimPending } from './wiki-article-pending.ts'
import { wikiRevisionSection } from './wiki-revision-section.ts'
import { WikiArticleRevision } from './wiki-article-revision.tsx'
import { WikiArticleDefinitions } from './wiki-article-definitions.tsx'
import { isBibliographyHeadingNode, ledgerOwnerOf } from './wiki-article-nodes.ts'
import { appendWikiArticleRecords } from './wiki-article-records.ts'
import { WikiReferenceGroupView } from './wiki-reference-group.tsx'
import {
  wikiArticleProjection,
  wikiEditorRange,
  type WikiArticleProjection,
} from './wiki-article-projection.ts'
import type { WikiEvidenceOptions } from './wiki-evidence.ts'
import type { WikiClaimTrust } from './wiki-claim-trust-card.tsx'
import { wikiStandingLabel, wikiStandingStyle } from './wiki-trust-labels.ts'
import { spaceWikiTrustMarginMarks } from './wiki-trust-margin.ts'
import type { WikiTrustView } from './wiki-trust-view.ts'
import {
  copyWikiProse,
  cutWikiClaim,
  startWikiClaimDrag,
  dropWikiClaim,
  endWikiClaimDrag,
  pasteWikiClaim,
} from './wiki-article-clipboard.ts'

export interface WikiArticlePluginState extends WikiArticleProjection {
  readonly showRanges: boolean
  readonly revision: number
  readonly decorations: DecorationSet
  readonly asOf: string
}

interface WikiArticlePluginOptions {
  readonly asOf: () => string
  readonly evidence: WikiEvidenceOptions
  readonly onUpdate: () => void
  readonly noteIdentity?: (title: string) => string | null
  /** The harness's verdicts, matched to the current text; null shows no trust. */
  readonly trust?: () => WikiTrustView | null
}

/** View-only transactions use this key; they never enter undo history. */
export const wikiArticleKey = new PluginKey<WikiArticlePluginState>('wiki-article')

const roots = new WeakMap<Node, Root>()

function widget(position: number, key: string, children: ReactNode, block = false): Decoration {
  return Decoration.widget(
    position,
    () => {
      const node = document.createElement(block ? 'div' : 'span')
      node.contentEditable = 'false'
      const root = createRoot(node)
      roots.set(node, root)
      root.render(children)
      return node
    },
    {
      key,
      side: 1,
      ignoreSelection: true,
      stopEvent: () => true,
      destroy: (node) => {
        const root = roots.get(node)
        if (root !== undefined) queueMicrotask(() => root.unmount())
        roots.delete(node)
      },
    },
  )
}

function pendingEdits(
  oldIndex: WikiArticleIndex,
  next: WikiArticlePluginState,
  state: EditorState,
): Transaction | null {
  if (oldIndex.source === next.index.source) return null
  const changed = new Set(
    next.index.claims
      .filter((claim) => {
        if (claim.kind !== 'range') return false
        const old = oldIndex.claims.find((previous) => previous.id === claim.id)
        return (
          old !== undefined &&
          oldIndex.source.slice(old.from, old.to) !== next.index.source.slice(claim.from, claim.to)
        )
      })
      .map((claim) => claim.id),
  )
  const targets: { position: number; text: string }[] = []
  state.doc.descendants((node, position) => {
    if (node.type.name !== 'codeBlock') return true
    const id = ledgerOwnerOf(node)
    if (id === null || !changed.has(id)) return false
    const ledger = next.index.ledgers.find((item) => item.valid && item.owner === id)
    if (ledger !== undefined && !wikiClaimPending(ledger))
      targets.push({
        position: position + node.nodeSize - 1,
        text: `${node.textContent.endsWith('\n') || node.textContent === '' ? '' : '\n'}${wikiPendingPass(next.asOf)}`,
      })
    return false
  })
  const missing = [...changed].filter(
    (id) => !next.index.ledgers.some((ledger) => ledger.owner === id),
  )
  if (targets.length + missing.length === 0) return null
  const transaction = state.tr
  for (const target of targets.sort((left, right) => right.position - left.position))
    transaction.insertText(target.text, target.position)
  appendWikiArticleRecords(
    transaction,
    missing.map((id) => ({ id, raw: wikiPendingPass(next.asOf) })),
  )
  return transaction.setMeta('wiki-review-pending', true)
}

function decorations(
  state: EditorState,
  projection: WikiArticleProjection,
  showRanges: boolean,
  revision: number,
  options: WikiArticlePluginOptions,
): DecorationSet {
  const { index, map } = projection
  if (!index.article) return DecorationSet.empty
  const result: Decoration[] = []
  const trustView = options.trust?.() ?? null
  const claimTrust = (id: string | null | undefined): WikiClaimTrust | null =>
    trustView === null || id === null || id === undefined ? null : trustView.claim(id)
  /** Textblocks holding a margin mark, which position it. */
  const marginHosts = new Set<number>()
  for (const marker of index.markers) {
    if (!marker.valid) continue
    const range = wikiEditorRange(map, marker)
    if (range !== null && range.from < range.to && state.doc.resolve(range.from).parent.isTextblock)
      result.push(Decoration.inline(range.from, range.to, { 'data-wiki-claim-marker': '' }))
  }
  for (const claim of index.claims) {
    if (claim.kind !== 'range') continue
    const range = wikiEditorRange(map, claim)
    if (range === null) continue
    const trust = claimTrust(claim.id)
    // Where the claim's prose ends, which a closing marker on its own line follows.
    let last = null as { to: number; block: number } | null
    state.doc.nodesBetween(range.from, range.to, (node, position) => {
      if (!node.isTextblock || node.type.spec.code) return true
      const from = Math.max(position + 1, range.from)
      const to = Math.min(position + node.nodeSize - 1, range.to)
      if (from < to) {
        last = { to, block: position }
        result.push(
          Decoration.inline(from, to, {
            'data-wiki-claim': claim.id,
            ...(showRanges ? { 'data-wiki-claim-visible': '' } : {}),
            ...(trust === null ? {} : { 'data-wiki-trust': wikiStandingStyle(trust.standing) }),
            ...(trustView?.open === claim.id ? { 'data-wiki-trust-open': '' } : {}),
          }),
        )
      }
      return false
    })
    // Sound claims stay silent: a Solid mark, like every mark on demand, waits
    // for the reveal (Option or the claim lens) after its claim.
    const quiet = trust !== null && wikiStandingStyle(trust.standing) === 'solid'
    const waits = !showRanges && (trustView?.display === 'on-demand' || quiet)
    if (trust !== null && trustView !== null) {
      const to = last?.to ?? range.to
      if (waits) result.push(trustWidget(to, [trust], 'on-demand'))
      else if (trustView.display === 'margin' && !quiet) {
        // Beside the line the claim ends on, positioned by that textblock.
        if (last !== null) marginHosts.add(last.block)
        result.push(trustWidget(to, [trust], 'margin'))
      } else result.push(trustWidget(to, [trust], 'inline'))
    }
    if (showRanges) {
      const position = TextSelection.near(state.doc.resolve(range.from), 1).from
      result.push(
        Decoration.widget(
          position,
          (view) => {
            const button = document.createElement('button')
            button.type = 'button'
            button.className = 'wiki-claim-label'
            button.textContent = claim.id.toUpperCase()
            button.setAttribute('aria-label', `Select claim ${claim.id.toUpperCase()}`)
            button.addEventListener('click', () => {
              view.dispatch(
                view.state.tr
                  .setSelection(TextSelection.create(view.state.doc, position, range.to))
                  .scrollIntoView(),
              )
              view.focus()
            })
            return button
          },
          { key: `claim-label:${revision}:${claim.id}`, side: -1, stopEvent: () => true },
        ),
      )
    }
  }
  for (const group of index.groups) {
    const range = wikiEditorRange(map, group)
    if (range === null || range.from >= range.to) continue
    if (
      state.selection.from >= range.from &&
      state.selection.to <= range.to &&
      state.selection.from < range.to
    ) {
      result.push(
        Decoration.inline(range.from, range.to, {
          class: 'show md-wikilink-source-editing wiki-article-source-editing',
        }),
      )
      continue
    }
    result.push(
      Decoration.inline(range.from, range.to, { 'data-wiki-article-reference-source': '' }),
    )
    result.push(
      widget(
        range.to,
        `article-reference:${revision}:${group.from}`,
        <WikiReferenceGroupView
          group={group}
          index={index}
          options={{
            ...options.evidence,
            edit: () => {
              const view = articleViews.get(state.doc)
              if (view === undefined) return
              view.dispatch(
                view.state.tr
                  .setSelection(TextSelection.create(view.state.doc, range.from, range.to))
                  .scrollIntoView(),
              )
              view.focus()
              if (group.occurrences.length === 1 && group.occurrences[0]?.kind === 'note')
                view.dom.dispatchEvent(
                  new KeyboardEvent('keydown', {
                    key: 'Enter',
                    altKey: true,
                    bubbles: true,
                    cancelable: true,
                  }),
                )
            },
          }}
        />,
      ),
    )
  }
  for (const position of marginHosts) {
    const node = state.doc.nodeAt(position)
    if (node !== null)
      result.push(
        Decoration.node(position, position + node.nodeSize, { class: 'wiki-trust-margin-host' }),
      )
  }
  let bibliographyAt: number | null = null
  state.doc.descendants((node, position) => {
    if (bibliographyAt === null && isBibliographyHeadingNode(node))
      bibliographyAt = position + node.nodeSize
    if (node.type.name !== 'codeBlock') return true
    const owner = ledgerOwnerOf(node)
    if (owner === null) return false
    const ledger = index.ledgers.find((item) => item.valid && item.owner === owner)
    if (ledger === undefined) return false
    const end = position + node.nodeSize
    if (bibliographyAt === null) bibliographyAt = position
    const editing = state.selection.from < end && state.selection.to > position
    if (!editing) {
      result.push(Decoration.node(position, end, { 'data-wiki-anchors-folded': '' }))
      result.push(
        widget(
          end,
          `article-ledger:${revision}:${position}`,
          <WikiArticleEvidence
            ledger={ledger}
            options={{
              ...options.evidence,
              edit: () => {
                const view = articleViews.get(state.doc)
                if (view === undefined) return
                view.dispatch(
                  view.state.tr
                    .setSelection(TextSelection.create(view.state.doc, position + 1))
                    .scrollIntoView(),
                )
                view.focus()
              },
            }}
          />,
          true,
        ),
      )
    }
    return false
  })
  if (index.article && index.bibliography.length > 0)
    result.push(
      widget(
        bibliographyAt ?? state.doc.content.size,
        `article-bibliography:${revision}`,
        <WikiArticleBibliography index={index} options={options.evidence} />,
        true,
      ),
    )
  let definitionsAt: number | null = null
  for (const definition of index.definitions) {
    const range = wikiEditorRange(map, definition)
    if (range === null) continue
    const parent = state.doc.resolve(range.from)
    if (!parent.parent.isTextblock || parent.depth === 0) continue
    definitionsAt ??= parent.before()
    if (state.selection.from >= range.from && state.selection.to <= range.to) continue
    result.push(
      Decoration.node(parent.before(), parent.after(), { 'data-wiki-definition-folded': '' }),
    )
  }
  if (definitionsAt !== null) {
    const position = definitionsAt
    result.push(
      widget(
        position,
        `article-definitions:${revision}`,
        <WikiArticleDefinitions
          source={index.definitions
            .map((span) => index.source.slice(span.from, span.to))
            .join('\n')}
          options={{
            ...options.evidence,
            edit: () => {
              const view = articleViews.get(state.doc)
              if (view === undefined) return
              view.dispatch(
                view.state.tr
                  .setSelection(TextSelection.create(view.state.doc, position + 1))
                  .scrollIntoView(),
              )
              view.focus()
            },
          }}
        />,
        true,
      ),
    )
  }
  const revisionSection = wikiRevisionSection(state.doc)
  if (
    revisionSection !== null &&
    !(state.selection.from < revisionSection.to && state.selection.to > revisionSection.from)
  ) {
    state.doc.forEach((node, position) => {
      if (position >= revisionSection.from && position < revisionSection.to)
        result.push(
          Decoration.node(position, position + node.nodeSize, { 'data-wiki-revision-folded': '' }),
        )
    })
    result.push(
      widget(
        revisionSection.from,
        `article-revision:${revision}`,
        <WikiArticleRevision
          markdown={revisionSection.markdown}
          options={{
            ...options.evidence,
            edit: () => {
              const view = articleViews.get(state.doc)
              if (view === undefined) return
              const position = TextSelection.near(
                view.state.doc.resolve(revisionSection.from + 1),
                1,
              ).from
              view.dispatch(
                view.state.tr
                  .setSelection(TextSelection.create(view.state.doc, position))
                  .scrollIntoView(),
              )
              view.focus()
            },
          }}
        />,
        true,
      ),
    )
  }
  if (index.diagnostics.length > 0) {
    result.push(
      widget(
        0,
        `article-diagnostics:${revision}`,
        <details className="wiki-article-diagnostics" open>
          <summary>Claim ownership needs attention</summary>
          <ul>
            {index.diagnostics.map((diagnostic, ordinal) => (
              <li key={ordinal}>{diagnostic.message}</li>
            ))}
          </ul>
        </details>,
        true,
      ),
    )
  }
  return DecorationSet.create(state.doc, result)
}

const articleViews = new WeakMap<object, EditorView>()

/**
 * A claim's trust mark: a plain button, so a redraw never tears down a live
 * popover. The bridge opens the claim's card from a click on it; CSS draws
 * the tier's shape from `data-wiki-trust`.
 */
function trustMark(trust: WikiClaimTrust): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'wiki-trust-mark'
  button.dataset['wikiTrustClaim'] = trust.claimId
  button.dataset['wikiTrust'] = wikiStandingStyle(trust.standing)
  button.setAttribute('aria-haspopup', 'dialog')
  button.setAttribute(
    'aria-label',
    `Claim ${trust.claimId.toUpperCase()}: ${wikiStandingLabel(trust.standing)}`,
  )
  // The shape's name on hover teaches the marks in place.
  button.title = wikiStandingLabel(trust.standing)
  return button
}

const TRUST_LAYOUT_CLASS = {
  inline: 'wiki-trust-inline',
  'on-demand': 'wiki-trust-inline wiki-trust-on-demand',
  margin: 'wiki-trust-margin',
} as const

/**
 * One claim's mark after its text, inline or in the margin beside that line.
 * The key names everything the DOM shows, so typing elsewhere keeps the node.
 */
function trustWidget(
  position: number,
  marks: readonly WikiClaimTrust[],
  layout: keyof typeof TRUST_LAYOUT_CLASS,
): Decoration {
  const key = `trust:${layout}:${marks
    .map((trust) => `${trust.claimId}=${wikiStandingLabel(trust.standing)}`)
    .join(',')}`
  return Decoration.widget(
    position,
    () => {
      const node = document.createElement('span')
      node.className = TRUST_LAYOUT_CLASS[layout]
      node.contentEditable = 'false'
      node.append(...marks.map(trustMark))
      return node
    },
    // After the claim's citations (drawn at side 1), so the mark closes the claim.
    { key, side: 2, ignoreSelection: true, stopEvent: () => true },
  )
}

/** Render the source projection without replacing prose or storing citation numbers. */
export function defineWikiArticle(options: WikiArticlePluginOptions): PlainExtension {
  return withPriority(
    definePlugin(
      new Plugin<WikiArticlePluginState>({
        key: wikiArticleKey,
        state: {
          init: (_config, state) => {
            const asOf = options.asOf()
            const projection = wikiArticleProjection(state.doc, asOf, options)
            return {
              ...projection,
              asOf,
              showRanges: false,
              revision: 0,
              decorations: decorations(state, projection, false, 0, options),
            }
          },
          apply: (transaction, previous, _old, state) => {
            const asOf = options.asOf()
            const refresh =
              transaction.docChanged ||
              asOf !== previous.asOf ||
              transaction.getMeta(wikiArticleKey) === 'identities'
            const projection = refresh ? wikiArticleProjection(state.doc, asOf, options) : previous
            // New verdicts redraw only the trust decorations, which are keyed by
            // what they show; the projection, whose identity the trust view
            // depends on, and the revision-keyed reading widgets stay put.
            const revision = previous.revision + (refresh ? 1 : 0)
            const meta: unknown = transaction.getMeta(wikiArticleKey)
            const showRanges = meta === 'toggle' ? !previous.showRanges : previous.showRanges
            return {
              ...projection,
              asOf,
              showRanges,
              revision,
              decorations: decorations(state, projection, showRanges, revision, options),
            }
          },
        },
        appendTransaction: (transactions, oldState, state) => {
          if (
            !transactions.some((transaction) => transaction.docChanged) ||
            transactions.some(
              (transaction) =>
                transaction.getMeta('wiki-review-pending') || isHistoryTransaction(transaction),
            )
          )
            return null
          const old = wikiArticleKey.getState(oldState)
          const next = wikiArticleKey.getState(state)
          return old === undefined || next === undefined
            ? null
            : pendingEdits(old.index, next, state)
        },
        props: {
          handlePaste: pasteWikiClaim,
          decorations: (state) => wikiArticleKey.getState(state)?.decorations,
          handleDOMEvents: {
            copy: (view, event) => {
              const projection = wikiArticleKey.getState(view.state)
              return projection === undefined ? false : copyWikiProse(view, event, projection)
            },
            cut: (view, event) => {
              const projection = wikiArticleKey.getState(view.state)
              return projection === undefined ? false : cutWikiClaim(view, event, projection)
            },
            dragstart: (view, event) => {
              const projection = wikiArticleKey.getState(view.state)
              return projection === undefined ? false : startWikiClaimDrag(view, event, projection)
            },
            dragend: (view) => {
              endWikiClaimDrag(view)
              return false
            },
          },
          handleDrop: (view, event, slice) => dropWikiClaim(view, event, slice),
          handleKeyDown: (view, event) => {
            if (event.key === 'Escape') {
              const value = wikiArticleKey.getState(view.state)
              const group = value?.index.groups
                .map((item) => wikiEditorRange(value.map, item))
                .find(
                  (range) =>
                    range !== null &&
                    view.state.selection.from >= range.from &&
                    view.state.selection.to <= range.to &&
                    view.state.selection.from < range.to,
                )
              if (group != null) {
                view.dispatch(
                  view.state.tr
                    .setSelection(TextSelection.create(view.state.doc, group.to))
                    .setMeta('addToHistory', false),
                )
                return true
              }
            }
            if (
              (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
              event.altKey ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              !view.state.selection.empty
            )
              return false
            const value = wikiArticleKey.getState(view.state)
            if (value === undefined) return false
            const direction = event.key === 'ArrowLeft' ? -1 : 1
            const position = view.state.selection.from
            for (const marker of value.index.markers) {
              if (!marker.valid) continue
              const range = wikiEditorRange(value.map, marker)
              if (range === null) continue
              if (
                direction === -1
                  ? position > range.from && position <= range.to
                  : position >= range.from && position < range.to
              ) {
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.near(
                      view.state.doc.resolve(direction === -1 ? range.from : range.to),
                      direction,
                    ),
                  ),
                )
                return true
              }
            }
            return false
          },
        },
        view: (view) => {
          articleViews.set(view.state.doc, view)
          // Margin marks follow their claims' lines, so respace after layout:
          // next frame, and once more after node views and fonts settle.
          let frame: number | null = null
          let settle: ReturnType<typeof setTimeout> | null = null
          const space = (): void => spaceWikiTrustMarginMarks(view.dom)
          const spaceSoon = (): void => {
            if (frame === null)
              frame = requestAnimationFrame(() => {
                frame = null
                space()
              })
            if (settle !== null) clearTimeout(settle)
            settle = setTimeout(() => {
              settle = null
              space()
            }, 250)
          }
          const resize = new ResizeObserver(spaceSoon)
          resize.observe(view.dom)
          document.fonts.addEventListener('loadingdone', spaceSoon)
          spaceSoon()
          return {
            update: (current) => {
              articleViews.set(current.state.doc, current)
              options.onUpdate()
              spaceSoon()
            },
            destroy: () => {
              resize.disconnect()
              document.fonts.removeEventListener('loadingdone', spaceSoon)
              if (frame !== null) cancelAnimationFrame(frame)
              if (settle !== null) clearTimeout(settle)
              endWikiClaimDrag(view)
            },
          }
        },
      }),
    ),
    Priority.highest,
  )
}
