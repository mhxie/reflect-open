import { useCallback, useLayoutEffect, useRef } from 'react'
import type { LinkClickHandler } from '@meowdown/core'
import {
  errorMessage,
  markdownNoteReference,
  resolveExistingMarkdownTarget,
  resolveExistingWikiTarget,
  splitWikiLinkTarget,
} from '@reflect/core'
import { reportAmbiguousNoteTitle } from '@/editor/ambiguous-note-feedback.ts'
import { useOpenExternalLink } from '@/editor/open-external-link.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { startOperation } from '@/lib/operations.ts'
import { useLinkIntentGuard } from '@/lib/windows/use-link-intent-guard.ts'
import { routeForPath } from '@/routing/route.ts'

interface NoteEmbedNavigationOptions {
  readonly generation: number | null
  readonly graphKey: string | null
  readonly sourcePath: string
  readonly reveal: (fragment: string) => void
}

/** Source-aware link activation that only resolves existing notes, with no creation fallback. */
export function useNoteEmbedNavigation({
  generation,
  graphKey,
  sourcePath,
  reveal,
}: NoteEmbedNavigationOptions) {
  const scope = JSON.stringify([graphKey, generation, sourcePath])
  const currentScope = useRef(scope)
  useLayoutEffect(() => {
    currentScope.current = scope
  }, [scope])
  const openNote = useNoteLinkNavigation(scope)
  const beginLinkIntent = useLinkIntentGuard()
  const openExternal = useOpenExternalLink()
  const follow = useCallback(
    (kind: 'wiki' | 'markdown', target: string, openInNewWindow: boolean) => {
      if (generation === null || graphKey === null) return
      const isStale = beginLinkIntent()
      void (async () => {
        try {
          const result =
            kind === 'wiki'
              ? await resolveExistingWikiTarget(target, generation, sourcePath)
              : await resolveExistingMarkdownTarget(target, sourcePath, generation)
          if (isStale() || currentScope.current !== scope) return
          if (result.kind === 'resolved') {
            const fragment =
              kind === 'wiki'
                ? splitWikiLinkTarget(target).fragment
                : target.includes('#')
                  ? target.slice(target.indexOf('#') + 1)
                  : null
            openNote({
              target: routeForPath(result.path),
              openInNewWindow,
              revealHeading: fragment ?? undefined,
            })
          } else if (result.kind === 'ambiguous') {
            reportAmbiguousNoteTitle('Opening link', target)
          } else if (result.kind === 'unavailable') {
            startOperation('Opening link').fail('This note is not available on this device.')
          }
        } catch (cause) {
          if (!isStale() && currentScope.current === scope) {
            startOperation('Opening link').fail(errorMessage(cause))
          }
        }
      })()
    },
    [generation, graphKey, sourcePath, scope, beginLinkIntent, openNote],
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
        reveal(href.slice(1))
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
