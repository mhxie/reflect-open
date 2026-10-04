import { isNodeOfType } from '@meowdown/core'
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
import {
  readWikiAnchorsBlock,
  type WikiAnchorsBlock,
  type WikiReviewPass,
  type WikiSource,
} from '@reflect/core'

/** The fence language the atelier wiki schema records a claim's evidence under. */
const ANCHORS_LANGUAGE = 'anchors'

export interface WikiAnchorChipsOptions {
  /** The day markers are judged on (ISO `YYYY-MM-DD`), read when chips render. */
  readonly asOf: () => string
  /** Open an external link outside the app. */
  readonly openUrl: (url: string) => void
}

const CHIP =
  'inline-flex max-w-72 items-center gap-1 truncate rounded-full border border-border bg-surface px-2 py-0.5 leading-5'

function chipElement(tag: 'a' | 'span' | 'button', className: string, text: string): HTMLElement {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function sourceChips(source: WikiSource): HTMLElement[] {
  const lapsed = source.current ? '' : ' line-through opacity-60'
  const main =
    source.url === null
      ? chipElement('span', `${CHIP} text-text-secondary${lapsed}`, source.label)
      : chipElement(
          'a',
          `${CHIP} text-text-secondary hover:bg-surface-hover hover:text-text${lapsed}`,
          `${source.label} ↗`,
        )
  if (source.url !== null) {
    main.setAttribute('href', source.url)
    main.dataset.wikiOpen = source.url
  }
  main.setAttribute('aria-label', `${source.type}:${source.id}${source.current ? '' : ' (lapsed)'}`)
  if (source.readwiseUrl === null) {
    return [main]
  }
  const saved = chipElement(
    'a',
    `${CHIP} text-text-muted hover:bg-surface-hover hover:text-text`,
    'Readwise',
  )
  saved.setAttribute('href', source.readwiseUrl)
  saved.dataset.wikiOpen = source.readwiseUrl
  saved.setAttribute('aria-label', `Saved copy of ${source.label} in Readwise`)
  return [main, saved]
}

/** How a review verdict reads: a glyph and a color class. */
function passStyle(pass: WikiReviewPass): { glyph: string; color: string } {
  switch (pass.status) {
    case 'verified':
      return { glyph: '✓', color: 'text-accent' }
    case 'flagged':
      return { glyph: '⚑', color: 'text-amber-700 dark:text-amber-300' }
    default:
      return { glyph: '?', color: 'text-text-muted' }
  }
}

function passBadge(pass: WikiReviewPass): HTMLElement {
  const { glyph, color } = passStyle(pass)
  const date = pass.at === null ? '' : ` ${pass.at}`
  const lapsed = pass.current ? '' : ' line-through opacity-60'
  const badge = chipElement('span', `inline-flex items-center gap-1 ${color}${lapsed}`, '')
  badge.append(`${glyph} ${pass.agent}`)
  if (date !== '') {
    const when = document.createElement('span')
    when.className = 'text-text-muted tabular-nums'
    when.textContent = date
    badge.append(when)
  }
  badge.setAttribute('aria-label', `${pass.agent} ${pass.status || 'review'}${date}`)
  return badge
}

/**
 * The chips row standing in for one folded `anchors` block: its sources as
 * links (struck through once invalidated), its reviews as badges, and an
 * Edit control that puts the caret back in the raw block. `getPos` is the
 * row's live position, just after the block, which edits above it move.
 */
function chipsRow(
  view: EditorView,
  getPos: () => number | undefined,
  block: WikiAnchorsBlock,
  options: WikiAnchorChipsOptions,
): HTMLElement {
  const row = document.createElement('div')
  row.contentEditable = 'false'
  row.dataset.wikiAnchors = ''
  row.className =
    'my-1.5 flex flex-wrap items-center gap-1.5 font-sans text-[12px] text-text-secondary select-none'
  for (const source of block.sources) {
    row.append(...sourceChips(source))
  }
  for (const pass of block.passes) {
    row.append(passBadge(pass))
  }
  if (block.sources.length === 0 && block.passes.length === 0) {
    row.append(chipElement('span', 'text-text-muted', 'No sources'))
  }
  const edit = chipElement(
    'button',
    'ml-auto rounded px-1 text-text-muted hover:bg-surface-hover hover:text-text',
    'Edit',
  )
  edit.setAttribute('type', 'button')
  edit.setAttribute('aria-label', 'Edit sources')
  row.append(edit)

  row.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null
    const link = target?.closest<HTMLElement>('[data-wiki-open]')
    event.preventDefault()
    if (link?.dataset.wikiOpen !== undefined) {
      options.openUrl(link.dataset.wikiOpen)
      return
    }
    // Anywhere else in the row (Edit included) opens the raw block: the caret
    // inside it lifts the fold.
    const end = getPos()
    const fence = end === undefined ? null : view.state.doc.resolve(end).nodeBefore
    if (end === undefined || fence === null) {
      return
    }
    const selection = TextSelection.create(view.state.doc, end - fence.nodeSize + 1)
    view.dispatch(view.state.tr.setSelection(selection).scrollIntoView())
    view.focus()
  })
  return row
}

