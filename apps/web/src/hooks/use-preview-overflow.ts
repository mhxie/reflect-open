import { useLayoutEffect, useState } from 'react'

/** Track a clamped preview through content loads, font changes, and resizing. */
export function usePreviewOverflow(): {
  setRoot: (root: HTMLDivElement | null) => void
  overflowing: boolean
} {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    if (root === null || typeof ResizeObserver === 'undefined') return
    const update = (): void => {
      setOverflowing(root.scrollHeight > root.clientHeight + 1)
    }
    const observer = new ResizeObserver(update)
    const observeContent = (): void => {
      observer.disconnect()
      observer.observe(root)
      for (const child of root.children) observer.observe(child)
      update()
    }
    observeContent()
    const changes = new MutationObserver(observeContent)
    changes.observe(root, { childList: true })
    return () => {
      observer.disconnect()
      changes.disconnect()
    }
  }, [root])
  return { setRoot, overflowing }
}
