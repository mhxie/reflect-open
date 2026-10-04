/** The mounted card previews inside `container`, in reading order. */
function mountedCards(container: HTMLElement | null): HTMLElement[] {
  return [...(container?.querySelectorAll<HTMLElement>('[data-attachment-index]') ?? [])]
}

/** Focus the Attachments card at `index` inside `container`, scrolling it into view. */
export function focusAttachmentCard(container: HTMLElement | null, index: number): void {
  const card = mountedCards(container).find(
    (candidate) => candidate.dataset['attachmentIndex'] === String(index),
  )
  card?.focus({ preventScroll: true })
  card?.scrollIntoView({ block: 'nearest' })
}

/**
 * Focus the first card, in reading order, that the scroll container
 * `container` shows — where arrow keys enter the flow from the screen.
 */
export function focusFirstVisibleAttachmentCard(container: HTMLElement | null): void {
  if (container === null) {
    return
  }
  const view = container.getBoundingClientRect()
  const cards = mountedCards(container)
  const card =
    cards.find((candidate) => {
      const box = candidate.getBoundingClientRect()
      return box.bottom > view.top && box.top < view.bottom
    }) ?? cards[0]
  card?.focus({ preventScroll: true })
  card?.scrollIntoView({ block: 'nearest' })
}
