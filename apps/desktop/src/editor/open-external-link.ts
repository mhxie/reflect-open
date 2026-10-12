import { useCallback } from 'react'
import type { LinkClickHandler } from '@meowdown/core'
import { isDeepLinkUrl } from '@/lib/deep-links/parse.ts'
import { useFollowDeepLink } from '@/lib/deep-links/use-follow-deep-link.ts'
import { openUrlSync } from '@/lib/open-url.ts'

/**
 * Schemes that must never reach the OS opener: script and data URIs carry
 * executable content rather than an address, and `file:`/`blob:` open
 * arbitrary local content a synced or captured note could point at.
 */
const BLOCKED_SCHEMES: ReadonlySet<string> = new Set([
  'javascript',
  'vbscript',
  'data',
  'blob',
  'about',
  'file',
])

/**
 * Whether `href` is an absolute URL that may be handed to the OS opener.
 * Any app scheme qualifies (`https:`, `x-devonthink-item:`, `bear:`, …) —
 * the OS resolves the handler — but the blocked schemes and scheme-less
 * relative hrefs never do. The opener capability mirrors this policy
 * (`*://*` allowed, `file://*` denied) as the Rust-side backstop.
 */
export function isOpenableExternalUrl(href: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]
  return scheme !== undefined && !BLOCKED_SCHEMES.has(scheme.toLowerCase())
}

/**
 * Open a link that needs no source note: a `reflect://` link through the
 * deep-link pipeline, any other allowed scheme through the OS opener. A
 * reader that resolves note links itself (an embedded note's) takes this
 * instead of `useMarkdownLinkClick`, which also builds the source's
 * attachment resolver.
 */
export function useOpenExternalLink(): LinkClickHandler {
  const followDeepLink = useFollowDeepLink()
  return useCallback<LinkClickHandler>(
    ({ href, event, mod }) => {
      event.preventDefault()
      if (isDeepLinkUrl(href)) {
        followDeepLink({ href, openInNewWindow: mod })
        return
      }
      if (isOpenableExternalUrl(href)) {
        openUrlSync(href)
      }
    },
    [followDeepLink],
  )
}
