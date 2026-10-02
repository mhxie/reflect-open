/**
 * The attachment types the All Notes list can be narrowed to: which file
 * extensions each one covers (a subset of the supported attachment formats in
 * `./paths.ts`), and which links count as video.
 */

/** The attachment types, in the order the filter bar shows them. */
export const NOTE_ATTACHMENT_TYPES = ['pdf', 'image', 'audio', 'video'] as const

export type NoteAttachmentType = (typeof NOTE_ATTACHMENT_TYPES)[number]

/** The attachment file extensions (lowercase) of each type. */
export const ATTACHMENT_TYPE_EXTENSIONS: Readonly<Record<NoteAttachmentType, readonly string[]>> = {
  pdf: ['pdf'],
  image: ['avif', 'bmp', 'gif', 'heic', 'jpeg', 'jpg', 'png', 'svg', 'tif', 'tiff', 'webp'],
  audio: ['flac', 'm4a', 'mp3', 'ogg', 'wav'],
  video: ['3gp', 'mkv', 'mov', 'mp4', 'ogv', 'webm'],
}

/** URL fragments that make a link a YouTube video, which counts as video. */
export const YOUTUBE_VIDEO_URL_FRAGMENTS: readonly string[] = [
  'youtube.com/watch',
  'youtube.com/shorts/',
  'youtube.com/embed/',
  'youtube.com/live/',
  'youtube-nocookie.com/embed/',
  'youtu.be/',
]
