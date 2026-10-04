import {
  createContext,
  use,
  useCallback,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { openSession } from '@/editor/open-documents.ts'
import { useNoteLinkNavigation, type NoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { useToday } from '@/lib/use-today.ts'
import { notePathForRoute, type NoteRoute } from '@/routing/route.ts'

/** A note shown in the peek panel, with the route its "Open" button takes. */
export interface PeekTarget {
  readonly path: string
  readonly route: NoteRoute
}

interface PeekContextValue {
  readonly target: PeekTarget | null
  readonly openPeek: (target: PeekTarget) => void
  readonly closePeek: () => void
}

const PeekContext = createContext<PeekContextValue | null>(null)

/**
 * Arc-style Peek for the workspace: a note opened from the sidebar floats over
 * the editor instead of replacing it, so the user keeps their place.
 */
export function PeekProvider({ children }: { children: ReactNode }): ReactElement {
  const [target, setTarget] = useState<PeekTarget | null>(null)
  const closePeek = useCallback(() => setTarget(null), [])
  const value = useMemo(() => ({ target, openPeek: setTarget, closePeek }), [target, closePeek])
  return <PeekContext value={value}>{children}</PeekContext>
}

/** The peek state, or null outside a {@link PeekProvider} (note windows). */
export function usePeek(): PeekContextValue | null {
  return use(PeekContext)
}

/**
 * {@link useNoteLinkNavigation}, but a plain click peeks the note instead of
 * navigating. Navigates as usual for a ⌘-click (new window), outside a
 * provider, and for a note already open in a pane — two panes would hold two
 * sessions over one file.
 */
export function usePeekNavigation(scopeKey?: string | number | null): NoteLinkNavigation {
  const peek = usePeek()
  const today = useToday()
  const navigateNoteLink = useNoteLinkNavigation(scopeKey)
  const openPeek = peek?.openPeek
  const peekedPath = peek?.target?.path
  return useCallback(
    (options) => {
      const path = notePathForRoute(options.target, today)
      if (!options.openInNewWindow && path !== null && path === peekedPath) {
        return
      }
      if (
        options.openInNewWindow ||
        openPeek === undefined ||
        path === null ||
        openSession(path) !== null
      ) {
        navigateNoteLink(options)
        return
      }
      openPeek({ path, route: options.target })
    },
    [navigateNoteLink, openPeek, peekedPath, today],
  )
}
