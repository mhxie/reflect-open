import { useCallback, type MouseEvent } from 'react'
import { NATIVE_MENU_SEPARATOR, type NativeContextMenuItem, routeForPath } from '@reflect/app'
import { errorMessage, type PinnedNote } from '@reflect/core'
import { usePeek, usePeekNavigation } from '@/components/peek/peek-provider.tsx'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { copyNoteDeepLink } from '@/lib/clipboard-actions.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'

/**
 * The pinned shelf's right-click menu, after Arc's tab menu: the ways to open
 * a pinned note (Peek where the window has a panel, a new window), the note's
 * outward handles (deep link, Finder), then Unpin set apart at the bottom.
 * Returns the row's `onContextMenu` handler.
 */
export function usePinnedNoteMenu(note: PinnedNote): (event: MouseEvent<HTMLElement>) => void {
  const { graph } = useGraph()
  const services = useCoreServices()
  const appServices = useAppServices()
  const canPeek = usePeek() !== null
  const peekNoteLink = usePeekNavigation()
  const navigateNoteLink = useNoteLinkNavigation()

  return useCallback(
    (event: MouseEvent<HTMLElement>): void => {
      event.preventDefault()
      event.stopPropagation()
      if (graph === null) {
        return
      }
      const { noteActions } = services
      const { nativeMenu, opener, operations } = appServices
      const target = routeForPath(note.path)
      const revealNote = async (): Promise<void> => {
        try {
          await opener.revealInFileManager(await noteActions.absolutePathFor(note.path))
        } catch (cause) {
          operations.start('Revealing note').fail(errorMessage(cause))
        }
      }
      const items: NativeContextMenuItem[] = [
        ...(canPeek
          ? [
              {
                text: 'Open in Peek',
                action: () => peekNoteLink({ target, openInNewWindow: false }),
              },
            ]
          : []),
        {
          text: 'Open in New Window',
          action: () => navigateNoteLink({ target, openInNewWindow: true }),
        },
        NATIVE_MENU_SEPARATOR,
        {
          text: 'Copy Deep Link',
          action: () => void copyNoteDeepLink(services, appServices, note.path),
        },
        {
          text: 'Reveal in Finder',
          action: () => void revealNote(),
        },
        NATIVE_MENU_SEPARATOR,
        {
          text: 'Unpin Note',
          action: () => void noteActions.unpin(note.path),
        },
      ]
      nativeMenu.openContextMenu({ items }).catch((cause: unknown) => {
        operations.start('Opening note menu').fail(errorMessage(cause))
      })
    },
    [appServices, canPeek, graph, navigateNoteLink, note.path, peekNoteLink, services],
  )
}
