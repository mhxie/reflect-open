import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
} from 'react'
import { isModEvent } from '@meowdown/core'
import { useLightbox } from '@meowdown/react'
import {
  NOTE_ATTACHMENT_TYPES,
  type AttachmentLibraryEntry,
  type NoteAttachmentType,
} from '@reflect/core'
import { ATTACHMENT_FILTER_NOUNS } from '@/components/all-notes/attachment-filter-labels.ts'
import { usePeek } from '@/components/peek/peek-provider.tsx'
import { MediaLightbox } from '@/editor/media-lightbox.tsx'
import { attachmentUrl } from '@/editor/use-note-attachments.ts'
import { useElementWidth } from '@/hooks/use-element-width.ts'
import { useNoteLinkNavigation } from '@/hooks/use-note-link-navigation.ts'
import { openAttachment } from '@/lib/open-attachment.ts'
import { useScrollRestoration } from '@/lib/use-scroll-restoration.ts'
import { useGraph } from '@/providers/graph-provider.tsx'
import { routeForPath } from '@/routing/route.ts'
import { useRouter } from '@/routing/router.tsx'
import { AttachmentFlow } from './attachment-flow.tsx'
import {
  attachmentFilename,
  attachmentVersionParam,
  type AttachmentPreviewAction,
} from './attachment-media.ts'
import { attachmentTagFacets, filterAttachments } from './attachment-filters.ts'
import { AttachmentTagFilter } from './attachment-tag-filter.tsx'
import { AttachmentTypeTabs } from './attachment-type-tabs.tsx'
import { focusFirstVisibleAttachmentCard } from './focus-attachment-card.ts'
import { useAttachmentLibrary } from './use-attachment-library.ts'

/** What an empty library (or an empty filter) says. */
function emptyMessage(type: NoteAttachmentType | null, tag: string | null): string {
  if (type === null && tag === null) {
    return 'No attachments yet. Images, PDFs, video, and audio in this graph show up here.'
  }
  const noun = type === null ? 'attachments' : ATTACHMENT_FILTER_NOUNS[type]
  return tag === null ? `No ${noun} yet.` : `No ${noun} in notes tagged #${tag}.`
}

interface AttachmentsScreenProps {
  /** The type the route narrows the library to (`null` = every media file). */
  type: NoteAttachmentType | null
  /** Only files linked from notes carrying this tag (`null` = any). */
  tag: string | null
}

/** The file a lightbox shows, pinned to the graph session it opened in. */
interface LightboxFile {
  path: string
  generation: number
}

/**
 * The Attachments screen (a routed view, beside All Notes): every image, PDF,
 * video, and audio file in the graph as a card flow, newest first, filterable
 * by type and by the tags of the notes linking to them. A card previews its file — images in the lightbox, PDFs in Peek,
 * the rest in their default app — and links to the note that uses it.
 *
 * Keyboard: the arrow keys move between cards (from the screen itself, into
 * the first card in view), Return or Space previews, and Tab walks the
 * mounted cards and their note links in reading order (the flow is
 * virtualized). Owns its scroll container, like All Notes, so the header
 * stays put; the router's per-entry scroll memory is wired by hand.
 */
export function AttachmentsScreen({ type, tag }: AttachmentsScreenProps): ReactElement {
  const { graph } = useGraph()
  const generation = graph?.generation ?? null
  const { navigate } = useRouter()
  const navigateNoteLink = useNoteLinkNavigation()
  const openPeek = usePeek()?.openPeek
  const library = useAttachmentLibrary()
  const lightbox = useLightbox()
  const openLightbox = lightbox.open
  const [lightboxFile, setLightboxFile] = useState<LightboxFile | null>(null)
  // State, not a ref, so scroll restoration re-runs once the element attaches.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [setFlowElement, flowWidth] = useElementWidth()
  const rootRef = useRef<HTMLDivElement>(null)

  const entries = useMemo(
    () => (library === undefined ? undefined : filterAttachments(library, { type, tag })),
    [library, type, tag],
  )
  // Counted within the active type, so each tag says how many files it would show.
  const tagFacets = useMemo(
    () =>
      library === undefined
        ? []
        : attachmentTagFacets(filterAttachments(library, { type, tag: null })),
    [library, type],
  )
  // A tab per type the graph has, plus the active one even when it has none.
  const types = useMemo(
    () =>
      NOTE_ATTACHMENT_TYPES.filter(
        (candidate) =>
          candidate === type || (library?.some((entry) => entry.type === candidate) ?? false),
      ),
    [library, type],
  )

  const ready = entries !== undefined && (entries.length === 0 || flowWidth > 0)
  const { onScroll } = useScrollRestoration(scrollElement, ready)

  // Move focus into the surface on mount so the arrow keys work at once.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  const openNote = useCallback(
    (path: string, event: MouseEvent) =>
      navigateNoteLink({ target: routeForPath(path), openInNewWindow: isModEvent(event) }),
    [navigateNoteLink],
  )
  const activate = useCallback(
    (entry: AttachmentLibraryEntry, action: AttachmentPreviewAction, element: HTMLElement) => {
      if (generation === null) {
        return
      }
      if (action === 'lightbox') {
        setLightboxFile({ path: entry.path, generation })
        openLightbox(
          {
            type: 'image',
            src: `${attachmentUrl(generation, entry.path)}?${attachmentVersionParam(entry)}`,
            alt: attachmentFilename(entry.path),
          },
          element,
        )
      } else if (action === 'peek' && openPeek !== undefined) {
        openPeek({ kind: 'pdf', path: entry.path })
      } else {
        void openAttachment(entry.path, generation)
      }
    },
    [generation, openLightbox, openPeek],
  )
  const handleRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const modified = event.metaKey || event.ctrlKey || event.altKey
    if (event.target === event.currentTarget && event.key.startsWith('Arrow') && !modified) {
      event.preventDefault()
      focusFirstVisibleAttachmentCard(scrollElement)
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      aria-label="Attachments"
      onKeyDown={handleRootKeyDown}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <header className="flex flex-none flex-wrap items-center justify-between gap-3 border-b border-border py-4 pr-7 pl-12">
        <div className="flex items-baseline gap-2">
          <h1 className="text-[15px] font-semibold text-text">Attachments</h1>
          {entries !== undefined && entries.length > 0 ? (
            <span
              data-testid="attachments-count"
              className="text-[13px] text-text-muted tabular-nums"
            >
              {entries.length}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <AttachmentTypeTabs
            type={type}
            types={types}
            onSelect={(next) => navigate({ kind: 'attachments', type: next, tag })}
          />
          <AttachmentTagFilter
            tag={tag}
            facets={tagFacets}
            onSelect={(next) => navigate({ kind: 'attachments', type, tag: next })}
          />
        </div>
      </header>
      <div
        ref={setScrollElement}
        data-testid="attachments-scroll"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto"
      >
        <div ref={setFlowElement} className="py-5 pr-7 pl-12">
          {entries === undefined || generation === null ? null : entries.length === 0 ? (
            <p className="py-3 text-sm text-text-muted">{emptyMessage(type, tag)}</p>
          ) : (
            <AttachmentFlow
              entries={entries}
              width={flowWidth}
              scrollElement={scrollElement}
              graphRoot={graph?.root ?? null}
              generation={generation}
              onActivate={activate}
              onOpenNote={openNote}
            />
          )}
        </div>
      </div>

      <MediaLightbox
        lightbox={lightbox}
        onOpenImage={
          lightboxFile === null
            ? null
            : () => void openAttachment(lightboxFile.path, lightboxFile.generation)
        }
      />
    </div>
  )
}
