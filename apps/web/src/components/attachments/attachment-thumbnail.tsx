import type { ReactElement } from 'react'
import { AudioLines, Cloud, FileText, Film, Image, ImageOff } from 'lucide-react'
import type { AttachmentLibraryEntry } from '@reflect/core'
import { AttachmentPreviewImage } from '@/components/attachment-preview-image.tsx'
import { attachmentThumbnail, attachmentVersionParam } from './attachment-media.ts'

interface AttachmentThumbnailProps {
  entry: AttachmentLibraryEntry
  generation: number
  /** The card's width (CSS px), for the thumbnail's render bucket. */
  width: number
  onLoadSize: (width: number, height: number) => void
  /** Every source failed to load; the tile is showing instead. */
  onError: () => void
}

interface TileContentProps {
  entry: AttachmentLibraryEntry
  failed: boolean
}

/** The tile's glyph and caption for a file without a thumbnail. */
function TileContent({ entry, failed }: TileContentProps): ReactElement {
  const extension = entry.path.slice(entry.path.lastIndexOf('.') + 1).toUpperCase()
  const Icon = entry.placeholder
    ? Cloud
    : failed
      ? ImageOff
      : { image: Image, pdf: FileText, video: Film, audio: AudioLines }[entry.type]
  return (
    <span className="flex size-full flex-col items-center justify-center gap-1.5 text-text-muted">
      <Icon aria-hidden strokeWidth={1.5} className="size-6" />
      <span className="text-2xs font-medium tracking-wide">
        {entry.placeholder ? 'In iCloud' : extension}
      </span>
    </span>
  )
}

/**
 * A card's preview: a raster image or a PDF's first page (see
 * `AttachmentPreviewImage`), or a typed tile for everything else. Each loaded
 * image reports its natural size so the flow can lay the card out at the
 * media's own shape.
 */
export function AttachmentThumbnail({
  entry,
  generation,
  width,
  onLoadSize,
  onError,
}: AttachmentThumbnailProps): ReactElement {
  const thumbnail = attachmentThumbnail(entry)
  if (thumbnail === 'tile') {
    return <TileContent entry={entry} failed={false} />
  }
  const version = attachmentVersionParam(entry)
  return (
    <AttachmentPreviewImage
      generation={generation}
      path={entry.path}
      kind={thumbnail === 'pdf-page' ? 'pdf' : 'image'}
      width={width}
      version={version}
      fallback={<TileContent entry={entry} failed />}
      onLoadSize={onLoadSize}
      onError={onError}
    />
  )
}
