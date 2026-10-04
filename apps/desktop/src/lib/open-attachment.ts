import { errorMessage, openAsset, revealAsset } from '@reflect/core'
import { startOperation } from '@/lib/operations.ts'

/**
 * Open a graph-relative attachment in its default app. A refused file type
 * still deserves a visible outcome, so it falls back to revealing the file in
 * the file manager; when even the reveal fails (a missing or evicted file),
 * the original open error is reported — that is the user's intent. Never
 * rejects: every outcome surfaces on the status line.
 */
export async function openAttachment(assetPath: string, generation: number): Promise<void> {
  try {
    await openAsset(assetPath, generation)
  } catch (openCause) {
    try {
      await revealAsset(assetPath, generation)
      startOperation('Opening attachment').warn(
        'This file type can’t be opened directly, so it was revealed in Finder instead.',
      )
    } catch {
      startOperation('Opening attachment').fail(errorMessage(openCause))
    }
  }
}
