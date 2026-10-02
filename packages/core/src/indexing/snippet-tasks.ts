import { LEZER_NODE_IDS, parseMarkdownAst, type SyntaxNode, type Tree } from '@meowdown/markdown'
import { parseBody } from '../markdown/grammar.ts'
import { getRoundTasks, type TaskLocator } from '../markdown/task-ast.ts'
import type { BlockContextSource } from './block-context.ts'

/**
 * Task checkboxes inside a backlink snippet, anchored back to the source note.
 *
 * A snippet from `blockContextLinesAt` is a dedented reassembly of source
 * lines, rendered read-only through meowdown's `MarkdownView`. When the view
 * reports a checkbox click it identifies the task only by its document-order
 * index among the rendered checkboxes; this module enumerates the *same*
 * checkboxes from the snippet Markdown and pairs each with the source task's
 * AST locator, which the task write path guards against staleness.
 *
 * The enumeration must mirror meowdown's rendering rule exactly — a drifted
 * index would toggle a *different* task, silently. Both sides parse with
 * Lezer's GFM grammar, and meowdown renders a checkbox for precisely the
 * `Task` nodes sitting in a **bullet** list item (`-`/`*`/`+`); a task marker
 * in an ordered list stays literal paragraph text. The click payload's
 * `checked`/`text` are cross-checked by the caller as a second line of
 * defense.
 */

/** One rendered checkbox in a snippet, with its source-note write-back anchor. */
export interface SnippetTask {
  /** The source task this checkbox writes to, or null when it is read-only. */
  locator: TaskLocator | null
  /** `[x]`/`[X]` → true, `[ ]` → false. */
  checked: boolean
  /** The line's content after the marker and one space — the view's click payload `text`. */
  text: string
}

/** The source task whose marker `[` sits at a whole-file offset, if it is a round task. */
export type SourceTaskLocate = (markerOffset: number) => TaskLocator | undefined

/**
 * Map the whole-file marker offsets of a source note's round tasks to their
 * AST locators. The Lezer tree and the AST share one block grammar, so their
 * round tasks line up in document order; the pairing is still verified item by
 * item, and any disagreement leaves every checkbox of the note read-only.
 */
export function createSourceTaskLocator(source: BlockContextSource): SourceTaskLocate {
  const none: SourceTaskLocate = () => undefined
  const markerOffsets = collectRoundTaskMarkerOffsets(source.tree, source.body)
  const entries = getRoundTasks(parseMarkdownAst(source.body))
  if (entries.length !== markerOffsets.length) {
    return none
  }
  const locators = new Map<number, TaskLocator>()
  for (const [i, offset] of markerOffsets.entries()) {
    const entry = entries[i]
    if (entry === undefined) {
      return none
    }
    const locator: TaskLocator = {
      astPath: entry.astPath,
      markdown: entry.markdown,
      checked: entry.checked,
    }
    if (!matchesFirstLine(source.body, offset, locator)) {
      return none
    }
    locators.set(source.bodyOffset + offset, locator)
  }
  return (markerOffset) => locators.get(markerOffset)
}

/** Offsets of the `[` of every `Task` under a `+` bullet, in document order. */
function collectRoundTaskMarkerOffsets(tree: Tree, body: string): number[] {
  const offsets: number[] = []
  tree.iterate({
    enter: (node) => {
      if (node.type.id !== LEZER_NODE_IDS.Task) {
        return
      }
      const item = node.node.parent
      const mark = item?.firstChild
      if (
        item?.type.id === LEZER_NODE_IDS.ListItem &&
        mark?.type.id === LEZER_NODE_IDS.ListMark &&
        body.slice(mark.from, mark.to) === '+'
      ) {
        offsets.push(node.from)
      }
    },
  })
  return offsets
}

/** Both sides drop surrounding whitespace, as the projected Markdown does. */
function matchesFirstLine(body: string, markerOffset: number, locator: TaskLocator): boolean {
  const checked = body[markerOffset + 1] !== ' '
  const contentStart = markerOffset + 3
  const newline = body.indexOf('\n', contentStart)
  const lineEnd = newline === -1 ? body.length : newline
  const firstLine = body.slice(contentStart, lineEnd).trim()
  const [expected = ''] = locator.markdown.split('\n')
  return checked === locator.checked && firstLine === expected.trim()
}

/** Start offset of every line of `text`. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1)
  }
  return starts
}

/** Index of the line containing `pos` (starts are sorted; linear scan, snippets are small). */
function lineIndexAt(starts: number[], pos: number): number {
  let line = 0
  while (line + 1 < starts.length && starts[line + 1]! <= pos) {
    line += 1
  }
  return line
}

/** Is this `Task` node one meowdown renders as a checkbox — a bullet list item's task? */
function isCheckboxTask(task: SyntaxNode): boolean {
  const item = task.parent
  if (item?.name !== 'ListItem' || item.parent?.name !== 'BulletList') {
    return false
  }
  return true
}

/**
 * Enumerate the checkboxes of one snippet in document order — the same order
 * (and count) meowdown's `MarkdownView` renders and reports click indexes in —
 * each anchored to its source task through `lineOrigins`, the per-line origins
 * from `blockContextLinesAt`, and `locate`, the source note's task locator.
 */
export function extractSnippetTasks(
  snippet: string,
  lineOrigins: readonly number[],
  locate: SourceTaskLocate,
): SnippetTask[] {
  if (snippet === '') {
    return []
  }
  const starts = lineStarts(snippet)
  const tasks: SnippetTask[] = []
  parseBody(snippet).iterate({
    enter: (node) => {
      if (node.name !== 'Task' || !isCheckboxTask(node.node)) {
        return
      }
      const markerFrom = node.from
      const line = lineIndexAt(starts, markerFrom)
      const column = markerFrom - starts[line]!
      const origin = lineOrigins[line]
      const lineEndRaw = snippet.indexOf('\n', markerFrom)
      const lineEnd = lineEndRaw === -1 ? snippet.length : lineEndRaw
      let textStart = markerFrom + 3
      if (snippet[textStart] === ' ') {
        textStart += 1
      }
      tasks.push({
        locator: origin === undefined ? null : (locate(origin + column) ?? null),
        checked: snippet[markerFrom + 1] !== ' ',
        text: snippet.slice(textStart, lineEnd),
      })
    },
  })
  return tasks
}
