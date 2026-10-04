import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactElement,
} from 'react'
import { flushSync } from 'react-dom'
import type { AttachmentLibraryEntry } from '@reflect/core'
import { AttachmentCard } from './attachment-card.tsx'
import {
  attachmentPreviewRatio,
  CARD_FOOTER_HEIGHT,
  type AttachmentPreviewAction,
} from './attachment-media.ts'
import { focusAttachmentCard } from './focus-attachment-card.ts'
import {
  layoutMasonry,
  masonryNeighbor,
  masonryVisible,
  type MasonryDirection,
} from './masonry-layout.ts'
import { useFlowViewport } from './use-flow-viewport.ts'
import { useMediaRatios } from './use-media-ratios.ts'

/** Columns are added while each stays at least this wide (CSS px). */
const MIN_COLUMN_WIDTH = 200
/** Space between columns and between stacked cards (CSS px). */
const GAP = 16

interface AttachmentFlowProps {
  entries: readonly AttachmentLibraryEntry[]
  /** The flow's content width (CSS px); nothing renders until it is measured. */
  width: number
  /** The scroll container the flow virtualizes against. */
  scrollElement: HTMLElement | null
  /** Keys the remembered media sizes (see `attachment-ratio-cache`). */
  graphRoot: string | null
  generation: number
  onActivate: (
    entry: AttachmentLibraryEntry,
    action: AttachmentPreviewAction,
    element: HTMLElement,
  ) => void
  onOpenNote: (path: string, event: MouseEvent) => void
}

/**
 * The Attachments card flow: cards at their media's own shape in balanced
 * columns (see `layoutMasonry`), in reading order in the DOM. A card is laid
 * out at a remembered or default shape until its thumbnail reports its size.
 *
 * Virtualized: every card is positioned, but only those within a screen of
 * the viewport mount — plus the focused card, so keyboard focus survives
 * scrolling it out of view.
 */
export function AttachmentFlow({
  entries,
  width,
  scrollElement,
  graphRoot,
  generation,
  onActivate,
  onOpenNote,
}: AttachmentFlowProps): ReactElement | null {
  const { ratioOf, report } = useMediaRatios(graphRoot)
  // State, not a ref, so the viewport hook re-runs once the list attaches.
  const [listElement, setListElement] = useState<HTMLUListElement | null>(null)
  const viewport = useFlowViewport(scrollElement, listElement)
  // The card that last held focus stays mounted, even scrolled away and after
  // focus leaves the flow (a preview it opened hands focus back to it on
  // close). By path, not position: a new file sorts in ahead of it.
  const [focusedPath, setFocusedPath] = useState<string | null>(null)

  const layout = useMemo(
    () =>
      layoutMasonry(
        entries.length,
        (index, columnWidth) => {
          const entry = entries[index]
          const ratio = entry === undefined ? 0 : attachmentPreviewRatio(entry, ratioOf(entry))
          return Math.round(columnWidth * ratio) + CARD_FOOTER_HEIGHT
        },
        { width, minColumnWidth: MIN_COLUMN_WIDTH, gap: GAP },
      ),
    [entries, width, ratioOf],
  )
  // Read by the navigation callback, so it stays stable across relayouts and
  // the memoized cards skip re-rendering when only other cards moved.
  const latest = useRef({ layout, entries })
  useLayoutEffect(() => {
    latest.current = { layout, entries }
  }, [layout, entries])

  const mounted = useMemo(() => {
    if (viewport === null) {
      return []
    }
    const overscan = viewport.bottom - viewport.top
    const visible = masonryVisible(
      layout.positions,
      viewport.top - overscan,
      viewport.bottom + overscan,
    )
    const focusedIndex =
      focusedPath === null ? -1 : entries.findIndex((entry) => entry.path === focusedPath)
    if (focusedIndex !== -1 && !visible.includes(focusedIndex)) {
      visible.push(focusedIndex)
      visible.sort((left, right) => left - right)
    }
    return visible
  }, [layout, viewport, focusedPath, entries])

  const handleNavigate = useCallback(
    (index: number, direction: MasonryDirection) => {
      const next = masonryNeighbor(latest.current.layout.positions, index, direction)
      const target = next === null ? undefined : latest.current.entries[next]
      if (next === null || target === undefined) {
        return
      }
      // Mount the target synchronously (it may sit past the overscan), then focus it.
      flushSync(() => setFocusedPath(target.path))
      focusAttachmentCard(listElement, next)
    },
    [listElement],
  )

  if (width <= 0) {
    return null
  }
  return (
    <ul
      ref={setListElement}
      aria-label="Attachments"
      className="relative"
      style={{ height: layout.height }}
    >
      {mounted.map((index) => {
        const entry = entries[index]
        const position = layout.positions[index]
        return entry === undefined || position === undefined ? null : (
          <AttachmentCard
            key={entry.path}
            entry={entry}
            index={index}
            left={position.left}
            top={position.top}
            width={position.width}
            height={position.height}
            generation={generation}
            onActivate={onActivate}
            onOpenNote={onOpenNote}
            onMediaSize={report}
            onNavigate={handleNavigate}
            onFocusPath={setFocusedPath}
          />
        )
      })}
    </ul>
  )
}
