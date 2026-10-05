import { useEffect, useRef, type ReactElement } from 'react'
import { useRouter } from '@/routing/router.tsx'
import { NotePeek } from './note-peek.tsx'
import { PdfPeek } from './pdf-peek.tsx'
import { usePeek } from './peek-provider.tsx'

/**
 * The peeked note or PDF, floating over the editor pane: a note is fully
 * editable and "Open" promotes it to the main view; a PDF reads page by page
 * and can open in its default app. Esc, the close button, or a click outside
 * closes it, and so does any navigation.
 */
export function PeekPanel(): ReactElement | null {
  const peek = usePeek()
  const { route } = useRouter()
  const closePeek = peek?.closePeek
  const firstRoute = useRef(route)

  // A navigation (including the panel's own "Open") retires the peek.
  useEffect(() => {
    if (firstRoute.current !== route) {
      closePeek?.()
    }
    firstRoute.current = route
  }, [route, closePeek])

  if (peek?.target == null) {
    return null
  }
  const { target, targetKey } = peek
  // Keyed on the peek, not the path: a renamed note keeps its live pane.
  return target.kind === 'note' ? (
    <NotePeek key={targetKey} target={target} onClose={peek.closePeek} />
  ) : (
    <PdfPeek key={targetKey} path={target.path} onClose={peek.closePeek} />
  )
}
