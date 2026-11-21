import { createMarkdownSourceMap, type MarkdownSourceMap } from '@meowdown/core'
import type { Node as ProseMirrorNode } from '@prosekit/pm/model'
import {
  readWikiArticle,
  type WikiArticleIndex,
  type WikiArticleOptions,
  type WikiSourceSpan,
} from '@reflect/core'

/** One source snapshot feeds every editor and preview projection. */
export interface WikiArticleProjection {
  readonly map: MarkdownSourceMap
  readonly index: WikiArticleIndex
}

/** Serialize once; all positions refer to the returned snapshot rather than an older file. */
export function wikiArticleProjection(
  doc: ProseMirrorNode,
  asOf: string,
  options?: WikiArticleOptions,
): WikiArticleProjection {
  const map = createMarkdownSourceMap(doc)
  return { map, index: readWikiArticle(map.markdown, asOf, options) }
}

/** Share one parsed projection among a preview's block render callbacks. */
export function createWikiArticleProjectionReader(
  options?: WikiArticleOptions,
): (doc: ProseMirrorNode, asOf: string) => WikiArticleProjection {
  const projections = new WeakMap<
    ProseMirrorNode,
    { asOf: string; projection: WikiArticleProjection }
  >()
  return (doc, asOf) => {
    const cached = projections.get(doc)
    if (cached?.asOf === asOf) return cached.projection
    const projection = wikiArticleProjection(doc, asOf, options)
    projections.set(doc, { asOf, projection })
    return projection
  }
}

/** Source syntax with no editor counterpart has no approximate target. */
export function wikiEditorRange(
  map: MarkdownSourceMap,
  range: Pick<WikiSourceSpan, 'from' | 'to'>,
): { from: number; to: number } | null {
  const from = map.sourceToEditor(range.from, 1)
  const to = map.sourceToEditor(range.to, -1)
  return from === null || to === null || from > to ? null : { from, to }
}
