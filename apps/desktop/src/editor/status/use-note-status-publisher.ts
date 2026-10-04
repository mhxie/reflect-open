import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { countDisplayChars, parseNote } from '@reflect/core'
import { clearNoteStatus, publishNoteStatus, type NoteStatus } from './note-status-store.ts'

/** Typing settles this long before the count re-parses the buffer. */
const RECOUNT_DELAY_MS = 250

const EMPTY_STATUS: NoteStatus = { characters: 0, selectedCharacters: 0, editedAt: null }

interface SelectionSource {
  /** The pane holding the editor; only a selection inside its editor counts. */
  readonly pane: RefObject<HTMLElement | null>
  /** The editor's selection as Markdown (`NoteEditorHandle.getSelectedText`). */
  readonly getSelectedText: () => string
}

function countChars(path: string, markdown: string): number {
  return countDisplayChars(parseNote({ path, source: markdown }))
}

/**
 * Publish `path`'s live status for the status bar: the character count from
 * `initialMarkdown` once loaded, then from each editor change after typing
 * settles (stamping the edit time), and the selection's count as it changes.
 * Returns the change listener to chain onto the editor's `onChange`.
 */
export function useNoteStatusPublisher(
  path: string,
  initialMarkdown: string | null,
  selection?: SelectionSource,
): (markdown: string) => void {
  const owner = useRef(Symbol('note-status'))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pathRef = useRef(path)
  const current = useRef(EMPTY_STATUS)
  const selectionRef = useRef(selection)
  useLayoutEffect(() => {
    selectionRef.current = selection
  })

  const update = useCallback((patch: Partial<NoteStatus>) => {
    current.current = { ...current.current, ...patch }
    publishNoteStatus(pathRef.current, owner.current, current.current)
  }, [])

  useEffect(() => {
    pathRef.current = path
    const token = owner.current
    if (initialMarkdown !== null) {
      current.current = EMPTY_STATUS
      update({ characters: countChars(path, initialMarkdown) })
    }
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
      clearNoteStatus(path, token)
    }
  }, [path, initialMarkdown, update])

  const tracksSelection = selection !== undefined && initialMarkdown !== null
  useEffect(() => {
    if (!tracksSelection) {
      return
    }
    let frame = 0
    const recount = (): void => {
      frame = 0
      const source = selectionRef.current
      const domSelection = window.getSelection()
      const editor = source?.pane.current?.querySelector('[contenteditable="true"]')
      const inside =
        source !== undefined &&
        domSelection !== null &&
        !domSelection.isCollapsed &&
        editor != null &&
        editor.contains(domSelection.anchorNode)
      const selected = inside ? countChars(pathRef.current, source.getSelectedText()) : 0
      if (selected !== current.current.selectedCharacters) {
        update({ selectedCharacters: selected })
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
  }, [tracksSelection, update])

  return useCallback(
    (markdown: string) => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
      }
      timer.current = setTimeout(() => {
        timer.current = null
        update({ characters: countChars(pathRef.current, markdown), editedAt: Date.now() })
      }, RECOUNT_DELAY_MS)
    },
    [update],
  )
}
