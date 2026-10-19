import { useCallback, useLayoutEffect, useRef } from 'react'
import type { LinkClickHandler } from '@meowdown/core'
import { errorMessage, markdownNoteReference, splitWikiLinkTarget } from '@reflect/core'
import { useMarkdownLinkClick } from '@/editor/use-markdown-link-click.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard.ts'
import { routeForPath } from '@/routing/route.ts'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

interface NoteEmbedNavigationOptions {
  readonly generation: number | null
  readonly graphKey: string | null
  readonly sourcePath: string
  readonly reveal: (fragment: string) => void
}

/**
 * A Markdown href's `#fragment` as heading text (`My%20Heading` → `My Heading`).
 */
function hrefFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment)
  } catch {
    return fragment
  }
}

/**
 * Source-aware link activation that only resolves existing notes, with no creation fallback.
 */
export function useNoteEmbedNavigation({
  generation,
  graphKey,
  sourcePath,
  reveal,
}: NoteEmbedNavigationOptions) {
  const { noteLinkResolver } = useCoreServices()
  const { linkNavigation, operations } = useAppServices()
  const scope = JSON.stringify([graphKey, generation, sourcePath])
  const scopeRef = useRef(scope)
  useLayoutEffect(() => {
    scopeRef.current = scope
  }, [scope])
  const openNote = useNoteLinkNavigation(scope)
  const beginLinkIntent = useLinkIntentGuard()
  // Belongs to no note: a deep link takes the deep-link pipeline, an allowed
  // scheme the OS opener, and anything else does nothing.
  const openExternal = useMarkdownLinkClick(null)
  const follow = useCallback(
    (kind: 'wiki' | 'markdown', target: string, openInNewWindow: boolean) => {
      if (generation === null || graphKey === null) return
      const isStale = beginLinkIntent()
      void (async () => {
        try {
          const result =
            kind === 'wiki'
              ? await noteLinkResolver.resolveWikiTarget(target, generation, sourcePath)
              : await noteLinkResolver.resolveMarkdownHref(sourcePath, target, generation)
          if (isStale() || scopeRef.current !== scope) return
          if (result.kind === 'resolved') {
            const fragment =
              kind === 'wiki'
                ? splitWikiLinkTarget(target).fragment
                : target.includes('#')
                  ? hrefFragment(target.slice(target.indexOf('#') + 1))
                  : null
            openNote({
              target: routeForPath(result.path),
              openInNewWindow,
              revealHeading: fragment ?? undefined,
            })
          } else if (result.kind === 'ambiguous') {
            linkNavigation.reportAmbiguousNoteTitle('Opening link', target)
          } else if (result.kind === 'unavailable') {
            operations.fail('Opening link', 'This note is not available on this device.')
          }
        } catch (cause) {
          if (!isStale() && scopeRef.current === scope) {
            operations.fail('Opening link', errorMessage(cause))
          }
        }
      })()
    },
    [
      generation,
      graphKey,
      sourcePath,
      scope,
      beginLinkIntent,
      openNote,
      noteLinkResolver,
      linkNavigation,
      operations,
    ],
  )
  const onWikiLinkClick = useCallback(
    ({ target, openInNewWindow }: { target: string; openInNewWindow: boolean }) => {
      const { name, fragment } = splitWikiLinkTarget(target)
      if (name.trim() === '' && fragment !== null && !openInNewWindow) {
        beginLinkIntent()
        reveal(fragment)
      } else follow('wiki', target, openInNewWindow)
    },
    [follow, reveal, beginLinkIntent],
  )
  const onLinkClick = useCallback<LinkClickHandler>(
    (payload) => {
      const { href, mod, event } = payload
      event.preventDefault()
      if (href.startsWith('#') && !mod) {
        beginLinkIntent()
        reveal(hrefFragment(href.slice(1)))
      } else if (markdownNoteReference(sourcePath, href) !== null) follow('markdown', href, mod)
      else {
        beginLinkIntent()
        openExternal(payload)
      }
    },
    [sourcePath, follow, reveal, openExternal, beginLinkIntent],
  )
  const open = useCallback(
    (target: string, openInNewWindow: boolean) => follow('wiki', target, openInNewWindow),
    [follow],
  )
  return { open, onWikiLinkClick, onLinkClick }
}
