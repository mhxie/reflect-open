import { isImageFile } from '@meowdown/core'

/**
 * A blank note's title from the first file dropped into it: the name without
 * its extension. None for images, whose names `saveFile` replaces (`pasted-…`).
 */
export function noteTitleFromFile(file: { name: string; type?: string }): string | undefined {
  if (isImageFile(file)) {
    return undefined
  }
  const dot = file.name.lastIndexOf('.')
  const stem = (dot > 0 ? file.name.slice(0, dot) : file.name).trim()
  return stem === '' ? undefined : stem
}