function isAnchorsBlock(node: ProseMirrorNode): boolean {
  return isNodeOfType(node, 'codeBlock') && node.attrs['language'] === ANCHORS_LANGUAGE
}

/** The folds and chip rows for every `anchors` block the selection is outside of. */
function anchorDecorations(state: EditorState, options: WikiAnchorChipsOptions): DecorationSet {
  const { doc, selection } = state
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!isNodeOfType(node, 'codeBlock')) {
      // Code blocks never sit inside another textblock.
      return !node.isTextblock
    }
    const end = pos + node.nodeSize
    const editing = selection.from < end && selection.to > pos
    if (!isAnchorsBlock(node) || editing) {
      return false
    }
    const text = node.textContent
    decorations.push(
      Decoration.node(pos, end, { 'data-wiki-anchors-folded': '' }),
      Decoration.widget(
        end,
        (view, getPos) =>
          chipsRow(view, getPos, readWikiAnchorsBlock(text, options.asOf()), options),
        {
          side: -1,
          key: `wiki-anchors:${options.asOf()}:${text}`,
          stopEvent: () => true,
          ignoreSelection: true,
        },
      ),
    )
    return false
  })
  return DecorationSet.create(doc, decorations)
}

/** What the folds depend on besides the document: the day, and which blocks hold the selection. */
function foldKey(state: EditorState, options: WikiAnchorChipsOptions): string {
  const { from, to } = state.selection
  const editing: number[] = []
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!isNodeOfType(node, 'codeBlock')) {
      return !node.isTextblock
    }
    if (isAnchorsBlock(node) && from < pos + node.nodeSize && to > pos) {
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
 * Delete or Backspace would join them with the text.
 */
function enterFoldedBlock(direction: 'forward' | 'backward'): Command {
  return (state, dispatch) => {
    const { selection } = state
    const $cursor = selection instanceof TextSelection ? selection.$cursor : null
    if ($cursor === null || !$cursor.parent.isTextblock) {
      return false
    }
    const forward = direction === 'forward'
    const atEdge = forward
      ? $cursor.parentOffset === $cursor.parent.content.size
      : $cursor.parentOffset === 0
    const neighbor = !atEdge ? null : forward ? blockAfter($cursor) : blockBefore($cursor)
    if (neighbor === null || !isAnchorsBlock(neighbor.node)) {
      return false
    }
    const target = forward ? neighbor.pos + 1 : neighbor.pos + neighbor.node.nodeSize - 1
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, target)).scrollIntoView())
    return true
  }
}

/** Keys that would skip or join a folded `anchors` block; bind ahead of the base keymap. */
export const WIKI_ANCHORS_KEYMAP: Readonly<Record<string, Command>> = {
  ArrowRight: enterFoldedBlock('forward'),
  Delete: enterFoldedBlock('forward'),
  ArrowLeft: enterFoldedBlock('backward'),
  Backspace: enterFoldedBlock('backward'),
}

interface ChipsState {
  readonly key: string
  readonly decorations: DecorationSet
}

/**
 * Renders the atelier wiki schema's fenced `anchors` blocks as evidence: while
 * the caret is outside a block, its raw `@anchor` / `@pass` lines fold away
 * behind a row of chips — each source a link, each review a badge. The caret
 * entering the block (←/→ or Delete/Backspace at its edge, a click on the
 * row, or Edit) shows the raw text again; the markdown never changes. Any
 * note with an `anchors` fence renders this way, wiki or not.
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
