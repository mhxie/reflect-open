import { useEffect, useState } from 'react'

/**
 * The content width of an element, tracked with a ResizeObserver. Returns a
 * callback ref to attach and the latest width (0 until measured).
 */
export function useElementWidth(): [(element: HTMLElement | null) => void, number] {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (element === null) {
      return
    }
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry?.contentRect.width ?? 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])
  return [setElement, width]
}
