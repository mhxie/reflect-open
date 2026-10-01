import { useCallback } from 'react'
import type { WikilinkClickHandler } from '@meowdown/core'
import { isLocalOnlyPath } from '@reflect/core'
import { useWikiLinkNavigation } from '@/editor/use-wiki-link-navigation.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { routeForPath } from '@/routing/route.ts'
import { isModEvent } from '@meowdown/core'

/** A snippet's `[[wiki link]]` click, with the path of the note the snippet is from. */
export type BacklinkWikilinkClick = (
  payload: Parameters<WikilinkClickHandler>[0],
  sourcePath: string,
) => void

/** The click plumbing a backlinks surface wires into its rows and snippets. */
export interface BacklinkNavigation {
  /**
   * Open an already-resolved source-note path: a daily note opens the daily
   * view (on mobile that swipes the carousel to the date — the surface stays
   * mounted), anything else opens the note. The arrival never requests focus
   * — on mobile that would raise the keyboard through the stack animation;
   * desktop autofocuses note arrivals anyway. `event` (desktop) lets ⌘-click
   * open a new window; mobile taps omit it.
   */
  openSource: (path: string, event?: ModClickEvent) => void
  /**
   * Navigate a `[[wiki link]]` clicked *inside* a snippet — resolves its
   * target the same way the editor does, distinct from {@link openSource}.
   * A link in a snippet from a local-only note only opens an existing note,
   * exactly like its read-only note pane: creating one would carry the
   * link's local-only text out as a public note's title. Stable, so it never
   * rebuilds the snippet trees.
   */
  onWikilinkClick: BacklinkWikilinkClick
}

/**
 * Navigation for an incoming-backlinks surface, shared by the desktop panel
 * and the mobile section. Wiki links inside snippets resolve through the same
 * pipeline as the editor.
 */
export function useBacklinkNavigation(): BacklinkNavigation {
  const { graph } = useGraph()
  const navigateNoteLink = useNoteLinkNavigation()

  const openSource = useCallback(
    (target: string, event?: ModClickEvent) => {
      navigateNoteLink({
        target: routeForPath(target),
        openInNewWindow: event !== undefined && isModEvent(event),
      })
    },
    [navigateNoteLink],
  )

  const navigateWikiLink = useWikiLinkNavigation(graph?.generation ?? null)
  const navigateExisting = useWikiLinkNavigation(null)
  const onWikilinkClick = useCallback<BacklinkWikilinkClick>(
    (payload, sourcePath) => {
      const navigate = isLocalOnlyPath(sourcePath) ? navigateExisting : navigateWikiLink
      navigate({ target: payload.target, openInNewWindow: payload.mod })
    },
    [navigateExisting, navigateWikiLink],
  )

  return { openSource, onWikilinkClick }
}
