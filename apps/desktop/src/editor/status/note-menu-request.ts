import { useSyncExternalStore } from 'react'

/** A request to open one note's status menu, numbered so a repeat counts. */
interface NoteMenuRequest {
  readonly path: string
  readonly id: number
}

let latest: NoteMenuRequest | null = null
const listeners = new Set<() => void>()

/**
 * Ask the status bar showing `path` to open its menu — from the palette's
 * "Show note details" or the editor's Private notice, which sit far from the
 * footer that owns the menu.
 */
export function requestNoteMenu(path: string): void {
  latest = { path, id: (latest?.id ?? 0) + 1 }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The id of the newest menu request for `path`, or null when none was made. */
export function useNoteMenuRequest(path: string | null): number | null {
  const read = (): number | null => (latest !== null && latest.path === path ? latest.id : null)
  return useSyncExternalStore(subscribe, read, read)
}
