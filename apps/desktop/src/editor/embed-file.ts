import { isImageFile } from '@meowdown/core'
import { isPdfAttachmentPath } from '@reflect/core'

/**
 * Which pasted or dropped files a note embeds as `![](src)` rather than links:
 * images, and PDFs, which render as inline page-by-page previews.
 */
export function shouldEmbedFile(file: { name: string; type?: string }): boolean {
  return isImageFile(file) || file.type === 'application/pdf' || isPdfAttachmentPath(file.name)
}
