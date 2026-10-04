import { useEffect, useState } from 'react'

/**
 * Whether the user is typing in an editable surface right now: true from a
 * keystroke in one until `idleMs` without another, or the mouse moves.
 * Shortcut chords (⌘, Ctrl, Alt) don't count as typing.
 */
export function useTyping(idleMs: number): boolean {
  const [typing, setTyping] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
      clearTimeout(timer)
      setTyping(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (!(target instanceof HTMLElement) || !target.isContentEditable) {
        return
      }
      setTyping(true)
      clearTimeout(timer)
      timer = setTimeout(stop, idleMs)
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    document.addEventListener('mousemove', stop)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown, { capture: true })
      document.removeEventListener('mousemove', stop)
    }
  }, [idleMs])
  return typing
}
