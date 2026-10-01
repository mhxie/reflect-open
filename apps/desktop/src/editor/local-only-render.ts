import type { ImageUrlResolver, XPostResolver, YouTubeVideoResolver } from '@meowdown/core'

/**
 * Rendering switches for content read from a local-only note, which must
 * never trigger a network request: no embed lookups, no remote images.
 * Meowdown's embed props fall back to its own fetching resolvers when
 * omitted, so "off" is an explicit resolver that finds nothing (the link then
 * renders as an ordinary link).
 */
export const resolveNoXPost: XPostResolver = () => undefined

/** The YouTube counterpart of {@link resolveNoXPost}. */
export const resolveNoYouTubeVideo: YouTubeVideoResolver = () => undefined

/** A Meowdown magic comment (`<!-- {...} -->`); a `--` inside its JSON is written escaped. */
const MAGIC_COMMENT = /<!--\s*(\{[\s\S]*?\})\s*-->/g

/**
 * `markdown` without saved embed snapshots. An image-syntax embed may carry
 * its card data in a trailing `<!-- {"snapshot": ...} -->` comment, and the
 * card then renders from it without asking any resolver (a YouTube snapshot
 * loads its remote thumbnail). The rest of the comment (a saved size) stays.
 */
export function withoutEmbedSnapshots(markdown: string): string {
  return markdown.replaceAll(MAGIC_COMMENT, (comment: string, json: string) => {
    let data: unknown
    try {
      data = JSON.parse(json)
    } catch {
      return comment // not one Meowdown reads either
    }
    if (typeof data !== 'object' || data === null || !('snapshot' in data)) {
      return comment
    }
    const { snapshot: _snapshot, ...rest } = data as Record<string, unknown>
    if (Object.keys(rest).length === 0) {
      return ''
    }
    return `<!-- ${JSON.stringify(rest).replaceAll('--', String.raw`-\u002d`)} -->`
  })
}

/** A source carrying a URL scheme (or protocol-relative) names a remote resource, not an attachment. */
function isRemoteSource(source: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith('//')
}

/**
 * `resolver` restricted to graph attachments: a remote source resolves to
 * nothing, so the webview never loads it. Without a resolver nothing
 * resolves at all (Meowdown's default would load http(s) sources as is).
 */
export function localImagesOnly(resolver: ImageUrlResolver | undefined): ImageUrlResolver {
  return (source) => (isRemoteSource(source) ? undefined : resolver?.(source))
}
