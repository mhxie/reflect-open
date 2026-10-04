import type { DisplacedFile } from '@reflect/core'

/**
 * The warning a pull shows when it moved this device's files aside instead
 * of overwriting them. It names every copy: from now on the copy is an
 * ordinary file, backed up and synced like any other, while the original
 * path holds the other device's version.
 */
export function displacedNotesMessage(displaced: readonly DisplacedFile[]): string {
  const [only] = displaced
  if (displaced.length === 1 && only !== undefined) {
    return only.differentNote
      ? `Another device created a different note at “${only.from}”, so this device’s note is now “${only.to}”.`
      : `Another device also changed “${only.from}”, so this device’s version is now “${only.to}”.`
  }
  const copies = displaced.map((file) => `“${file.to}”`).join(', ')
  return `Other devices also changed ${displaced.length} files, so this device’s versions are now ${copies}.`
}
