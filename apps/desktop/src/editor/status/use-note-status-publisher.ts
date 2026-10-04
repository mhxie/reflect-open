import { useCallback, useEffect, useRef } from 'react'
import { countDisplayChars, parseNote } from '@reflect/core'
import { clearNoteStatus, publishNoteStatus } from './note-status-store.ts'

/** Typing settles this long before the count re-parses the buffer. */
const RECOUNT_DELAY_MS = 250

/**
 * Publish `path`'s live character count for the status corner: from
 * `initialMarkdown` once loaded, then from each editor change after typing
 * settles. Returns the change listener to chain onto the editor's `onChange`.
 */
export function useNoteStatusPublisher(
  path: string,
  initialMarkdown: string | null,
): (markdown: string) => void {
  const owner = useRef(Symbol('note-status'))
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pathRef = useRef(path)

  const publish = useCallback((markdown: string) => {
    publishNoteStatus(pathRef.current, owner.current, {
      characters: countDisplayChars(parseNote({ path: pathRef.current, source: markdown })),
    })
  }, [])

  useEffect(() => {
    pathRef.current = path
    const token = owner.current
    if (initialMarkdown !== null) {
      publish(initialMarkdown)
    }
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
      clearNoteStatus(path, token)
    }
  }, [path, initialMarkdown, publish])

  return useCallback(
    (markdown: string) => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
      }
      timer.current = setTimeout(() => {
        timer.current = null
        publish(markdown)
      }, RECOUNT_DELAY_MS)
    },
    [publish],
  )
}
