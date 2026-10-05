import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { openSession } from '@/editor/open-documents.ts'
import { useNoteLinkNavigation, type NoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { onNoteMoved } from '@/lib/note-moves.ts'
import type { NoteReveal } from '@/lib/note-reveal.ts'
import { useToday } from '@/lib/use-today.ts'
import { notePathForRoute, routeForPath, type NoteRoute } from '@/routing/route.ts'

/** A note shown in the peek panel, with the route its "Open" button takes. */
export interface NotePeekTarget {
  readonly kind: 'note'
  readonly path: string
  readonly route: NoteRoute
  /** Scroll the note to this heading once it shows (a followed link's fragment). */
  readonly reveal?: NoteReveal
}

let revealKeys = 0

/** A fresh reveal for `fragment`, distinct from every earlier one. */
function peekReveal(fragment: string): NoteReveal {
  revealKeys += 1
  return { fragment, key: revealKeys }
}

/** What the peek panel shows: a note, or a graph-relative PDF read page by page. */
export type PeekTarget = NotePeekTarget | { readonly kind: 'pdf'; readonly path: string }

interface PeekContextValue {
  readonly target: PeekTarget | null
  /**
   * Identifies the peek being shown: it changes when another note or PDF is
   * peeked, and holds while the same peek follows its note through a rename.
   */
  readonly targetKey: number
  readonly openPeek: (target: PeekTarget) => void
  readonly closePeek: () => void
}

const PeekContext = createContext<PeekContextValue | null>(null)

/**
 * Arc-style Peek for the workspace: a note opened from the sidebar, or a PDF
 * opened from a note, floats over the editor instead of replacing it, so the
 * user keeps their place.
 */
export interface PeekProviderProps {
  /** False where no panel renders (note windows), so links navigate instead. */
  enabled?: boolean
  children: ReactNode
}

interface PeekState {
  readonly target: PeekTarget | null
  readonly key: number
}

/** `target` peeked after `current`: the same note or PDF keeps its key. */
function peekState(current: PeekState, target: PeekTarget | null): PeekState {
  const same =
    target !== null &&
    current.target !== null &&
    current.target.kind === target.kind &&
    current.target.path === target.path
  return { target, key: same ? current.key : current.key + 1 }
}

export function PeekProvider({ enabled = true, children }: PeekProviderProps): ReactElement {
  const [state, setState] = useState<PeekState>({ target: null, key: 0 })
  const openPeek = useCallback(
    (target: PeekTarget) => setState((current) => peekState(current, target)),
    [],
  )
  const closePeek = useCallback(() => setState((current) => peekState(current, null)), [])

  // A peeked note renamed while open (its title edited here) follows its file,
  // as the router's routes do — "Open" and note commands must not act on the
  // path it left behind.
  useEffect(
    () =>
      onNoteMoved((from, to) => {
        setState((current) =>
          current.target?.kind === 'note' && current.target.path === from
            ? { ...current, target: { ...current.target, path: to, route: routeForPath(to) } }
            : current,
        )
      }),
    [],
  )

  const value = useMemo(
    () => ({ target: state.target, targetKey: state.key, openPeek, closePeek }),
    [state, openPeek, closePeek],
  )
  return <PeekContext value={enabled ? value : null}>{children}</PeekContext>
}

/** The peek state, or null outside a {@link PeekProvider} (note windows). */
export function usePeek(): PeekContextValue | null {
  return use(PeekContext)
}

/**
 * The note open in Peek, or null. While one is, it is the note being worked
 * on: note-scoped commands, Find, and the status bar follow it.
 */
export function usePeekedNotePath(): string | null {
  const target = usePeek()?.target
  return target?.kind === 'note' ? target.path : null
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
  const peekedPath = peek?.target?.kind === 'note' ? peek.target.path : undefined
  return useCallback(
    (options) => {
      const path = notePathForRoute(options.target, today)
      const reveal = options.revealHeading === undefined ? null : peekReveal(options.revealHeading)
      if (!options.openInNewWindow && path !== null && path === peekedPath) {
        // Already peeked: only a heading link has somewhere new to go.
        if (reveal !== null && openPeek !== undefined) {
          openPeek({ kind: 'note', path, route: options.target, reveal })
        }
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
      openPeek({
        kind: 'note',
        path,
        route: options.target,
        ...(reveal === null ? {} : { reveal }),
      })
    },
    [navigateNoteLink, openPeek, peekedPath, today],
  )
}
