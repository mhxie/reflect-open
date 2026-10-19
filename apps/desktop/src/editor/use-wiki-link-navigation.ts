import { useCallback, useMemo } from 'react'
import type { LinkNavigationHost } from '@reflect/app'
import { usePeekNavigation } from '@/components/peek/peek-provider.tsx'
import { useLinkNavigationHost } from '@/hooks/use-link-navigation-host.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * Navigation for a clicked `[[wiki link]]`. Calendar-valid ISO dates preserve
 * ordinary resolution precedence, then open their lazy daily route on a miss.
 * Every other writable title goes through the ambiguity-preserving index +
 * disk resolver before it opens or creates, so an indexed duplicate cannot
 * bypass the same guard used for an index miss. With `readOnly`, or with no
 * graph open, existing titles still use the read-only index resolver and
 * unresolved titles are a no-op.
 *
 * An `openInNewWindow` request (a ⌘-click or a spare-`mod` keyboard follow,
 * decided at the editor boundary from meowdown's `mod` flag) opens the
 * resolved target in a secondary note window instead, falling back to
 * in-window navigation whenever the surface can't (browser dev, mobile), so
 * the request never makes a link do nothing. A `peek` request (⌥-click) floats
 * the note over the editor where the workspace offers Peek.
 *
 * A `#fragment` (`[[Plan#Next steps]]`, a wiki claim's `[[Entry#^c3]]`)
 * never takes part in resolving or naming the note; the opened note scrolls
 * to that heading on arrival, in place or in Peek.
 *
 * Resolution is async, and the host pane can unmount or the user can act
 * again while it's in flight — a late navigate would yank the user somewhere
 * they've already left, so every navigation is gated on the shared link
 * intent (`useLinkIntentGuard`).
 *
 * @returns a stable click handler for the editor's wiki-link extension.
 */
export function useWikiLinkNavigation(options?: {
  readOnly?: boolean
}): (options: { target: string; openInNewWindow: boolean; peek?: boolean }) => void {
  const { linkNavigation } = useAppServices()
  const host = useLinkNavigationHost()
  const peekNoteLink = usePeekNavigation()
  const readOnly = options?.readOnly ?? false
  // The same activation, but a note arrives in Peek instead of the pane. Peek
  // itself navigates as usual where it can't take the note.
  const peekHost = useMemo<LinkNavigationHost>(
    () => ({
      beginIntent: host.beginIntent,
      navigate: (route, arrival) => {
        if (route.kind === 'note' || route.kind === 'daily') {
          peekNoteLink({
            target: route,
            openInNewWindow: false,
            revealHeading: arrival?.revealHeading,
          })
          return
        }
        host.navigate(route, arrival)
      },
    }),
    [host, peekNoteLink],
  )

  return useCallback(
    ({
      target,
      openInNewWindow,
      peek = false,
    }: {
      target: string
      openInNewWindow: boolean
      peek?: boolean
    }) => {
      linkNavigation.followWikiLink({ target, openInNewWindow, readOnly }, peek ? peekHost : host)
    },
    [host, peekHost, linkNavigation, readOnly],
  )
}
