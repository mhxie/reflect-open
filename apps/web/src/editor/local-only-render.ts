import type { ImageUrlResolver, XPostResolver, YouTubeVideoResolver } from '@meowdown/core'

/**
 * Rendering switches for content from a private note (locked, unreadable, or
 * local-only), which must never trigger a network request: no embed lookups,
 * no remote images. Meowdown's `remoteMedia: false` shows embeds as their
 * source URLs without asking any resolver or rendering a saved snapshot; its
 * embed props still fall back to its own fetching resolvers when omitted, so
 * "off" also passes an explicit resolver that finds nothing.
 */
export const resolveNoXPost: XPostResolver = () => undefined

/** The YouTube counterpart of {@link resolveNoXPost}. */
export const resolveNoYouTubeVideo: YouTubeVideoResolver = () => undefined

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
