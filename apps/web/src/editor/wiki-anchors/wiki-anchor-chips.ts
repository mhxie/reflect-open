import { definePlugin, type PlainExtension } from '@prosekit/core'
import type { Node as ProseMirrorNode, ResolvedPos } from '@prosekit/pm/model'
import {
  Plugin,
  PluginKey,
  TextSelection,
  type Command,
  type EditorState,
} from '@prosekit/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@prosekit/pm/view'
import type { WikiAnchorsBlock } from '@reflect/core'
import {
  createWikiEvidence,
  readWikiEvidenceNode,
  readWikiSourceLinkPair,
  type WikiEvidenceOptions,
} from './wiki-evidence.ts'

export interface WikiAnchorChipsOptions {
  /** The day markers are judged on (ISO `YYYY-MM-DD`), read when chips render. */
  readonly asOf: () => string
  /** Open an external link outside the app. */
  readonly openUrl: (url: string) => void
  readonly openWikiLink?: WikiEvidenceOptions['openWikiLink']
}

/** `getPos` follows edits above the hidden source, so Edit enters the right block. */
function chipsRow(
  view: EditorView,
  getPos: () => number | undefined,
  block: WikiAnchorsBlock,
  raw: string,
  options: WikiAnchorChipsOptions,
): HTMLElement {
  return createWikiEvidence(block, raw, {
    interactive: true,
    openUrl: (url) => options.openUrl(url),
    ...(options.openWikiLink === undefined ? {} : { openWikiLink: options.openWikiLink }),
    edit: () => {
      const end = getPos()
      const source = end === undefined ? null : view.state.doc.resolve(end).nodeBefore
      if (end === undefined || source === null) return
      const selection = TextSelection.create(view.state.doc, end - source.nodeSize + 1)
      view.dispatch(view.state.tr.setSelection(selection).scrollIntoView())
      view.focus()
    },
  })
}

function isEvidenceBlock(node: ProseMirrorNode): boolean {
  return readWikiEvidenceNode(node, '9999-12-31') !== null
}

