import { isNodeOfType, markdownToDoc } from '@meowdown/core'
import {
  readOutlineHeadings,
  type OutlineHeading,
  type OutlineSourceDoc,
} from './outline-headings.ts'

export const OUTLINE_EMBED_CHANGE = 'reflect-outline-embed-change'
const ROOT_SELECTOR = '[data-note-embed-outline]'

type SourceBlock =
  | { readonly kind: 'heading'; readonly heading: OutlineHeading; readonly ordinal: number }
  | { readonly kind: 'embed'; readonly target: string }

export interface OutlineEmbed {
  readonly id: string
  readonly target: string
  readonly blocks: readonly SourceBlock[]
  readonly element: (ordinal: number) => HTMLElement | null
  readonly reveal: (ordinal: number) => void
}

// Entries belong to mounted DOM instances, including repeated embeds of the same note.
const readers = new WeakMap<HTMLElement, OutlineEmbed>()

export function notifyOutlineEmbed(root: HTMLElement): void {
  root.dispatchEvent(new Event(OUTLINE_EMBED_CHANGE, { bubbles: true }))
}

export function registerOutlineEmbed(root: HTMLElement, entry: OutlineEmbed): () => void {
  readers.set(root, entry)
  notifyOutlineEmbed(root)
  return () => {
    if (readers.get(root) !== entry) return
    readers.delete(root)
    notifyOutlineEmbed(root)
  }
}

/** Complete source headings, even when their DOM is outside the bounded preview. */
export function readEmbeddedOutlineBlocks(body: string, headingOffset: number): SourceBlock[] {
  const doc = markdownToDoc(body)
  const headings = new Map(
    readOutlineHeadings(doc, true).map((heading) => [heading.position, heading]),
  )
  const ordinals = new Map<number, number>()
  let ordinal = 0
  doc.descendants((node, position) => {
    if (isNodeOfType(node, 'heading')) ordinals.set(position, ordinal++)
  })
  const blocks: SourceBlock[] = []
  doc.descendants((node, position) => {
    const heading = headings.get(position)
    if (heading !== undefined) {
      blocks.push({
        kind: 'heading',
        heading: { ...heading, level: Math.min(6, heading.level + headingOffset) },
        ordinal: ordinals.get(position) ?? 0,
      })
    } else if (isNodeOfType(node, 'paragraph')) {
      const target = /^!\[\[([^\]\n|]+)(?:\|[^\]\n]*)?\]\]$/.exec(node.textContent.trim())?.[1]
      if (target !== undefined) blocks.push({ kind: 'embed', target: target.trim() })
    }
  })
  return blocks
}

export function embeddedHeadingElement(root: HTMLElement, ordinal: number): HTMLElement | null {
  return (
    [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter(
      (heading) => heading.closest(ROOT_SELECTOR) === root,
    )[ordinal] ?? null
  )
}

function embeddedHeadings(root: HTMLElement, position: number): OutlineHeading[] {
  const reader = readers.get(root)
  if (reader === undefined) return []
  const children = [...root.querySelectorAll<HTMLElement>(ROOT_SELECTOR)].filter(
    (child) => child.parentElement?.closest(ROOT_SELECTOR) === root,
  )
  const headings: OutlineHeading[] = []
  for (const block of reader.blocks) {
    if (block.kind === 'heading') {
      headings.push({
        ...block.heading,
        position,
        embedded: {
          key: `${reader.id}:${block.ordinal}`,
          element: () => reader.element(block.ordinal),
          reveal: () => reader.reveal(block.ordinal),
        },
      })
    } else {
      const index = children.findIndex(
        (child) =>
          (readers.get(child)?.target ?? child.dataset['noteEmbedTarget']) === block.target,
      )
      if (index !== -1) {
        const child = children.splice(index, 1)[0]
        if (child !== undefined) headings.push(...embeddedHeadings(child, position))
      }
    }
  }
  return headings
}

/** Merge mounted source readers at their editor blocks, preserving reading order. */
export function readOutlineWithEmbeds(
  doc: OutlineSourceDoc,
  nodeDOM: (position: number) => Node | null,
): OutlineHeading[] {
  const own = new Map(readOutlineHeadings(doc).map((heading) => [heading.position, heading]))
  const headings: OutlineHeading[] = []
  doc.forEach((_node, position) => {
    const heading = own.get(position)
    if (heading !== undefined) headings.push(heading)
    const element = nodeDOM(position)
    if (!(element instanceof HTMLElement)) return
    for (const root of element.querySelectorAll<HTMLElement>(ROOT_SELECTOR)) {
      if (root.parentElement?.closest(ROOT_SELECTOR) === null) {
        headings.push(...embeddedHeadings(root, position))
      }
    }
  })
  return headings
}
