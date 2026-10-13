/**
 * Pull seam for background writers. While a graph syncs with a remote, the
 * backup controller registers a full sync cycle; a writer awaits it before it
 * writes what another device may have written already, so it finds that write
 * in the files instead of meeting it in a merge (the note-summary pass). With
 * no remote there is nothing to pull. Errors are swallowed: the sync status
 * reports them, and the writer goes on as it would offline.
 */

let puller: (() => Promise<void>) | null = null

/** Install (or clear, with `null`) the syncing graph's pull. */
export function setBackupPuller(next: (() => Promise<void>) | null): void {
  puller = next
}

/** Run the registered pull, if any. Never throws. */
export async function pullBackup(): Promise<void> {
  try {
    await puller?.()
  } catch {
    // Reported through the sync status; the writer carries on as offline.
  }
}
