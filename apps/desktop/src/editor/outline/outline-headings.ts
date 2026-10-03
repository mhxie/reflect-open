import { getTextblockDisplayText, isNodeOfType } from '@meowdown/core'

/** The ProseMirror document node Meowdown's editor holds. */
export type OutlineSourceDoc = Parameters<typeof getTextblockDisplayText>[0]

/** One heading of a note's outline, read from the live editor document. */
export interface OutlineHeading {
  /** Heading level, 1–6. */
  readonly level: number
  /** The heading as the editor displays it: inline markdown syntax omitted. */
  readonly text: string
  /**
   * ProseMirror position of the heading node in the editor that produced it —
   * an editor coordinate, not a markdown offset, so it is only meaningful to
   * that editor and only until its next document change.
   */
  readonly position: number
}

/**
 * The document's top-level section headings in order. A leading H1 is the
 * note's title, so it is not a section; later H1s are. Headings nested in
 * lists or blockquotes, and empty headings, stay out.
 */
export function readOutlineHeadings(doc: OutlineSourceDoc): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  doc.forEach((node, offset, index) => {
    if (!isNodeOfType(node, 'heading')) {
      return
    }
    if (index === 0 && node.attrs['level'] === 1) {
      return
    }
    const text = getTextblockDisplayText(node).replaceAll(/\s+/g, ' ').trim()
    if (text === '') {
      return
    }
    const level: unknown = node.attrs['level']
    headings.push({ level: typeof level === 'number' ? level : 1, text, position: offset })
  })
  return headings
}

/** Whether two outlines list the same headings at the same positions. */
export function outlineHeadingsEqual(
  left: readonly OutlineHeading[],
  right: readonly OutlineHeading[],
): boolean {
  return (
    left.length === right.length &&
    left.every((heading, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        heading.level === other.level &&
        heading.text === other.text &&
        heading.position === other.position
      )
    })
  )
}

/** Deepest indent an outline row gets, so deep nesting cannot squeeze titles out. */
const MAX_OUTLINE_DEPTH = 3

/**
 * Each heading's indent depth for display: its level relative to the
 * shallowest level present (a note sectioned with H2s starts flush), capped
 * at {@link MAX_OUTLINE_DEPTH}.
 */
export function outlineDepths(headings: readonly OutlineHeading[]): number[] {
  const shallowest = Math.min(...headings.map((heading) => heading.level))
  return headings.map((heading) => Math.min(heading.level - shallowest, MAX_OUTLINE_DEPTH))
}
