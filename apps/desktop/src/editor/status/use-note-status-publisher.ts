import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { countDisplayChars, parseNote, type NoteState } from '@reflect/core'
import type { NoteProtection } from './note-protection.ts'
import {
  clearNoteStatus,
  publishNoteStatus,
  type NoteStatus,
  type NoteStatusScope,
} from './note-status-store.ts'

/** Typing settles this long before the count re-parses the buffer. */
const RECOUNT_DELAY_MS = 250

interface SelectionSource {
  /** The pane holding the editor; only a selection inside its editor counts. */
  readonly pane: RefObject<HTMLElement | null>
  /** The editor's selection as Markdown (`NoteEditorHandle.getSelectedText`). */
  readonly getSelectedText: () => string
}

/** Optional live selection and recovery details owned by the publishing pane. */
export interface NoteStatusPublisherOptions {
  readonly selection?: SelectionSource
  readonly protection?: NoteProtection | null
}

interface PublishingSession {
  readonly scope: NoteStatusScope
  readonly owner: symbol
  status: NoteStatus
  loaded: boolean
  active: boolean
  timer: ReturnType<typeof setTimeout> | null
}

function countChars(path: string, markdown: string): number {
  return countDisplayChars(parseNote({ path, source: markdown }))
}

/**
 * Publish counts and explicit note state within a graph's file generation.
 * Privacy and edit-gate changes preserve counts and edit times. Deferred counts
 * remain pinned to the pane that scheduled them, even after a graph switch.
 */
export function useNoteStatusPublisher(
  scope: NoteStatusScope | null,
  initialMarkdown: string | null,
  state: NoteState,
  options: NoteStatusPublisherOptions = {},
): (markdown: string) => void {
  const { selection, protection = null } = options
  const generation = scope?.generation ?? null
  const path = scope?.path ?? null
  const current = useRef<PublishingSession | null>(null)
  const stateRef = useRef(state)
  const protectionRef = useRef(protection)
  const selectionRef = useRef(selection)
  useLayoutEffect(() => {
    stateRef.current = state
    protectionRef.current = protection
    selectionRef.current = selection
  })

  const update = useCallback((session: PublishingSession, patch: Partial<NoteStatus>) => {
    if (!session.active || current.current !== session) {
      return
    }
    session.status = { ...session.status, ...patch }
    if (session.loaded) {
      publishNoteStatus(session.scope, session.owner, session.status)
    }
  }, [])

  useLayoutEffect(() => {
    if (generation === null || path === null) {
      return
    }
    const session: PublishingSession = {
      scope: { generation, path },
      owner: Symbol('note-status'),
      status: {
        characters: 0,
        selectedCharacters: 0,
        editedAt: null,
        state: stateRef.current,
        protection: protectionRef.current,
      },
      loaded: false,
      active: true,
      timer: null,
    }
    current.current = session
    return () => {
      session.active = false
      if (session.timer !== null) {
        clearTimeout(session.timer)
      }
      if (current.current === session) {
        current.current = null
      }
      clearNoteStatus(session.scope, session.owner)
    }
  }, [generation, path])

  useLayoutEffect(() => {
    const session = current.current
    if (session !== null) {
      update(session, { state: stateRef.current, protection: protectionRef.current })
    }
  }, [
    generation,
    path,
    state.kind,
    state.isPrivate,
    state.isLocalOnly,
    state.isReadOnly,
    state.isProtected,
    protection,
    update,
  ])

  useEffect(() => {
    const session = current.current
    if (session === null || initialMarkdown === null) {
      return
    }
    session.loaded = true
    update(session, { characters: countChars(session.scope.path, initialMarkdown) })
  }, [generation, path, initialMarkdown, update])

  const tracksSelection = selection !== undefined && initialMarkdown !== null
  useEffect(() => {
    if (!tracksSelection) {
      return
    }
    let frame = 0
    const recount = (): void => {
      frame = 0
      const session = current.current
      if (
        session === null ||
        session.scope.generation !== generation ||
        session.scope.path !== path
      ) {
        return
      }
      const source = selectionRef.current
      const domSelection = window.getSelection()
      const editor = source?.pane.current?.querySelector('[contenteditable="true"]')
      const inside =
        source !== undefined &&
        domSelection !== null &&
        !domSelection.isCollapsed &&
        editor != null &&
        editor.contains(domSelection.anchorNode)
      const selected = inside ? countChars(session.scope.path, source.getSelectedText()) : 0
      if (selected !== session.status.selectedCharacters) {
        update(session, { selectedCharacters: selected })
      }
    }
    const schedule = (): void => {
      if (frame === 0) {
        frame = requestAnimationFrame(recount)
      }
    }
    document.addEventListener('selectionchange', schedule)
    return () => {
      document.removeEventListener('selectionchange', schedule)
      cancelAnimationFrame(frame)
    }
  }, [tracksSelection, generation, path, update])

  return useCallback(
    (markdown: string) => {
      const session = current.current
      if (
        session === null ||
        session.scope.generation !== generation ||
        session.scope.path !== path
      ) {
        return
      }
      if (session.timer !== null) {
        clearTimeout(session.timer)
      }
      session.timer = setTimeout(() => {
        session.timer = null
        update(session, {
          characters: countChars(session.scope.path, markdown),
          editedAt: Date.now(),
        })
      }, RECOUNT_DELAY_MS)
    },
    [generation, path, update],
  )
}
