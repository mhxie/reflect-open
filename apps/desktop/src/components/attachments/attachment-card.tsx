import { memo, useState, type KeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import type { AttachmentLibraryEntry } from '@reflect/core'
import { AttachmentCardFooter } from './attachment-card-footer.tsx'
import {
  attachmentFilename,
  attachmentPreviewAction,
  attachmentVersionParam,
  CARD_FOOTER_HEIGHT,
  type AttachmentPreviewAction,
} from './attachment-media.ts'
import { AttachmentThumbnail } from './attachment-thumbnail.tsx'
import type { MasonryDirection } from './masonry-layout.ts'

interface AttachmentCardProps {
  entry: AttachmentLibraryEntry
  /** The card's place in reading order, for arrow-key navigation. */
  index: number
  /** The card's box in the flow (CSS px), from the masonry layout. */
  left: number
  top: number
  width: number
  height: number
  generation: number
  /** Preview the file; `element` is the thumbnail the lightbox zooms out of. */
  onActivate: (
    entry: AttachmentLibraryEntry,
    action: AttachmentPreviewAction,
    element: HTMLElement,
  ) => void
  onOpenNote: (path: string, event: MouseEvent) => void
  onMediaSize: (entry: AttachmentLibraryEntry, width: number, height: number) => void
  onNavigate: (index: number, direction: MasonryDirection) => void
  /** Focus entered the card (its preview or a footer link); receives the file's path. */
  onFocusPath: (path: string) => void
}

const ARROW_DIRECTIONS: Readonly<Record<string, MasonryDirection>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

/**
 * One card in the Attachments flow, absolutely placed by the masonry layout:
 * the preview is a button (click, Return, or Space previews the file; the
 * arrow keys move between cards), with the caption below. Memoized on
 * primitive geometry, so a relayout re-renders only the cards that moved.
 */
export const AttachmentCard = memo(function AttachmentCard({
  entry,
  index,
  left,
  top,
  width,
  height,
  generation,
  onActivate,
  onOpenNote,
  onMediaSize,
  onNavigate,
  onFocusPath,
}: AttachmentCardProps): ReactElement {
  // Remembered per file version, so a rewritten file gets a fresh try while
  // the card — and keyboard focus on it — stays mounted.
  const version = attachmentVersionParam(entry)
  const [failedVersion, setFailedVersion] = useState<string | null>(null)
  const filename = attachmentFilename(entry.path)
  const action = attachmentPreviewAction(entry, failedVersion === version)

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const direction = ARROW_DIRECTIONS[event.key]
    if (direction === undefined || event.metaKey || event.ctrlKey || event.altKey) {
      return
    }
    event.preventDefault()
    onNavigate(index, direction)
  }

  return (
    <li
      className="group/card absolute top-0 left-0 flex flex-col overflow-hidden rounded-lg border border-border bg-surface hover:border-text-muted/40 focus-within:border-accent"
      style={{ transform: `translate(${left}px, ${top}px)`, width, height }}
      // React's focus event bubbles, so a footer link counts as well as the preview.
      onFocus={() => onFocusPath(entry.path)}
    >
      <button
        type="button"
        data-attachment-index={index}
        aria-label={`${action === 'open' ? 'Open' : 'Preview'} ${filename}`}
        onClick={(event) =>
          onActivate(entry, action, event.currentTarget.querySelector('img') ?? event.currentTarget)
        }
        onKeyDown={handleKeyDown}
        className="relative block w-full flex-none cursor-default overflow-hidden bg-surface-sunken outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
        style={{ height: Math.max(0, height - CARD_FOOTER_HEIGHT) }}
      >
        <AttachmentThumbnail
          entry={entry}
          generation={generation}
          width={width}
          onLoadSize={(naturalWidth, naturalHeight) =>
            onMediaSize(entry, naturalWidth, naturalHeight)
          }
          onError={() => setFailedVersion(version)}
        />
      </button>
      <AttachmentCardFooter entry={entry} onOpenNote={onOpenNote} />
    </li>
  )
})
