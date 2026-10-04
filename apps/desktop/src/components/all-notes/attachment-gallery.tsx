import type { ReactElement } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileText } from 'lucide-react'
import {
  displayNoteTitle,
  listAttachmentPreviews,
  pdfPageWidthBucket,
  type NoteListEntry,
  type PreviewableAttachmentType,
} from '@reflect/core'
import { attachmentUrl, pdfPageUrl } from '@/editor/use-note-attachments.ts'
import { useBridgeReady } from '@/hooks/use-bridge-ready.ts'
import { formatRecencyLabel } from '@/lib/dates.ts'
import { queryKeys } from '@/lib/query-client.ts'
import type { ListSelection } from '@/lib/selection/use-list-selection.ts'
import { cn } from '@/lib/utils.ts'
import type { ModClickEvent } from '@/lib/windows/open-in-new-window.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { LocalOnlyMark } from '@/components/local-only-mark.tsx'

interface AttachmentGalleryProps {
  type: PreviewableAttachmentType
  notes: readonly NoteListEntry[]
  selection: ListSelection
  onOpen: (path: string, event?: ModClickEvent) => void
}

/** Card thumbnails are at most this wide (CSS px), so PDFs render at a small bucket. */
const CARD_WIDTH = 220

/**
 * All Notes filtered to images or PDFs, as a gallery after Arc's Library: each
 * note a card showing its first such attachment (a PDF's first page). Cards
 * follow the list's conventions — click selects, ⌘/Shift extend the
 * selection, a double-click or the title opens the note.
 */
export function AttachmentGallery({
  type,
  notes,
  selection,
  onOpen,
}: AttachmentGalleryProps): ReactElement {
  const { graph } = useGraph()
  const { settings } = useSettings()
  const bridgeReady = useBridgeReady()
  const { data: previews } = useQuery({
    queryKey: queryKeys.index.attachmentPreviews(graph?.root, type),
    queryFn: () => listAttachmentPreviews(type),
    enabled: bridgeReady && graph !== null,
  })
  const generation = graph?.generation ?? null
  const thumbnail = (assetPath: string): string | null =>
    generation === null
      ? null
      : type === 'pdf'
        ? pdfPageUrl(
            generation,
            assetPath,
            1,
            pdfPageWidthBucket(CARD_WIDTH * window.devicePixelRatio),
          )
        : attachmentUrl(generation, assetPath)

  return (
    <ul
      aria-label={type === 'pdf' ? 'Notes with PDFs' : 'Notes with images'}
      className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-4 py-5 pr-7 pl-12"
    >
      {notes.map((note) => {
        const assetPath = previews?.get(note.path)
        const src = assetPath === undefined ? null : thumbnail(assetPath)
        const title = displayNoteTitle(note.title) || 'Untitled'
        const selected = selection.isSelected(note.path)
        return (
          <li
            key={note.path}
            onClick={(event) => {
              if (event.shiftKey) {
                event.preventDefault()
              }
              selection.clickSelect(note.path, event)
            }}
            onDoubleClick={(event) => onOpen(note.path, event)}
            className={cn(
              'group/card flex cursor-default flex-col overflow-hidden rounded-lg border bg-surface select-none',
              selected
                ? 'border-accent ring-1 ring-accent/40'
                : 'border-border hover:border-text-muted/40',
            )}
          >
            <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-surface-sunken">
              {src === null ? (
                <FileText aria-hidden strokeWidth={1.5} className="size-6 text-text-muted" />
              ) : (
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  className={cn(
                    'size-full transition-transform duration-200 group-hover/card:scale-[1.02]',
                    type === 'pdf' ? 'object-cover object-top' : 'object-cover',
                  )}
                />
              )}
            </div>
            <div className="flex flex-col gap-0.5 px-2.5 py-2">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation()
                  onOpen(note.path, event)
                }}
                className="truncate text-left text-xs font-medium text-text hover:underline"
              >
                <LocalOnlyMark path={note.path} className="mr-1" />
                {title}
              </button>
              <span className="text-2xs text-text-muted">
                {note.mtime > 0 ? formatRecencyLabel(note.mtime, settings) : '—'}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
