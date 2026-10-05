/** The native activator needed to cancel an owned sortable sensor on teardown. */
export interface PinnedTagDragSession {
  readonly activator: HTMLElement
  readonly pointerId: number | null
}

/** Cancel the sensor before its sortable session is removed or replaced. */
export function cancelPinnedTagDrag(session: PinnedTagDragSession): void {
  const target = session.activator.isConnected ? session.activator : session.activator.ownerDocument
  const event =
    session.pointerId === null
      ? new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true,
        })
      : new PointerEvent('pointercancel', { pointerId: session.pointerId, bubbles: true })

  // dnd-kit's sensors have no public teardown method. Their native cancel
  // events detach listeners; a prevented Escape keeps the managed popup open.
  event.preventDefault()
  target.dispatchEvent(event)
}
