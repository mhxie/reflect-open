import { AUDIO_MEMOS_DIR } from './paths.ts'

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

/** Is this graph-relative path inside an `audio-memos/` tree (at the root or nested)? */
function isAudioMemoPath(path: string): boolean {
  return path.startsWith(`${AUDIO_MEMOS_DIR}/`) || path.includes(`/${AUDIO_MEMOS_DIR}/`)
}

/**
 * The attachment type of a graph-relative file, by extension (ASCII
 * case-insensitive), or null for a file of no media type. A recording inside
 * an `audio-memos/` tree is audio whatever its container — the recorder may
 * save `.webm` — matching the All Notes audio and video filters.
 */
export function attachmentTypeOf(path: string): NoteAttachmentType | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) {
    return null
  }
  const extension = name.slice(dot + 1).toLowerCase()
  const type = NOTE_ATTACHMENT_TYPES.find((candidate) =>
    ATTACHMENT_TYPE_EXTENSIONS[candidate].includes(extension),
  )
  if (type === undefined) {
    return null
  }
  return type === 'video' && isAudioMemoPath(path) ? 'audio' : type
}
