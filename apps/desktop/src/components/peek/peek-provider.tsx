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
import { useNoteLinkNavigation, type NoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import type { NoteReveal } from '@/lib/note-reveal.ts'
import { useToday } from '@/lib/use-today.ts'
import { notePathForRoute, routeForPath, type NoteRoute } from '@reflect/app'
import { useCoreServices } from '@/services/services-provider.tsx'

/** A note shown in the peek panel, with the route its "Open" button takes. */
export interface NotePeekTarget {
  readonly kind: 'note'
  readonly path: string
  readonly route: NoteRoute
  /** Scroll the note to this heading once it shows (a followed link's fragment). */
  readonly reveal?: NoteReveal
}

/** What the peek panel shows: a note, or a graph-relative PDF read page by page. */
export type PeekTarget = NotePeekTarget | { readonly kind: 'pdf'; readonly path: string }

/**
 * What to peek: a note, scrolled to `revealHeading` once it shows, or a PDF.
 */
type PeekRequest =
  | {
      readonly kind: 'note'
      readonly path: string
      readonly route: NoteRoute
      readonly revealHeading?: string | undefined
    }
  | { readonly kind: 'pdf'; readonly path: string }

interface PeekContextValue {
  readonly target: PeekTarget | null
  /**
   * Identifies the peek being shown: it changes when another note or PDF is
   * peeked, and holds while the same peek follows its note through a rename.
   */
  readonly targetKey: number
  readonly openPeek: (request: PeekRequest) => void
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
  /**
   * Heading reveals asked for so far: each gets the next key, so a repeated
   * link to the same heading scrolls there again.
   */
  readonly reveals: number
}

/** `request` peeked after `current`: the same note or PDF keeps its key. */
function peekState(current: PeekState, request: PeekRequest | null): PeekState {
  const same =
    request !== null &&
    current.target !== null &&
    current.target.kind === request.kind &&
    current.target.path === request.path
  const key = same ? current.key : current.key + 1
  if (request === null || request.kind === 'pdf') {
    return { target: request, key, reveals: current.reveals }
  }
  const { revealHeading, ...note } = request
  if (revealHeading === undefined) {
    return { target: note, key, reveals: current.reveals }
  }
  const reveals = current.reveals + 1
  return { target: { ...note, reveal: { fragment: revealHeading, key: reveals } }, key, reveals }
}

export function PeekProvider({ enabled = true, children }: PeekProviderProps): ReactElement {
  const { noteMove } = useCoreServices()
  const [state, setState] = useState<PeekState>({ target: null, key: 0, reveals: 0 })
  const openPeek = useCallback(
    (request: PeekRequest) => setState((current) => peekState(current, request)),
    [],
  )
  const closePeek = useCallback(() => setState((current) => peekState(current, null)), [])

  // A peeked note renamed while open (its title edited here) follows its file,
  // as the router's routes do — "Open" and note commands must not act on the
  // path it left behind.
  useEffect(() => {
    return noteMove.onMoved((from, to) => {
      setState((current) => {
        return current.target?.kind === 'note' && current.target.path === from
          ? { ...current, target: { ...current.target, path: to, route: routeForPath(to) } }
          : current
      })
    })
  }, [noteMove])

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
  const { openDocuments } = useCoreServices()
  const navigateNoteLink = useNoteLinkNavigation(scopeKey)
  const openPeek = peek?.openPeek
  const peekedPath = peek?.target?.kind === 'note' ? peek.target.path : undefined
  return useCallback(
    (options) => {
      const path = notePathForRoute(options.target, today)
      const { revealHeading } = options
      if (!options.openInNewWindow && path !== null && path === peekedPath) {
        // Already peeked: only a heading link has somewhere new to go.
        if (revealHeading !== undefined && openPeek !== undefined) {
          openPeek({ kind: 'note', path, route: options.target, revealHeading })
        }
        return
      }
      if (
        options.openInNewWindow ||
        openPeek === undefined ||
        path === null ||
        openDocuments.sessionFor(path) !== null
      ) {
        navigateNoteLink(options)
        return
      }
      openPeek({ kind: 'note', path, route: options.target, revealHeading })
    },
    [navigateNoteLink, openDocuments, openPeek, peekedPath, today],
  )
}
