import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** Hover intent before the edge reveals the sidebar, so a pass-through doesn't flash it. */
export const SIDEBAR_REVEAL_DELAY_MS = 100
/** Grace after the pointer leaves, so a slight overshoot doesn't dismiss it. */
export const SIDEBAR_HIDE_DELAY_MS = 300

/**
 * A menu or popover opened from inside the revealed sidebar. Its content
 * portals outside the overlay, so the pointer travelling to it must not
 * dismiss the sidebar (and the menu with it).
 */
const OPEN_TRIGGER = '[aria-expanded="true"]'

export interface SidebarHoverRevealState {
  /** Whether the sidebar is floating over the content. */
  readonly revealed: boolean
  /** Attach to the floating sidebar; the pointer inside it keeps it shown. */
  readonly overlayRef: RefObject<HTMLElement | null>
  /** Spread onto the window-edge hit strip. */
  readonly edgeHandlers: {
    readonly onPointerEnter: () => void
    readonly onPointerLeave: () => void
  }
}

/**
 * Arc's hidden-sidebar gesture: resting the pointer on the window's leading
 * edge floats the sidebar over the content, and it slides away once the
 * pointer leaves it — unless a button is held (a pinned-row drag) or one of
 * its menus is open. Escape dismisses it too.
 */
export function useSidebarHoverReveal(): SidebarHoverRevealState {
  const [revealed, setRevealed] = useState(false)
  const overlayRef = useRef<HTMLElement>(null)
  const revealTimer = useRef<number | null>(null)

  const cancelReveal = useCallback((): void => {
    if (revealTimer.current !== null) {
      window.clearTimeout(revealTimer.current)
      revealTimer.current = null
    }
  }, [])

  const onPointerEnter = useCallback((): void => {
    cancelReveal()
    revealTimer.current = window.setTimeout(() => {
      revealTimer.current = null
      setRevealed(true)
    }, SIDEBAR_REVEAL_DELAY_MS)
  }, [cancelReveal])

  useEffect(() => cancelReveal, [cancelReveal])

  useEffect(() => {
    if (!revealed) {
      return
    }
    let hideTimer: number | null = null
    const cancelHide = (): void => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer)
        hideTimer = null
      }
    }
    const holdsOpen = (): boolean => overlayRef.current?.querySelector(OPEN_TRIGGER) != null

    const onPointerMove = (event: PointerEvent): void => {
      const overlay = overlayRef.current
      const inside =
        overlay !== null && event.target instanceof Node && overlay.contains(event.target)
      if (inside || event.buttons !== 0 || holdsOpen()) {
        cancelHide()
        return
      }
      hideTimer ??= window.setTimeout(() => {
        hideTimer = null
        setRevealed(false)
      }, SIDEBAR_HIDE_DELAY_MS)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented && !holdsOpen()) {
        setRevealed(false)
      }
    }

    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('keydown', onKeyDown)
      cancelHide()
    }
  }, [revealed])

  return {
    revealed,
    overlayRef,
    edgeHandlers: { onPointerEnter, onPointerLeave: cancelReveal },
  }
}