/** Fold evidence only while the caret is outside its canonical source block. */
function anchorDecorations(state: EditorState, options: WikiAnchorChipsOptions): DecorationSet {
  const { doc, selection } = state
  const decorations: Decoration[] = []
  doc.descendants((node, pos, parent, index) => {
    if (!node.isTextblock) {
      return !node.isTextblock
    }
    const end = pos + node.nodeSize
    const editing = selection.from < end && selection.to > pos
    const next = parent?.maybeChild(index + 1)
    const cluster = readWikiSourceLinkPair(node, next, options.asOf())
    const editingEvidence =
      next !== undefined &&
      next !== null &&
      selection.from < end + next.nodeSize &&
      selection.to > end
    if (cluster !== null && !editing && !editingEvidence) {
      decorations.push(
        Decoration.inline(pos + 1 + cluster.from, pos + 1 + cluster.to, {
          'data-wiki-source-links-folded': '',
        }),
      )
    }
    const block = readWikiEvidenceNode(node, options.asOf())
    if (block === null || editing) {
      return false
    }
    const text = node.textContent
    const labeled =
      readWikiSourceLinkPair(index > 0 ? parent?.maybeChild(index - 1) : null, node, options.asOf())
        ?.block ?? block
    decorations.push(
      Decoration.node(pos, end, { 'data-wiki-anchors-folded': '' }),
      Decoration.widget(end, (view, getPos) => chipsRow(view, getPos, labeled, text, options), {
        side: -1,
        key: `wiki-anchors:${options.asOf()}:${text}:${JSON.stringify(labeled.sources)}`,
        stopEvent: () => true,
        ignoreSelection: true,
      }),
    )
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/** What the folds depend on besides the document: the day, and which blocks hold the selection. */
function foldKey(state: EditorState, options: WikiAnchorChipsOptions): string {
  const { from, to } = state.selection
  const editing: number[] = []
  state.doc.nodesBetween(from, to, (node, pos, parent, index) => {
    if (!node.isTextblock) {
      return !node.isTextblock
    }
    if (
      (isEvidenceBlock(node) ||
        readWikiSourceLinkPair(node, parent?.maybeChild(index + 1), options.asOf()) !== null) &&
      from < pos + node.nodeSize &&
      to > pos
    ) {
      editing.push(pos)
    }
    return false
  })
  return `${options.asOf()}|${editing.join(',')}`
}

/** The block a forward join from the end of `$cursor`'s block would pull in, with its start. */
function blockAfter($cursor: ResolvedPos): { node: ProseMirrorNode; pos: number } | null {
  for (let depth = $cursor.depth - 1; depth >= 0; depth--) {
    const index = $cursor.index(depth)
    const parent = $cursor.node(depth)
    if (index + 1 < parent.childCount) {
      return { node: parent.child(index + 1), pos: $cursor.after(depth + 1) }
    }
  }
  return null
}

/** The block a backward join from the start of `$cursor`'s block would join, with its start. */
function blockBefore($cursor: ResolvedPos): { node: ProseMirrorNode; pos: number } | null {
  for (let depth = $cursor.depth - 1; depth >= 0; depth--) {
    const index = $cursor.index(depth)
    if (index > 0) {
      const node = $cursor.node(depth).child(index - 1)
      return { node, pos: $cursor.before(depth + 1) - node.nodeSize }
    }
  }
  return null
}

/**
 * At a block's edge beside a folded `anchors` block, the caret moves into
 * that block, unfolding it: arrows would otherwise skip the hidden lines, and
 * Delete or Backspace (`deleting`) would join them with the text. Deleting
 * from an empty top-level line removes the line and lands in the block
 * (left alone, Delete would pull the evidence up into a plain paragraph), and
 * Backspace from a nested block (a list item, a quote) keeps its usual lift.
 */
function enterFoldedBlock(direction: 'forward' | 'backward', deleting: boolean): Command {
  return (state, dispatch) => {
    const { selection } = state
    const $cursor = selection instanceof TextSelection ? selection.$cursor : null
    if ($cursor === null || !$cursor.parent.isTextblock) {
      return false
    }
    const forward = direction === 'forward'
    const topLevel = $cursor.depth === 1
    if (deleting && !forward && !topLevel) {
      return false
    }
    const atEdge = forward
      ? $cursor.parentOffset === $cursor.parent.content.size
      : $cursor.parentOffset === 0
    const neighbor = !atEdge ? null : forward ? blockAfter($cursor) : blockBefore($cursor)
    if (neighbor === null || !isEvidenceBlock(neighbor.node)) {
      return false
    }
    if (deleting && topLevel && $cursor.parent.content.size === 0) {
      const line = $cursor.parent.nodeSize
      const target = forward ? neighbor.pos - line + 1 : neighbor.pos + neighbor.node.nodeSize - 1
      const tr = state.tr.delete($cursor.before(), $cursor.after())
      dispatch?.(tr.setSelection(TextSelection.create(tr.doc, target)).scrollIntoView())
      return true
    }
    const target = forward ? neighbor.pos + 1 : neighbor.pos + neighbor.node.nodeSize - 1
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, target)).scrollIntoView())
    return true
  }
}

/** Keys that would skip or join a folded `anchors` block; bind ahead of the base keymap. */
export const WIKI_ANCHORS_KEYMAP: Readonly<Record<string, Command>> = {
  ArrowRight: enterFoldedBlock('forward', false),
  Delete: enterFoldedBlock('forward', true),
  ArrowLeft: enterFoldedBlock('backward', false),
  Backspace: enterFoldedBlock('backward', true),
}

interface ChipsState {
  readonly key: string
  readonly decorations: DecorationSet
}

/**
 * Renders anchors fences and legacy cite-only paragraphs as numbered evidence
 * links. Details opens recorded metadata; Edit or caret entry reveals source.
 * Folding never changes the document, its wiki-link nodes, or its Markdown.
 */
export function defineWikiAnchorChips(options: WikiAnchorChipsOptions): PlainExtension {
  const key = new PluginKey<ChipsState>('wiki-anchor-chips')
  return definePlugin(
    new Plugin<ChipsState>({
      key,
      state: {
        init: (_config, state) => ({
          key: foldKey(state, options),
          decorations: anchorDecorations(state, options),
        }),
        apply: (tr, previous, _oldState, state) => {
          const next = foldKey(state, options)
          return !tr.docChanged && next === previous.key
            ? previous
            : { key: next, decorations: anchorDecorations(state, options) }
        },
      },
      props: {
        decorations: (state) => key.getState(state)?.decorations,
      },
    }),
  )
}
