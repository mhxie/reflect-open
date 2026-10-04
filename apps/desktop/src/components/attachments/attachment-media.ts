import { isImageAttachmentPath, type AttachmentLibraryEntry } from '@reflect/core'

/**
 * How an Attachments card previews its file, and what activating it does.
 *
 * The card flow is a passive surface — every file in the graph renders without
 * being asked for — so thumbnails follow the hover card's boundary: raster
 * images load as thumbnails the shell decodes and re-encodes (falling back to
 * the asset protocol's `reflect-preview=raster` filter: sniffed
 * PNG/JPEG/GIF/WebP only, so SVG bytes can never load subresources) and PDFs
 * as a page the shell renders. Video and audio get a typed tile: the
 * asset protocol reads a whole file per request, with no byte ranges, so
 * a media element would pull an entire recording into memory just to draw a
 * frame. An iCloud placeholder is never read at all.
 */

/** Space under each card's preview for its filename, note link, and date (px). */
export const CARD_FOOTER_HEIGHT = 52

/** Extensions the raster preview filter can serve. */
const RASTER_THUMBNAIL_EXTENSIONS = new Set(['gif', 'jpeg', 'jpg', 'png', 'webp'])

/** A card preview's height-to-width ratio is held to this range; the media is cropped to fit. */
const MIN_RATIO = 0.4
const MAX_RATIO = 1.8

/** What a card's preview area shows. */
export type AttachmentThumbnail = 'raster' | 'pdf-page' | 'tile'

/** What activating a card does. */
export type AttachmentPreviewAction = 'lightbox' | 'peek' | 'open'

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * A preview URL parameter naming the file's version, so a file rewritten at
 * the same path gets a new URL: the webview reloads it instead of keeping the
 * old image, and the shell's caches (keyed on size and mtime) miss.
 */
export function attachmentVersionParam(entry: AttachmentLibraryEntry): string {
  return `v=${entry.modifiedMs}-${entry.size}`
}

/** The last path segment, as a card's title. */
export function attachmentFilename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** What the card's preview area renders for `entry`. */
export function attachmentThumbnail(entry: AttachmentLibraryEntry): AttachmentThumbnail {
  if (entry.placeholder) {
    return 'tile'
  }
  if (entry.type === 'pdf') {
    return 'pdf-page'
  }
  return entry.type === 'image' && RASTER_THUMBNAIL_EXTENSIONS.has(extensionOf(entry.path))
    ? 'raster'
    : 'tile'
}

/**
 * What activating the card does: images the editor renders inline open in the
 * lightbox, PDFs in Peek, and everything else — video, audio, HEIC/TIFF, an
 * iCloud placeholder — in its default app. An image whose thumbnail failed to
 * load would fail in the lightbox too, so it opens in its default app; a PDF
 * still goes to Peek, which says why a page cannot render.
 */
export function attachmentPreviewAction(
  entry: AttachmentLibraryEntry,
  thumbnailFailed = false,
): AttachmentPreviewAction {
  if (entry.placeholder) {
    return 'open'
  }
  if (entry.type === 'pdf') {
    return 'peek'
  }
  return entry.type === 'image' && isImageAttachmentPath(entry.path) && !thumbnailFailed
    ? 'lightbox'
    : 'open'
}

/**
 * The card preview's height-to-width ratio: the loaded media's own (clamped),
 * else a per-kind default — a portrait page for PDFs, 4:3 for images, and a
 * fixed tile shape for the rest.
 */
export function attachmentPreviewRatio(
  entry: AttachmentLibraryEntry,
  loadedRatio: number | undefined,
): number {
  const thumbnail = attachmentThumbnail(entry)
  if (thumbnail === 'tile') {
    return entry.type === 'audio' ? 0.45 : entry.type === 'video' ? 9 / 16 : 3 / 4
  }
  if (loadedRatio !== undefined) {
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, loadedRatio))
  }
  return thumbnail === 'pdf-page' ? 11 / 8.5 : 3 / 4
}
