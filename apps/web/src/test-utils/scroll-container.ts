/**
 * The nearest ancestor of `element` that scrolls its overflow, found by
 * computed style so a test asserts on behavior rather than DOM shape.
 * Throws when no ancestor scrolls.
 */
export function scrollContainerOf(element: Element): HTMLElement {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return node
    }
  }
  throw new Error('No ancestor scrolls its overflow')
}
