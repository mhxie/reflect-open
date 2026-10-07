import { splitFrontmatter } from '../markdown/frontmatter.ts'
import { parseBody } from '../markdown/grammar.ts'

/** Markdown structure with comment tokens omitted, projected into one source coordinate space. */
export function wikiMarkdownStructure(
  source: string,
  project: (position: number) => number = (position) => position,
): string {
  const { body, bodyOffset } = splitFrontmatter(source)
  const nodes: [string, number, number][] = []
  parseBody(body).iterate({
    enter: (node) => {
      if (node.name === 'Comment' || node.name === 'CommentBlock') return false
      if (node.name !== 'Document')
        nodes.push([node.name, project(node.from + bodyOffset), project(node.to + bodyOffset)])
    },
  })
  return JSON.stringify(nodes)
}

/** Removing ownership must leave the prose's formatting and block structure intact. */
export function wikiClaimFormattingPreserved(
  source: string,
  markers: readonly { from: number; to: number }[],
): boolean {
  const ordered = [...markers].sort((left, right) => left.from - right.from)
  let unmarked = source
  for (const marker of [...ordered].reverse())
    unmarked = unmarked.slice(0, marker.from) + unmarked.slice(marker.to)
  const project = (position: number): number =>
    position -
    ordered.reduce(
      (removed, marker) => removed + Math.max(0, Math.min(position, marker.to) - marker.from),
      0,
    )
  return wikiMarkdownStructure(source, project) === wikiMarkdownStructure(unmarked)
}
