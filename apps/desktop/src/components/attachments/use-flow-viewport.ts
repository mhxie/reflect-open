import { useEffect, useState } from 'react'

/** The scroll viewport's vertical band, in the flow's own coordinates. */
export interface FlowViewport {
  readonly top: number
  readonly bottom: number
}

/**
 * Track which band of `flow` the scroll container shows: re-measured on
 * resize (before paint, so a mount or a restored scroll offset never shows
 * an empty frame) and at most once per animation frame while scrolling.
 * Null until both elements are attached and measured.
 */
export function useFlowViewport(
  scrollElement: HTMLElement | null,
  flow: HTMLElement | null,
): FlowViewport | null {
  const [viewport, setViewport] = useState<FlowViewport | null>(null)
  useEffect(() => {
    if (scrollElement === null || flow === null) {
      return
    }
    let frame: number | null = null
    const measure = (): void => {
      frame = null
      const top = scrollElement.getBoundingClientRect().top - flow.getBoundingClientRect().top
      const bottom = top + scrollElement.clientHeight
      setViewport((current) =>
        current !== null && current.top === top && current.bottom === bottom
          ? current
          : { top, bottom },
      )
    }
    const onScroll = (): void => {
      frame ??= requestAnimationFrame(measure)
    }
    // Observing reports the initial size too, which takes the first measure.
    const observer = new ResizeObserver(measure)
    observer.observe(scrollElement)
    observer.observe(flow)
    scrollElement.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      scrollElement.removeEventListener('scroll', onScroll)
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
    }
  }, [scrollElement, flow])
  return viewport
}
