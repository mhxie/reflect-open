/**
 * Scroll geometry for outline jumps and scroll-spy: plain DOM, independent of
 * the editor, so a jump works the same in any scroll container a note editor
 * is mounted in.
 */

/** Custom property sizing the extra scroll room under the content (styles/index.css). */
const TAIL_SPACE_PROPERTY = '--outline-tail-space'
/** Marker attribute that turns the tail-space `::after` on. */
const TAIL_SPACE_ATTRIBUTE = 'data-outline-tail-space'

/** The nearest ancestor of `element` that scrolls vertically, or null. */
export function verticalScrollContainer(element: Element): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return node
    }
  }
  return null
}

/** How far `element`'s top edge sits below `container`'s top edge, in px. */
export function offsetFromContainerTop(container: HTMLElement, element: Element): number {
  return element.getBoundingClientRect().top - container.getBoundingClientRect().top
}

/** Whether {@link alignToContainerTop} has grown extra scroll room under the content. */
export function hasTailSpace(container: HTMLElement): boolean {
  return container.hasAttribute(TAIL_SPACE_ATTRIBUTE)
}

/** Drop the extra scroll room {@link alignToContainerTop} added, if any. */
export function clearTailSpace(container: HTMLElement): void {
  container.removeAttribute(TAIL_SPACE_ATTRIBUTE)
  container.style.removeProperty(TAIL_SPACE_PROPERTY)
}

function setTailSpace(container: HTMLElement, space: number): void {
  container.setAttribute(TAIL_SPACE_ATTRIBUTE, '')
  container.style.setProperty(TAIL_SPACE_PROPERTY, `${space}px`)
}

/**
 * Scroll `container` so `element`'s top sits `margin` px below the container
 * top, growing a blank tail (until {@link clearTailSpace}) when the content
 * after it is too short.
 *
 * The tail is sized from a probe: a tail at least a viewport taller than the
 * target always overflows, so the scroll height it yields is the content's
 * own extent plus the probe — exact even for content shorter than the
 * viewport, where a tail first fills the viewport before it adds any reach.
 */
export function alignToContainerTop(
  container: HTMLElement,
  element: Element,
  margin: number,
): void {
  const target = Math.max(
    0,
    container.scrollTop + offsetFromContainerTop(container, element) - margin,
  )
  if (container.scrollHeight - container.clientHeight < target) {
    const probe = target + container.clientHeight
    setTailSpace(container, probe)
    const contentExtent = container.scrollHeight - probe
    setTailSpace(container, Math.ceil(target + container.clientHeight - contentExtent))
  }
  container.scrollTop = target
}

/**
 * The last of `count` elements in document order whose top is at or above
 * `line`, or null. Tops ascend, so this binary-searches; `topAt` returning
 * null (not rendered) counts as below the line.
 */
export function lastIndexAtOrAbove(
  count: number,
  topAt: (index: number) => number | null,
  line: number,
): number | null {
  let low = 0
  let high = count - 1
  let found: number | null = null
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const top = topAt(middle)
    if (top !== null && top <= line) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found
}

/** Input that means the reader is steering again, ending a hold. */
const READER_INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/**
 * Keep `target()` aligned to `container`'s top every frame for `durationMs`,
 * so it stays put while content above it settles. Reader input or the
 * deadline ends the hold and calls `onStop`. Returns an idempotent stop.
 */
export function holdAtContainerTop(
  container: HTMLElement,
  target: () => Element | null,
  margin: number,
  durationMs: number,
  onStop: () => void,
): () => void {
  const deadline = performance.now() + durationMs
  let frame: number | null = null
  let stopped = false
  const align = (): void => {
    const element = target()
    if (element !== null) {
      alignToContainerTop(container, element, margin)
    }
  }
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    if (frame !== null) {
      cancelAnimationFrame(frame)
      frame = null
    }
    for (const type of READER_INPUT_EVENTS) {
      window.removeEventListener(type, stop, true)
    }
    onStop()
  }
  const follow = (): void => {
    if (performance.now() >= deadline) {
      stop()
      return
    }
    align()
    frame = requestAnimationFrame(follow)
  }
  for (const type of READER_INPUT_EVENTS) {
    window.addEventListener(type, stop, { capture: true, passive: true })
  }
  align()
  frame = requestAnimationFrame(follow)
  return stop
}
