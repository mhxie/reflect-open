import { useCallback, type MouseEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { join } from '@tauri-apps/api/path'
import { revealItemInDir } from '@tauri-apps/plugin-opener'
import { errorMessage, type PinnedNote } from '@reflect/core'
import { usePeek, usePeekNavigation } from '@/components/peek/peek-provider.tsx'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import {
  NATIVE_MENU_SEPARATOR,
  openNativeContextMenu,
  type NativeContextMenuItem,
} from '@/lib/native-menu/context-menu.ts'
import { runCopyDeepLink } from '@/lib/note-deep-link.ts'
import { unpinNote } from '@/lib/note-pin.ts'
import { startOperation } from '@/lib/operations.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { routeForPath } from '@/routing/route.ts'

async function revealNote(root: string, path: string): Promise<void> {
  try {
    await revealItemInDir(await join(root, path))
  } catch (cause) {
    startOperation('Revealing note').fail(errorMessage(cause))
  }
}

/**
 * The pinned shelf's right-click menu, after Arc's tab menu: the ways to open
 * a pinned note (Peek where the window has a panel, a new window), the note's
 * outward handles (deep link, Finder), then Unpin set apart at the bottom.
 * Returns the row's `onContextMenu` handler.
 */
export function usePinnedNoteMenu(note: PinnedNote): (event: MouseEvent<HTMLElement>) => void {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
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
      const target = routeForPath(note.path)
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
          action: () => void runCopyDeepLink(note.path, graph.generation),
        },
        {
          text: 'Reveal in Finder',
          action: () => void revealNote(graph.root, note.path),
        },
        NATIVE_MENU_SEPARATOR,
        {
          text: 'Unpin Note',
          action: () => {
            void unpinNote({
              queryClient,
              root: graph.root,
              generation: graph.generation,
              path: note.path,
            })
          },
        },
      ]
      void openNativeContextMenu({ items }).catch((cause: unknown) => {
        startOperation('Opening note menu').fail(errorMessage(cause))
      })
    },
    [canPeek, graph, navigateNoteLink, note.path, peekNoteLink, queryClient],
  )
}
