import { useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { PEEK_HEADER_BUTTON } from './peek-header-button.ts'

/** An editor menu (slash, tag, wiki-link, table) that is showing; they stay mounted closed. */
const OPEN_MENU = ':is([role="listbox"], [role="menu"])[data-state="open"]'

/** Another overlay that owns its own Esc (the palette, a confirm dialog). */
const OTHER_OVERLAY = ':is([role="dialog"], [role="alertdialog"])'

export interface PeekFrameProps {
  title: string
  /** Header buttons before Close. */
  actions: ReactNode
  onClose: () => void
  /**
   * Move focus into the frame when it opens. For content that focuses nothing
   * itself (a PDF), so keystrokes stop reaching the editor underneath.
   */
  focusOnOpen?: boolean
  children: ReactNode
}

/**
 * Whether an Esc keydown should close the peek. Inside the frame, Esc first
 * collapses an editor selection or closes an editor menu; outside it, another
 * overlay keeps its own Esc, and anything else (the editor under the peek, a
 * list card, the page body) closes the peek.
 */
function shouldCloseOnEscape(event: KeyboardEvent, frame: HTMLElement): boolean {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) {
    return false
  }
  if (document.querySelector(OPEN_MENU) !== null) {
    return false
  }
  const target = event.target
  if (target instanceof Node && frame.contains(target)) {
    const selection = window.getSelection()
    return selection === null || selection.isCollapsed
  }
  return !(target instanceof Element && target.closest(OTHER_OVERLAY) !== null)
}

/**
 * The floating card every peek shares: backdrop, header, and Esc to close —
 * wherever focus is, so a peek opened from a note's editor or a list still
 * closes on Esc instead of leaving the key to the surface underneath.
 */
export function PeekFrame({
  title,
  actions,
  onClose,
  focusOnOpen = false,
  children,
}: PeekFrameProps): ReactElement {
  const frameRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  })

  useEffect(() => {
    if (focusOnOpen) {
      frameRef.current?.focus({ preventScroll: true })
    }
  }, [focusOnOpen])

  useEffect(() => {
    // Captured at the document, ahead of the editor, whose Esc collapses a
    // selection: the frame decides first whether Esc is its own.
    function onKeyDown(event: KeyboardEvent): void {
      const frame = frameRef.current
      if (frame === null || !shouldCloseOnEscape(event, frame)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      onCloseRef.current()
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    return () => document.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  return (
    <div className="absolute inset-0 z-20 flex justify-center bg-text/10 px-10 py-8 backdrop-blur-[1px]">
      <button
        type="button"
        aria-label="Close peek"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={frameRef}
        role="dialog"
        aria-label={`Peek: ${title}`}
        tabIndex={-1}
        className="relative flex h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl outline-none"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 pr-2 pl-4">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-text-secondary">
            {title}
          </span>
          {actions}
          <button
            type="button"
            aria-label="Close"
            title="Close (Esc)"
            onClick={onClose}
            className={PEEK_HEADER_BUTTON}
          >
            <X aria-hidden className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
