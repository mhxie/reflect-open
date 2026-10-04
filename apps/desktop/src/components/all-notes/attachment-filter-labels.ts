import type { NoteAttachmentType } from '@reflect/core'

/** Each attachment type's filter tab label. */
export const ATTACHMENT_FILTER_LABELS: Readonly<Record<NoteAttachmentType, string>> = {
  pdf: 'PDF',
  image: 'Images',
  audio: 'Audio',
  video: 'Video',
}

/** Each attachment type as a plural noun, for "No notes with …" and settings copy. */
export const ATTACHMENT_FILTER_NOUNS: Readonly<Record<NoteAttachmentType, string>> = {
  pdf: 'PDFs',
  image: 'images',
  audio: 'audio',
  video: 'video',
}
