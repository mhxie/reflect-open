import { isImageFile } from '@meowdown/core'
import { isPdfAttachmentPath } from '@reflect/core'

/**
 * Which pasted or dropped files a note embeds as `![](src)` rather than links:
 * images, and files named `.pdf`, which render as inline page-by-page
 * previews (a PDF's preview is keyed on its name, never its MIME type).
 */
export function shouldEmbedFile(file: { name: string; type?: string }): boolean {
  return isImageFile(file) || isPdfAttachmentPath(file.name)
}
